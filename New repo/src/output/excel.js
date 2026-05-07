// Excel report writer. Drives column ordering off the union of every
// adapter's `toExcelRow` output so adding a new brand never requires editing
// this file.
import XLSX from 'xlsx';
import { join, basename } from 'node:path';
import { config } from '../configs/index.js';
import { safeWrite } from '../libraries/io/json-store.js';
import { logger } from '../libraries/log/logger.js';

const COLUMN_ORDER = [
  'Brand',
  'Model',
  'Series / Range',
  'Variant Code',
  'Vehicle Price (gross)',
  'Vehicle Price (net)',
  'Monthly (net)',
  'Monthly (gross)',
  'Down Payment (net)',
  'Down Payment (gross)',
  'Down Payment %',
  'Term (months)',
  'Annual km',
  'Interest %',
  'Residual Value (net)',
  'Residual Value %',
  'Total Cost (net)',
  'FR Product',
  'URL',
];

function buildSheet(rows) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: COLUMN_ORDER });
  ws['!cols'] = COLUMN_ORDER.map((h) => {
    const max = Math.max(h.length, ...rows.map((r) => String(r[h] ?? '').length));
    return { wch: Math.min(max + 2, 50) };
  });
  return ws;
}

export function writeExcelReport({ adapters, offersByBrand, outPath }) {
  const wb = XLSX.utils.book_new();
  for (const adapter of adapters) {
    const offers = offersByBrand[adapter.id] || [];
    if (!offers.length) continue;
    const rows = offers
      .map((o) => adapter.toExcelRow(o))
      .sort((a, b) => String(a.Model || '').localeCompare(String(b.Model || '')));
    XLSX.utils.book_append_sheet(wb, buildSheet(rows), adapter.displayName);
  }

  const target = outPath || join(config.paths.reportsDir, 'financial-renting.xlsx');
  const result = safeWrite(target, (p) => XLSX.writeFile(wb, p));
  if (result.fellBack) {
    logger.warn(
      { original: basename(result.originalPath), fallback: basename(result.path) },
      'output file was locked — wrote timestamped sibling instead',
    );
  }
  return result.path;
}
