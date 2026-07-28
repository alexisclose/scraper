// `build-excel` command — reads data/raw/{brand}.json files and writes a
// consolidated workbook to data/reports/financial-renting.xlsx.
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { config } from '../configs/index.js';
import { logger } from '../libraries/log/logger.js';
import { writeExcelReport } from '../output/excel.js';
import { recalcForDownPayment } from '../domains/vw/recalc.js';
import bmw from '../domains/bmw/index.js';
import mercedes from '../domains/mercedes/index.js';
import tesla from '../domains/tesla/index.js';
import vw from '../domains/vw/index.js';
import audi from '../domains/audi/index.js';

const ADAPTERS = [bmw, mercedes, tesla, vw, audi];

// Down-payment fraction the second VW sheet normalises every promotion offer to.
const VW_RECALC_DOWN_PCT = 0.2;

// A second VW sheet: the same promotion offers, but with the monthly recomputed
// for a flat 20% down payment (holding each deal's own implied rate, term,
// residual and mileage fixed). Not a real adapter — just a sheet definition that
// reuses the VW row mapper and a derived dataset.
const vwRecalcSheet = {
  id: 'vw-recalc',
  displayName: `Volkswagen (${Math.round(VW_RECALC_DOWN_PCT * 100)}% down)`,
  toExcelRow: vw.toExcelRow,
};

export const buildExcelCommand = {
  command: 'build-excel',
  describe: 'Build the consolidated XLSX report from data/raw/ snapshots',
  builder: (yargs) =>
    yargs.option('out', {
      type: 'string',
      describe: 'Output xlsx path',
    }),
  handler: (argv) => {
    const offersByBrand = {};
    for (const a of ADAPTERS) {
      const path = join(config.paths.rawDir, `${a.id}.json`);
      if (existsSync(path)) {
        offersByBrand[a.id] = JSON.parse(readFileSync(path, 'utf8'));
      } else {
        offersByBrand[a.id] = [];
        logger.warn({ brand: a.id, path }, 'no snapshot found, skipping sheet');
      }
    }
    // Derive the recalculated VW sheet from the promotion offers, and slot it in
    // right after the promotions sheet so the two VW sheets sit together.
    offersByBrand[vwRecalcSheet.id] = (offersByBrand.vw || []).map((o) =>
      recalcForDownPayment(o, VW_RECALC_DOWN_PCT),
    );
    const sheetAdapters = ADAPTERS.flatMap((a) => (a.id === 'vw' ? [a, vwRecalcSheet] : [a]));

    const out = argv.out || join(config.paths.reportsDir, 'financial-renting.xlsx');
    const written = writeExcelReport({ adapters: sheetAdapters, offersByBrand, outPath: out });
    const counts = Object.fromEntries(
      sheetAdapters.map((a) => [a.id, (offersByBrand[a.id] || []).length]),
    );
    logger.info({ path: written, counts }, 'workbook written');
  },
};
