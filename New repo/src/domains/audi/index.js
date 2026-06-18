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
function buildOfferOrSkip({ html, finalUrl, code, model, runId, logger, skipped, financeApi }) {
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
    });
    return validateOffer(offer);
  } catch (err) {
    const reason = err instanceof AppError ? err.code : err.message;
    logger.warn({ input: label, finalUrl, reason }, 'Audi input skipped');
    skipped.push({ input: label, reason });
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
            return buildOfferOrSkip({ html, finalUrl, code, runId, logger, skipped });
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
    let browserHandle = null;
    try {
      browserHandle = await launchBrowser({
        strategy: config.audi.headful ? 'patchright' : 'spawn-cdp',
        profileDir: join(config.paths.browserProfilesDir, 'audi'),
        startUrl: CANDIDATE_MODELS[0]?.configuratorUrl || brandConfig.endpoints.home,
      });
    } catch (err) {
      logger.warn(
        { reason: err.code || err.message, models: CANDIDATE_MODELS.length },
        'Audi browser launch failed — skipping configurator path',
      );
      CANDIDATE_MODELS.forEach((m) =>
        skipped.push({ input: m.id, reason: err.code || 'BROWSER_LAUNCH_FAILED' }),
      );
    }

    if (browserHandle) {
      const { context, cleanup } = browserHandle;
      try {
        for (const model of CANDIDATE_MODELS) {
          try {
            const { finalUrl, code, redirectedToOops, html, financeApi, recaptchaBlocked } =
              await mintFromConfigurator(context, model, { logger });
            if (redirectedToOops) {
              logger.warn(
                { input: model.id, finalUrl, reason: 'AUDI_OOPS' },
                'Audi configurator landed on Oops — skipped',
              );
              skipped.push({ input: model.id, reason: 'AUDI_OOPS' });
              continue;
            }
            // Persist the raw FinanceApi JSON (the calibration artifact) so the
            // exact monthly/term/residual keys can be pinned after an un-gated
            // run. If the calc was reCAPTCHA-blocked, say so loudly — that's the
            // expected reason the monthly is missing.
            if (financeApi?.length) {
              const dump = join(config.paths.dataDir, 'cache', 'audi', `finance-api-${code || model.id}.json`);
              writeJson(dump, financeApi);
              logger.info({ input: model.id, responses: financeApi.length, dump }, 'Audi FinanceApi JSON captured');
            } else {
              logger.warn(
                { input: model.id, recaptchaBlocked },
                recaptchaBlocked
                  ? 'Audi FinanceApi blocked by reCAPTCHA — monthly unavailable, vehicle price only'
                  : 'Audi FinanceApi returned no JSON — monthly unavailable, vehicle price only',
              );
            }
            const offer = buildOfferOrSkip({
              html,
              finalUrl,
              code,
              model,
              runId,
              logger,
              skipped,
              financeApi,
            });
            if (offer) offers.push(offer);
          } catch (err) {
            const reason = err.message || 'AUDI_CONFIGURATOR_FAILED';
            logger.warn({ input: model.id, reason }, 'Audi configurator path failed');
            skipped.push({ input: model.id, reason });
          }
        }
      } finally {
        await cleanup().catch(() => {});
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
