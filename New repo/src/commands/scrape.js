// `scrape` command — runs one or all brand adapters, validates output via the
// LeaseOffer schema, and writes the latest snapshot to data/raw/<brand>.json.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { config } from '../configs/index.js';
import { writeJson } from '../libraries/io/json-store.js';
import { brandLogger, logger } from '../libraries/log/logger.js';
import { AppError } from '../libraries/error-handling/AppError.js';
import bmw from '../domains/bmw/index.js';
import mercedes from '../domains/mercedes/index.js';
import tesla from '../domains/tesla/index.js';
import vw from '../domains/vw/index.js';
import audi from '../domains/audi/index.js';

const ADAPTERS = { bmw, mercedes, tesla, vw, audi };

// All-brand layout: STRICTLY SEQUENTIAL.
//
// This used to be two concurrent lanes — Audi (the long pole) against everything
// else. That overlapped Audi's pool of three detached spawn-cdp Chromes with
// BMW's patchright Chromium, and the combination was unstable: Audi recycling or
// OS-killing a lane mid-flight raised CDP errors that surfaced as unhandled
// rejections and took the whole run down (`Network.setCacheDisabled: Internal
// server error, session closed`) — killing BMW's in-progress sweep with it, even
// though BMW itself was healthy.
//
// Audi goes LAST so the cheap, reliable brands have already produced and
// persisted their snapshots before the heaviest browser workload starts. Running
// serially costs wall-clock, not offers.
const SEQUENTIAL_BRANDS = ['bmw', 'mercedes', 'tesla', 'vw', 'audi'];

// A brand can break WITHOUT throwing: when a site renames an endpoint or retires
// a model code, every input fails its own way, the adapter returns [] and the run
// still exits 0 while writing an empty snapshot. That is exactly how BMW sat at 0
// offers unnoticed. So compare each result against the previous snapshot and shout
// when a brand collapses. Advisory only — one brand's regression must not abort
// the others (that isolation is the point of runBrand).
const COLLAPSE_RATIO = 0.5; // flag a drop to less than half of the last run

function checkForCollapse(id, offers, path, log) {
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // no comparable snapshot (first run) — nothing to compare against
  }
  if (!Array.isArray(previous) || previous.length === 0) return null;
  if (offers.length === 0) {
    log.error(
      { brand: id, was: previous.length, now: 0 },
      `${id} returned 0 offers but previously had ${previous.length} — the site likely changed (renamed endpoint / retired model codes). NOT a healthy run.`,
    );
    return 'ZERO';
  }
  if (offers.length < previous.length * COLLAPSE_RATIO) {
    log.warn(
      { brand: id, was: previous.length, now: offers.length },
      `${id} dropped from ${previous.length} to ${offers.length} offers — investigate before trusting this snapshot.`,
    );
    return 'DROP';
  }
  return null;
}

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
    // Compare BEFORE writing — the previous snapshot is the baseline.
    const collapse = checkForCollapse(id, offers, path, log);
    writeJson(path, offers);
    log.info(
      { count: offers.length, ms: Date.now() - t0, path, collapse },
      `${adapter.displayName} done`,
    );
    // A brand that went to zero is a failure even though nothing threw.
    return collapse === 'ZERO' ? 1 : 0;
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
        choices: ['bmw', 'mercedes', 'tesla', 'vw', 'audi', 'all'],
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
      exitCodes = [];
      for (const id of SEQUENTIAL_BRANDS) {
        // runBrand never throws, but keep the loop bulletproof: one brand must
        // never prevent the remaining brands from running.
        exitCodes.push(
          await runBrand(id, { runId, outDir }).catch((err) => {
            logger.error({ brand: id, err }, 'brand runner threw — continuing with the next brand');
            return 1;
          }),
        );
      }
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
