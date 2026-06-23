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
import vwFinance from '../domains/vw-finance/index.js';
import audi from '../domains/audi/index.js';

const ADAPTERS = { bmw, mercedes, tesla, vw, 'vw-finance': vwFinance, audi };

// All-brand layout. Audi dominates wall-clock, so it gets its own lane and
// everything else runs concurrently in a second, fully serial lane. Keeping
// lane B serial means its browser brands (BMW, Tesla, and the configurator-
// driven vw-finance) never stack their Chromes on top of each other, and the
// heavy ones are throttled below their solo cap so peak Chrome while Audi runs
// stays modest. The plain `vw` adapter is pure HTTP (cheap). vw-finance runs
// last in lane B, so it mostly overlaps Audi's tail.
const LANE_A = ['audi'];
const LANE_B = ['bmw', 'tesla', 'mercedes', 'vw', 'vw-finance'];
// Browser concurrency for lane B's heavy brands while they overlap Audi's pool,
// so peak Chrome stays modest: Audi(3) + BMW(2) = 5 in the BMW window, and
// Audi(3) + vw-finance(2) = 5 in the vw-finance window (it runs last, overlapping
// Audi's tail).
const LANE_B_BMW_CONCURRENCY = 2;
const LANE_B_VW_FINANCE_CONCURRENCY = 2;

// Per-brand run-option overrides used only in the two-lane (all-brand) layout.
const TWO_LANE_OPTS = {
  bmw: { browserConcurrency: LANE_B_BMW_CONCURRENCY },
  'vw-finance': { browserConcurrency: LANE_B_VW_FINANCE_CONCURRENCY },
};

// Scrape one brand, persist its snapshot, and return an exit code (0/1). Never
// throws — every brand is isolated so one failure can't sink the others.
async function runBrand(id, { runId, outDir, opts = {} }) {
  const adapter = ADAPTERS[id];
  const log = brandLogger(id);
  log.info({ runId }, `${adapter.displayName} scrape start`);
  const t0 = Date.now();
  try {
    const offers = await adapter.run({ logger: log, runId, ...opts });
    const path = join(outDir, `${id}.json`);
    writeJson(path, offers);
    log.info({ count: offers.length, ms: Date.now() - t0, path }, `${adapter.displayName} done`);
    return 0;
  } catch (err) {
    if (err instanceof AppError) {
      log.warn({ code: err.code, msg: err.message, ctx: err.context }, 'brand failed');
    } else {
      log.error({ err }, 'unhandled error');
    }
    return 1;
  }
}

export const scrapeCommand = {
  command: 'scrape',
  describe: 'Scrape one or all brands and persist the offers to data/raw/',
  builder: (yargs) =>
    yargs
      .option('brand', {
        type: 'string',
        describe: 'Brand to scrape',
        choices: ['bmw', 'mercedes', 'tesla', 'vw', 'vw-finance', 'audi', 'all'],
        default: 'all',
      })
      .option('out', {
        type: 'string',
        describe: 'Override output dir for the result snapshots',
      }),
  handler: async (argv) => {
    const runId = new Date().toISOString();
    const outDir = argv.out || config.paths.rawDir;

    let exitCodes;
    if (argv.brand === 'all') {
      // Lane A (Audi, the long pole) and lane B (everything else, serial) run
      // concurrently. allSettled so a thrown lane can't mask the other; runBrand
      // already swallows per-brand failures into exit codes.
      const laneA = (async () => {
        const codes = [];
        for (const id of LANE_A) codes.push(await runBrand(id, { runId, outDir }));
        return codes;
      })();
      const laneB = (async () => {
        const codes = [];
        for (const id of LANE_B) {
          codes.push(await runBrand(id, { runId, outDir, opts: TWO_LANE_OPTS[id] }));
        }
        return codes;
      })();
      const settled = await Promise.allSettled([laneA, laneB]);
      exitCodes = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [1]));
    } else {
      exitCodes = [await runBrand(argv.brand, { runId, outDir })];
    }

    const code = exitCodes.some((c) => c !== 0) ? 1 : 0;
    if (code !== 0) {
      logger.error({ exitCodes }, 'one or more brands failed');
    }
    process.exit(code);
  },
};
