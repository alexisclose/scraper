// `scrape` command — runs one or all brand adapters, validates output via the
// LeaseOffer schema, and writes the latest snapshot to data/raw/<brand>.json.
import { join } from 'node:path';
import { config } from '../configs/index.js';
import { writeJson } from '../libraries/io/json-store.js';
import { brandLogger, logger } from '../libraries/log/logger.js';
import { AppError } from '../libraries/error-handling/AppError.js';
import bmw from '../domains/bmw/index.js';
import mercedes from '../domains/mercedes/index.js';
import tesla from '../domains/tesla/index.js';
import vw from '../domains/vw/index.js';

const ADAPTERS = { bmw, mercedes, tesla, vw };

export const scrapeCommand = {
  command: 'scrape',
  describe: 'Scrape one or all brands and persist the offers to data/raw/',
  builder: (yargs) =>
    yargs
      .option('brand', {
        type: 'string',
        describe: 'Brand to scrape',
        choices: ['bmw', 'mercedes', 'tesla', 'vw', 'all'],
        default: 'all',
      })
      .option('out', {
        type: 'string',
        describe: 'Override output dir for the result snapshots',
      }),
  handler: async (argv) => {
    const runId = new Date().toISOString();
    const brandIds = argv.brand === 'all' ? Object.keys(ADAPTERS) : [argv.brand];
    const outDir = argv.out || config.paths.rawDir;
    const exitCodes = [];

    for (const id of brandIds) {
      const adapter = ADAPTERS[id];
      const log = brandLogger(id);
      log.info({ runId }, `${adapter.displayName} scrape start`);
      const t0 = Date.now();
      try {
        const offers = await adapter.run({ logger: log, runId });
        const path = join(outDir, `${id}.json`);
        writeJson(path, offers);
        log.info(
          { count: offers.length, ms: Date.now() - t0, path },
          `${adapter.displayName} done`,
        );
        exitCodes.push(0);
      } catch (err) {
        if (err instanceof AppError) {
          log.warn({ code: err.code, msg: err.message, ctx: err.context }, 'brand failed');
        } else {
          log.error({ err }, 'unhandled error');
        }
        exitCodes.push(1);
      }
    }

    const code = exitCodes.some((c) => c !== 0) ? 1 : 0;
    if (code !== 0) {
      logger.error({ exitCodes }, 'one or more brands failed');
    }
    process.exit(code);
  },
};
