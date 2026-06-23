// Volkswagen (Belgium) brand adapter — CONFIGURATOR-driven.
//
// VW's finance offers are minted from the configurator, exactly like Audi: a
// browser opens each "best deals" trim's configurator summary, clicks "Bereken
// mijn maandprijs" to mint a fresh D'Ieteren CCF code (formsccf.volkswagen.be),
// selects the BUSINESS "Financiële Renting" product, sets the down payment, and
// reads the form's recomputed monthly. The trim list + each trim's default
// modelId are discovered at runtime (see fetcher.js).
//
// The adapter never silently returns 0: every skipped input is logged with an
// explicit reason, and a summary lists them at the end.
import { join } from 'node:path';
import { config, brandConfigs } from '../../configs/index.js';
import { writeJson } from '../../libraries/io/json-store.js';
import { launchBrowser, killChromeByProfileDir } from '../../libraries/browser/launch.js';
import { validateOffer } from '../../libraries/schema/lease-offer.js';
import { AppError } from '../../libraries/error-handling/AppError.js';
import { defaultToExcelRow } from '../shared/brand-adapter.js';
import { discoverConfiguratorModels, mintFromConfigurator } from './fetcher.js';
import { parseVwOffer } from './parser.js';

const brandConfig = brandConfigs['vw-finance'];

// Turn a fetched finance-form result into a validated offer, or null + a logged
// reason.
function buildOfferOrSkip({
  html,
  finalUrl,
  code,
  model,
  runId,
  logger,
  financeApi,
  boundMeanings,
}) {
  const label = code || model?.id || '(unknown)';
  try {
    const offer = parseVwOffer({
      html,
      url: finalUrl,
      code,
      model,
      brandConfig,
      scrapedAt: runId,
      logger,
      financeApi,
      boundMeanings,
    });
    return validateOffer(offer);
  } catch (err) {
    const reason = err instanceof AppError ? err.code : err.message;
    logger.warn({ input: label, finalUrl, reason }, 'VW parse/validation failed');
    return null;
  }
}

