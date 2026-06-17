// Tesla brand adapter — orchestrates the four-phase Akamai-aware scrape across
// EVERY Belgian Tesla model, not just Model 3.
//
// Models come from ./data/candidate-models.json (a maintained candidate list —
// Tesla's pricebook API is Akamai-blocked so we can't enumerate models live).
// For each model we navigate to its /design page, reset any persisted
// configurator state, then run the same Phase A–C flow. Every offer is tagged
// with its model identity so trims/prices can never bleed between models.
/* global document, localStorage, sessionStorage */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, brandConfigs } from '../../configs/index.js';
import { launchBrowser } from '../../libraries/browser/launch.js';
import { validateOffer } from '../../libraries/schema/lease-offer.js';
import { BrowserError } from '../../libraries/error-handling/AppError.js';
import { defaultToExcelRow } from '../shared/brand-adapter.js';
import {
  readCashPrices,
  selectBusinessFinancialRenting,
  readMonthliesByTrim,
  selectTrimAndReadPanel,
  dumpTrimCards,
} from './browser-actions.js';
import { buildOffer } from './parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const brandConfig = brandConfigs.tesla;
const labels = brandConfig.labels || {};

const CANDIDATE_MODELS = JSON.parse(
  readFileSync(join(__dirname, 'data', 'candidate-models.json'), 'utf8'),
);

// Open a clean page for a given model. Tesla persists the chosen trim AND the
// payment-type selection in localStorage/sessionStorage, so without clearing it
// a previous model's "Zakelijk · Renting" state (or trim) leaks into the next
// one. We deliberately do NOT clear cookies — that would re-trigger Akamai.
async function openModelPage(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* storage may be unavailable pre-consent; ignore */
    }
  });
  // Reload so the configurator boots from its default "Privé: Contant" state.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page
    .waitForFunction(() => /€\s*[\d.]{3,}/.test(document.body.innerText), { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(4000);
  return page;
}

// Scrape a single model end-to-end. Throws on a model-level failure so the
// caller can record the reason and move on to the next model.
async function scrapeModel(context, model, { logger, runId }) {
  const log = logger.child ? logger.child({ model: model.id }) : logger;
  log.info({ model: model.id, url: model.url }, 'scraping model');

  const page = await openModelPage(context, model.url);
  try {
    // Debug: surface every trim-like card so a maintainer can see what the page
    // actually offers vs. what our patterns match.
    const cards = await dumpTrimCards(page).catch(() => []);
    log.info({ model: model.id, trimCards: cards }, 'trim cards on page');

    log.info({ model: model.id }, 'Phase A: reading cash prices');
    const cashByTrim = await readCashPrices(page, model.trims);
    log.info({ model: model.id, cashByTrim }, 'cash prices');

    if (Object.keys(cashByTrim).length === 0) {
      throw new BrowserError(`No Tesla trims found for ${model.displayName}`, {
        code: 'TESLA_NO_TRIMS',
        context: { model: model.id, url: model.url },
      });
    }

    log.info({ model: model.id }, 'Phase B: switching payment type to Zakelijk → Financiële Renting');
    const dropdown = await selectBusinessFinancialRenting(page, labels.businessRentingOption);
    log.info({ model: model.id, dropdown }, 'dropdown switched');

    log.info({ model: model.id }, 'Phase C: reading per-trim monthlies');
    const monthlyByTrim = await readMonthliesByTrim(page, model.trims, labels.monthlySuffix);
    log.info({ model: model.id, monthlyByTrim }, 'monthlies');

    const offers = [];
    for (const trim of model.trims) {
      const trimKey = trim.key;
      if (cashByTrim[trimKey] == null) {
        log.warn({ model: model.id, trim: trimKey }, 'trim skipped: no cash price on page');
        continue;
      }
      log.info({ model: model.id, trim: trimKey }, 'reading panel');
      const panel = await selectTrimAndReadPanel(page, trim.re, labels);
      log.info({ model: model.id, trim: trimKey, panel }, 'finance panel values');

      const offer = buildOffer({
        brandConfig,
        model,
        trimKey,
        cashGross: cashByTrim[trimKey],
        monthlyNetRaw: monthlyByTrim[trimKey],
        panelReading: panel,
        url: model.url,
        scrapedAt: runId,
      });
      offers.push(validateOffer(offer));
    }

    if (offers.length === 0) {
      throw new BrowserError(`No valid offers built for ${model.displayName}`, {
        code: 'TESLA_NO_OFFERS',
        context: { model: model.id, url: model.url },
      });
    }
    log.info({ model: model.id, count: offers.length }, 'model done');
    return offers;
  } finally {
    await page.close().catch(() => {});
  }
}

async function run({ logger, runId }) {
  const profileDir = join(config.paths.browserProfilesDir, 'tesla');
  const { context, cleanup } = await launchBrowser({
    strategy: 'spawn-cdp',
    port: config.tesla.cdpPort,
    profileDir,
    startUrl: CANDIDATE_MODELS[0]?.url ?? brandConfig.endpoints.model3Design,
  });

  logger.info(
    { candidateModels: CANDIDATE_MODELS.length, models: CANDIDATE_MODELS.map((m) => m.id) },
    'Tesla candidate models (from static list; no cache)',
  );

  const allOffers = [];
  const failures = [];

  try {
    for (const model of CANDIDATE_MODELS) {
      try {
        const offers = await scrapeModel(context, model, { logger, runId });
        allOffers.push(...offers);
      } catch (err) {
        // expectAvailable:false models (e.g. Cybertruck not yet sold in BE) are
        // expected to fail — log at info/skip rather than error.
        const level = model.expectAvailable ? 'warn' : 'info';
        logger[level](
          { model: model.id, url: model.url, reason: err.code || err.message },
          model.expectAvailable ? 'model failed, continuing' : 'model skipped (not expected in BE)',
        );
        failures.push({ model: model.id, reason: err.code || err.message });
      }
    }
  } finally {
    await cleanup();
  }

  logger.info(
    { total: allOffers.length, scraped: allOffers.length, failures },
    'Tesla scrape summary',
  );

  // Only treat the run as a hard failure if EVERY model failed (a real,
  // critical problem — Akamai block, Chrome dead, etc.). Partial success is OK.
  if (allOffers.length === 0) {
    throw new BrowserError('Tesla: all candidate models failed to scrape', {
      code: 'TESLA_ALL_MODELS_FAILED',
      context: { failures },
    });
  }

  return allOffers;
}

const adapter = {
  id: 'tesla',
  displayName: brandConfig.displayName,
  run,
  toExcelRow: defaultToExcelRow,
};

export default adapter;
