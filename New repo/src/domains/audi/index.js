// Audi (Belgium) brand adapter.
//
// Audi's finance offers live on the D'Ieteren CCF form
// (formsccf.audi.be/ccf/nl/finance/formulastep?code=<code>), reachable two ways
// (see fetcher.js): a direct-HTTP fast path for already-minted codes, and a
// browser path that drives the www.audi.be configurator to mint fresh codes.
//
// Inputs come from ./data/candidate-codes.json:
//   • `codes`  → tried over plain HTTP (proxy-aware); expired codes 302 to the
//                branded Oops page and are skipped with a logged reason.
//   • `models` → each carries a configurator `pr` URL the browser drives to mint
//                a fresh code, immune to expiry.
//
// The adapter never silently returns 0: every skipped input is logged with an
// explicit reason, and a summary lists them at the end.
import pLimit from 'p-limit';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, brandConfigs } from '../../configs/index.js';
import { writeJson } from '../../libraries/io/json-store.js';
import { launchBrowser } from '../../libraries/browser/launch.js';
import { validateOffer } from '../../libraries/schema/lease-offer.js';
import { AppError } from '../../libraries/error-handling/AppError.js';
import { defaultToExcelRow } from '../shared/brand-adapter.js';
import { fetchByCode, mintFromConfigurator } from './fetcher.js';
import { parseAudiOffer } from './parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const brandConfig = brandConfigs.audi;

const CANDIDATES = JSON.parse(
  readFileSync(join(__dirname, 'data', 'candidate-codes.json'), 'utf8'),
);
const CANDIDATE_CODES = CANDIDATES.codes || [];
const CANDIDATE_MODELS = CANDIDATES.models || [];