async function run({ logger, runId, browserConcurrency }) {
  const models = await discoverConfiguratorModels({ logger });
  logger.info({ models: models.length }, 'VW configurator models loaded');

  const offers = [];
  const skipped = [];
  const lastReason = new Map(); // model id → last failure reason (for the summary)

  if (!models.length) {
    logger.warn('VW discovered 0 configurator models — nothing to scrape');
    return [];
  }

  // Models are scraped by a POOL of browsers running in parallel. The spawn-cdp
  // Chrome is detached and accumulates memory, so each worker owns its own
  // browser, recycles it every few models, and every (re)launch uses a FRESH cdp
  // port + ephemeral profile — so a dead/zombie instance can never block the
  // next. Ephemeral profiles re-show the cookie wall, which the fetcher dismisses.
  // `browserConcurrency` lets the all-brand two-lane runner throttle VW further
  // while Audi's browser pool runs alongside in the other lane (see scrape.js).
  const cap = browserConcurrency ?? config.vw.concurrency;
  const CONCURRENCY = Math.max(1, Math.min(cap, models.length));
  const RESTART_EVERY = 4;
  // Distinct port band from Audi's (cdpPort+10..) so VW and Audi can run
  // concurrently (lanes A/B) without colliding on a debugging port.
  const basePort = config.tesla.cdpPort + 400;

  const scrapeModel = async (context, model) => {
    const { finalUrl, code, redirectedToOops, html, financeApi, boundMeanings, recaptchaBlocked } =
      await mintFromConfigurator(context, model, {
        logger,
        downPaymentPct: brandConfig.defaults?.firstPaymentPct ?? 0,
      });
    if (redirectedToOops) {
      logger.warn(
        { input: model.id, finalUrl, reason: 'VW_OOPS' },
        'VW configurator landed on Oops',
      );
      return null;
    }
    if (financeApi?.length) {
      const dump = join(
        config.paths.dataDir,
        'cache',
        'vw-finance',
        `finance-api-${code || model.id}.json`,
      );
      // Redact the single-use reCAPTCHA token before persisting.
      const redacted = financeApi.map((r) =>
        r.requestBody && typeof r.requestBody === 'object' && 'Token' in r.requestBody
          ? { ...r, requestBody: { ...r.requestBody, Token: '[redacted]' } }
          : r,
      );
      writeJson(dump, redacted);
      logger.info({ input: model.id, responses: financeApi.length }, 'VW FinanceApi JSON captured');
    } else {
      logger.warn(
        { input: model.id, recaptchaBlocked },
        recaptchaBlocked
          ? 'VW FinanceApi blocked by reCAPTCHA — monthly unavailable, vehicle price only'
          : 'VW FinanceApi returned no JSON — monthly unavailable, vehicle price only',
      );
    }
    return buildOfferOrSkip({
      html,
      finalUrl,
      code,
      model,
      runId,
      logger,
      financeApi,
      boundMeanings,
    });
  };

  // A browser "lane": owns one Chrome (fresh port + ephemeral profile per launch)
  // and recycles it every few models. Used by both the pool and the cleanup pass.
  const createLane = (laneId) => {
    let seq = 0;
    let handle = null;
    let sinceRestart = 0;
    let currentProfileDir = null;
    const launch = () => {
      currentProfileDir = join(config.paths.browserProfilesDir, `vwf-w${laneId}-${seq}`);
      return launchBrowser({
        strategy: config.vw.headful ? 'patchright' : 'spawn-cdp',
        port: basePort + laneId * 60 + (seq % 50),
        profileDir: currentProfileDir,
        startUrl: models[0]?.configuratorUrl || brandConfig.endpoints.home,
      });
    };
    const close = async () => {
      await handle?.cleanup().catch(() => {});
      await handle?.context
        ?.browser()
        ?.close()
        .catch(() => {});
      handle = null;
      // browser().close() only disconnects CDP; the detached spawn-cdp Chrome
      // keeps running. Kill it for real so a 45-model sweep with recycles doesn't
      // pile up zombie Chromes and exhaust memory. (patchright closes its own.)
      if (!config.vw.headful) await killChromeByProfileDir(currentProfileDir);
    };
    const relaunch = async () => {
      await close();
      seq += 1;
      handle = await launch().catch(() => null);
      sinceRestart = 0;
      return handle;
    };
    return {
      async ready() {
        if (!handle) handle = await launch().catch(() => null);
        if (handle && sinceRestart >= RESTART_EVERY) await relaunch();
        return handle;
      },
      get context() {
        return handle?.context;
      },
      noteDone() {
        sinceRestart += 1;
      },
      relaunch,
      close,
    };
  };

  const succeeded = new Set();

  // Run one model on a lane with up to `maxAttempts`, recycling on crash.
  // Returns true on success. Records the failure reason for the summary.
  const runModel = async (lane, model, maxAttempts) => {
    if (!(await lane.ready())) {
      lastReason.set(model.id, 'BROWSER_LAUNCH_FAILED');
      return false;
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const offer = await scrapeModel(lane.context, model);
        lane.noteDone();
        if (offer) {
          // A parsed offer IS the success case — even price-only. VW's monthly is
          // reCAPTCHA-gated and effectively never returns for automation, so
          // retrying a price-only result (as the Audi flow does, where the gate
          // occasionally lifts) would just multiply browser work for a monthly
          // that won't come. We keep the vehicle price + model and move on; only
          // a genuine no-offer/crash is retried.
          offers.push(offer);
          succeeded.add(model.id);
          if (offer.financialRenting.monthlyNet == null) {
            lastReason.set(model.id, 'VW_PRICE_ONLY (monthly reCAPTCHA-gated)');
          }
          return true;
        }
        lastReason.set(model.id, 'VW_OOPS_OR_PARSE'); // null = Oops / parse fail
      } catch (err) {
        const reason = err.message || 'VW_CONFIGURATOR_FAILED';
        lastReason.set(model.id, reason);
        if (/closed|crash|disconnect|Target (?:page|closed)|browser has been/i.test(reason)) {
          if (!(await lane.relaunch())) {
            lastReason.set(model.id, 'BROWSER_RELAUNCH_FAILED');
            return false;
          }
        }
      }
      if (attempt < maxAttempts) {
        logger.warn(
          { input: model.id, reason: lastReason.get(model.id), attempt },
          'VW model attempt failed — retrying',
        );
      }
    }
    return false;
  };

  logger.info(
    { models: models.length, concurrency: CONCURRENCY },
    'VW scraping models via configurator (parallel)',
  );

  // ---- Parallel pool: each lane pulls from a shared queue ----
  let nextIndex = 0;
  const worker = async (laneId) => {
    const lane = createLane(laneId);
    try {
      for (;;) {
        const i = nextIndex;
        nextIndex += 1;
        if (i >= models.length) break;
        await runModel(lane, models[i], 2);
      }
    } finally {
      await lane.close();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));

  // ---- Serial cleanup pass: retry stragglers under ZERO contention. ----
  const stragglers = models.filter((m) => !succeeded.has(m.id));
  if (stragglers.length) {
    logger.info(
      { stragglers: stragglers.map((m) => m.id) },
      'VW cleanup pass for models that did not complete in parallel',
    );
    const lane = createLane(CONCURRENCY); // its own port band
    try {
      for (const model of stragglers) {
        await runModel(lane, model, 3);
      }
    } finally {
      await lane.close();
    }
  }

  // Authoritative failure list (after cleanup): the only models missing now are
  // those that never produced any offer at all (Oops / parse fail / crash).
  for (const m of models) {
    if (succeeded.has(m.id)) continue;
    skipped.push({ input: m.id, reason: lastReason.get(m.id) || 'unknown' });
  }

  // Several trims can resolve to the same car (e.g. two business packs on one
  // engine). Dedupe on the car identity (leading range token + net price) so the
  // report carries each car once; on a collision keep the richer record (a real
  // monthly wins, then the longer model name).
  const byKey = new Map();
  const rangeToken = (r) => (r || '').toLowerCase().match(/[a-z]+\d*/)?.[0] || '';
  const richness = (o) =>
    (o.financialRenting.monthlyNet != null ? 1000 : 0) + (o.modelName || '').length;
  for (const offer of offers) {
    const f = offer.financialRenting;
    const key = `${rangeToken(offer.modelRange)}|${f.vehiclePriceNet}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, offer);
    } else {
      const keep = richness(offer) > richness(existing) ? offer : existing;
      const drop = keep === offer ? existing : offer;
      logger.debug({ key, kept: keep.slug, dropped: drop.slug }, 'VW duplicate offer merged');
      byKey.set(key, keep);
    }
  }
  const unique = [...byKey.values()];

  logger.info(
    { scraped: offers.length, unique: unique.length, skipped: skipped.length, reasons: skipped },
    'VW scrape summary',
  );
  if (unique.length === 0) {
    logger.warn(
      { reasons: skipped },
      'VW produced 0 offers — see per-input reasons above (site unavailable / no formsccf / no finance block / no data / validation)',
    );
  }

  return unique;
}

const adapter = {
  id: 'vw-finance',
  displayName: brandConfig.displayName,
  run,
  toExcelRow: defaultToExcelRow,
};

export default adapter;
