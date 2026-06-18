// `build-excel` command — reads data/raw/{brand}.json files and writes a
// consolidated workbook to data/reports/financial-renting.xlsx.
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { config } from '../configs/index.js';
import { logger } from '../libraries/log/logger.js';
import { writeExcelReport } from '../output/excel.js';
import bmw from '../domains/bmw/index.js';
import mercedes from '../domains/mercedes/index.js';
import tesla from '../domains/tesla/index.js';
import vw from '../domains/vw/index.js';
import audi from '../domains/audi/index.js';

const ADAPTERS = [bmw, mercedes, tesla, vw, audi];

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
    const out = argv.out || join(config.paths.reportsDir, 'financial-renting.xlsx');
    const written = writeExcelReport({ adapters: ADAPTERS, offersByBrand, outPath: out });
    const counts = Object.fromEntries(
      ADAPTERS.map((a) => [a.id, (offersByBrand[a.id] || []).length]),
    );
    logger.info({ path: written, counts }, 'workbook written');
  },
};