// Turn a fetched finance-form result into a validated offer, or null + a logged
// reason. Shared by both the HTTP and browser paths.
function buildOfferOrSkip({ html, finalUrl, code, model, runId, logger, financeApi, boundMeanings }) {
  const label = code || model?.id || '(unknown)';
  try {
    const offer = parseAudiOffer({
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
    logger.warn({ input: label, finalUrl, reason }, 'Audi parse/validation failed');
    return null;
  }
}

async function run({ logger, runId }) {
  logger.info(
    { codes: CANDIDATE_CODES.length, models: CANDIDATE_MODELS.length },
    'Audi candidate inputs loaded',
  );

  const offers = [];
  const skipped = [];
  const lastReason = new Map(); // model id → last failure reason (for the summary)
  // model id → a price-only offer (vehicle price parsed, but the form never fired
  // a finance Calculate so monthly is null). Held back so the model still counts
  // as a straggler and the zero-contention cleanup pass can retry for a real
  // monthly; only flushed into `offers` at the end if every retry stayed null.
  const fallbackOffers = new Map();

  // ---- Path 1: direct HTTP for already-minted codes (proxy-aware) ----
  if (CANDIDATE_CODES.length) {
    const limit = pLimit(config.http.concurrency);
    const results = await Promise.all(
      CANDIDATE_CODES.map(({ code }) =>
        limit(async () => {
          try {
            const { finalUrl, status, redirectedToOops, html } = await fetchByCode(
              code,
              brandConfig,
            );
            logger.info({ code, status, finalUrl, redirectedToOops }, 'Audi code fetched (HTTP)');
            if (redirectedToOops) {
              logger.warn(
                { input: code, finalUrl, reason: 'AUDI_OOPS' },
                'Audi code expired/invalid (redirected to Base/Oops) — skipped',
              );
              skipped.push({ input: code, reason: 'AUDI_OOPS' });
              return null;
            }
            const codeOffer = buildOfferOrSkip({ html, finalUrl, code, runId, logger });
            if (!codeOffer) skipped.push({ input: code, reason: 'AUDI_PARSE_FAILED' });
            return codeOffer;
          } catch (err) {
            const reason = err instanceof AppError ? err.code : err.message;
            logger.warn({ input: code, reason }, 'Audi code fetch failed — page not reachable');
            skipped.push({ input: code, reason });
            return null;
          }
        }),
      ),
    );
    offers.push(...results.filter(Boolean));
  }

  // ---- Path 2: browser drives the configurator to mint fresh codes ----
  if (CANDIDATE_MODELS.length) {
    // Models are scraped by a POOL of browsers running in parallel. The spawn-cdp
    // Chrome is detached and accumulates memory (it tends to crash after a few
    // heavy configurator pages), so each worker owns its own browser, recycles it
    // every few models, and every (re)launch uses a FRESH cdp port + ephemeral
    // profile — so a dead/zombie instance can never block the next one. Ephemeral
    // profiles re-show the cookie wall, which the fetcher now dismisses.
    const CONCURRENCY = Math.max(1, Math.min(config.audi.concurrency, CANDIDATE_MODELS.length));
    const RESTART_EVERY = 4;
    const basePort = config.tesla.cdpPort + 10;

    // Process one model. Returns the offer (or null) and a `browserDead` flag so
    // the caller can relaunch + retry when the shared browser/context crashes
    // mid-run (a real risk across a long, many-model sweep).
    const scrapeModel = async (context, model) => {
      const { finalUrl, code, redirectedToOops, html, financeApi, boundMeanings, recaptchaBlocked } =
        await mintFromConfigurator(context, model, {
          logger,
          downPaymentPct: brandConfig.defaults?.firstPaymentPct ?? 0,
        });
      if (redirectedToOops) {
        logger.warn({ input: model.id, finalUrl, reason: 'AUDI_OOPS' }, 'Audi configurator landed on Oops');
        return null;
      }
      if (financeApi?.length) {
        const dump = join(config.paths.dataDir, 'cache', 'audi', `finance-api-${code || model.id}.json`);
        // Redact the single-use reCAPTCHA token before persisting.
        const redacted = financeApi.map((r) =>
          r.requestBody && typeof r.requestBody === 'object' && 'Token' in r.requestBody
            ? { ...r, requestBody: { ...r.requestBody, Token: '[redacted]' } }
            : r,
        );
        writeJson(dump, redacted);
        logger.info({ input: model.id, responses: financeApi.length }, 'Audi FinanceApi JSON captured');
      } else {
        logger.warn(
          { input: model.id, recaptchaBlocked },
          recaptchaBlocked
            ? 'Audi FinanceApi blocked by reCAPTCHA — monthly unavailable, vehicle price only'
            : 'Audi FinanceApi returned no JSON — monthly unavailable, vehicle price only',
        );
      }
      return buildOfferOrSkip({ html, finalUrl, code, model, runId, logger, financeApi, boundMeanings });
    };

    // A browser "lane": owns one Chrome (fresh port + ephemeral profile per
    // launch so a dead/zombie instance can never block the next) and recycles it
    // every few models. Used by both the parallel pool and the serial cleanup.
    const createLane = (laneId) => {
      let seq = 0;
      let handle = null;
      let sinceRestart = 0;
      const launch = () =>
        launchBrowser({
          strategy: config.audi.headful ? 'patchright' : 'spawn-cdp',
          port: basePort + laneId * 60 + (seq % 50),
          profileDir: join(config.paths.browserProfilesDir, `audi-w${laneId}-${seq}`),
          startUrl: CANDIDATE_MODELS[0]?.configuratorUrl || brandConfig.endpoints.home,
        });
      const close = async () => {
        await handle?.cleanup().catch(() => {});
        await handle?.context?.browser()?.close().catch(() => {});
        handle = null;
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
          if (offer && offer.financialRenting.monthlyNet != null) {
            offers.push(offer);
            succeeded.add(model.id);
            return true;
          }
          if (offer) {
            // Vehicle price parsed but no finance calculation (the bound
            // down-payment control never rendered → no Calculate fired). Keep it
            // as a fallback but DON'T mark succeeded, so the cleanup pass retries
            // for a real monthly under zero contention.
            fallbackOffers.set(model.id, offer);
            lastReason.set(model.id, 'AUDI_NO_FINANCE_CALC');
          } else {
            lastReason.set(model.id, 'AUDI_OOPS_OR_PARSE'); // null = Oops / parse fail
          }
        } catch (err) {
          const reason = err.message || 'AUDI_CONFIGURATOR_FAILED';
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
            'Audi model attempt failed — retrying',
          );
        }
      }
      return false;
    };

    logger.info(
      { models: CANDIDATE_MODELS.length, concurrency: CONCURRENCY },
      'Audi scraping models via configurator (parallel)',
    );

    // ---- Parallel pool: each lane pulls from a shared queue ----
    let nextIndex = 0;
    const worker = async (laneId) => {
      const lane = createLane(laneId);
      try {
        for (;;) {
          const i = nextIndex;
          nextIndex += 1;
          if (i >= CANDIDATE_MODELS.length) break;
          // One retry under contention; the serial cleanup pass does the rest.
          await runModel(lane, CANDIDATE_MODELS[i], 2);
        }
      } finally {
        await lane.close();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));

    // ---- Serial cleanup pass: retry stragglers under ZERO contention, where
    // the configurator renders fastest and the flaky steps almost always pass.
    const stragglers = CANDIDATE_MODELS.filter((m) => !succeeded.has(m.id));
    if (stragglers.length) {
      logger.info(
        { stragglers: stragglers.map((m) => m.id) },
        'Audi cleanup pass for models that did not complete in parallel',
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

    // Authoritative failure list (after cleanup) for the summary. For models that
    // never produced a monthly, fall back to the price-only record (better than
    // dropping the car entirely) and flag the partial in the summary.
    for (const m of CANDIDATE_MODELS) {
      if (succeeded.has(m.id)) continue;
      const fallback = fallbackOffers.get(m.id);
      if (fallback) {
        offers.push(fallback);
        skipped.push({ input: m.id, reason: 'AUDI_NO_FINANCE_CALC (vehicle price only)' });
      } else {
        skipped.push({ input: m.id, reason: lastReason.get(m.id) || 'unknown' });
      }
    }
  }

  // A pre-known code can resolve to the same car as a configurator model (the
  // example AB8YS3VH is the same A3 Sportback the a3 model mints). Dedupe on the
  // identifying content so the report carries each car once. Keep the record
  // with the richer model name (longer string) when keys collide.
  const byKey = new Map();
  // Key on the CAR identity (leading range token + net price) so the same car
  // collapses to one row — e.g. the example code AB8YS3VH (direct HTTP, price
  // only, no JS → no monthly) and the a3 configurator model (full calculation)
  // are the same A3. On a collision keep the richer record: a real monthly wins,
  // then the longer model name.
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
      logger.debug({ key, kept: keep.slug, dropped: drop.slug }, 'Audi duplicate offer merged');
      byKey.set(key, keep);
    }
  }
  const unique = [...byKey.values()];

  // Never silently return 0 — spell out exactly what happened.
  logger.info(
    { scraped: offers.length, unique: unique.length, skipped: skipped.length, reasons: skipped },
    'Audi scrape summary',
  );
  if (unique.length === 0) {
    logger.warn(
      { reasons: skipped },
      'Audi produced 0 offers — see per-input reasons above (expired/invalid code / site unavailable / no finance block / no data / validation)',
    );
  }

  return unique;
}

const adapter = {
  id: 'audi',
  displayName: brandConfig.displayName,
  run,
  toExcelRow: defaultToExcelRow,
};

export default adapter;
