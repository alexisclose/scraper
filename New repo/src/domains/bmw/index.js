// BMW brand adapter — Playwright + intercepted JSON.
import pLimit from 'p-limit';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandConfigs, config } from '../../configs/index.js';
import { validateOffer } from '../../libraries/schema/lease-offer.js';
import { defaultToExcelRow } from '../shared/brand-adapter.js';
import { buildBmwOffer } from './parser.js';
import { captureCalculation, launchBmwContext } from './fetcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const brandConfig = brandConfigs.bmw;
const MODEL_URLS = JSON.parse(readFileSync(join(__dirname, 'data', 'models.json'), 'utf8'));
const MODEL_NAMES = JSON.parse(
  readFileSync(join(__dirname, 'data', 'model-names.json'), 'utf8'),
);

async function run({ logger, runId }) {
  logger.info({ models: MODEL_URLS.length }, 'BMW configurator scrape start');
  const { context, cleanup } = await launchBmwContext();
  try {
    // BMW's public site rate-limits; cap browser concurrency lower than HTTP.
    const limit = pLimit(Math.min(config.http.concurrency, 4));
    const tasks = MODEL_URLS.map((url) =>
      limit(async () => {
        try {
          const calculation = await captureCalculation(context, url, { logger });
          const offer = buildBmwOffer({
            url,
            calculation,
            brandConfig,
            modelNames: MODEL_NAMES,
            scrapedAt: runId,
          });
          return validateOffer(offer);
        } catch (err) {
          logger.warn({ url, err: err.message, code: err.code }, 'BMW model failed');
          return null;
        }
      }),
    );
    const results = await Promise.all(tasks);
    return results.filter(Boolean);
  } finally {
    await cleanup();
  }
}

const adapter = {
  id: 'bmw',
  displayName: brandConfig.displayName,
  run,
  toExcelRow: defaultToExcelRow,
};

export default adapter;
