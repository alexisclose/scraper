// Volkswagen brand adapter — pure HTTP, no headless browser.
import pLimit from 'p-limit';
import { brandConfigs, config } from '../../configs/index.js';
import { validateOffer } from '../../libraries/schema/lease-offer.js';
import { defaultToExcelRow } from '../shared/brand-adapter.js';
import { discoverModelUrls, downloadModelHtml } from './fetcher.js';
import { parseVwOffer } from './parser.js';

const brandConfig = brandConfigs.vw;

async function run({ logger, runId }) {
  const urls = await discoverModelUrls(brandConfig, { logger });
  logger.info({ models: urls.length }, 'VW models discovered');

  const limit = pLimit(config.http.concurrency);
  const tasks = urls.map(({ slug, url }) =>
    limit(async () => {
      try {
        const html = await downloadModelHtml(url);
        const offer = parseVwOffer({ html, url, slug, brandConfig, scrapedAt: runId });
        return validateOffer(offer);
      } catch (err) {
        logger.warn({ slug, err: err.message }, 'VW model parse failed');
        return null;
      }
    }),
  );
  const results = await Promise.all(tasks);
  const offers = results.filter(Boolean);

  // Some slugs are aliases for the same trim (e.g. id4-pro and
  // id4-pure-business-essential resolve to an identical offer). Dedupe on the
  // offer's identifying content so the report carries each car once.
  const seen = new Set();
  const unique = [];
  for (const offer of offers) {
    const f = offer.financialRenting;
    const key = `${offer.modelName}|${f.monthlyNet}|${f.vehiclePriceNet}|${f.termMonths}`;
    if (seen.has(key)) {
      logger.debug({ slug: offer.slug, key }, 'VW duplicate offer skipped');
      continue;
    }
    seen.add(key);
    unique.push(offer);
  }
  logger.info({ parsed: offers.length, unique: unique.length }, 'VW offers deduped');
  return unique;
}

const adapter = {
  id: 'vw',
  displayName: brandConfig.displayName,
  run,
  toExcelRow: defaultToExcelRow,
};

export default adapter;
