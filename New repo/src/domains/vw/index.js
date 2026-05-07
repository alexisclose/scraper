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
  return results.filter(Boolean);
}

const adapter = {
  id: 'vw',
  displayName: brandConfig.displayName,
  run,
  toExcelRow: defaultToExcelRow,
};

export default adapter;
