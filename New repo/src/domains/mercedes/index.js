// Mercedes-Benz brand adapter — pure HTTP, no headless browser.
import pLimit from 'p-limit';
import { brandConfigs, config } from '../../configs/index.js';
import { validateOffer } from '../../libraries/schema/lease-offer.js';
import { defaultToExcelRow } from '../shared/brand-adapter.js';
import {
  fcisRenting,
  fetchModels,
  tryFetchTrimName,
  trimMatchesModel,
} from './fetcher.js';
import { parseMercedesCalc } from './parser.js';

const brandConfig = brandConfigs.mercedes;

async function run({ logger, runId }) {
  logger.info('fetching VMOS summary');
  const models = await fetchModels();
  logger.info({ models: models.length }, 'VMOS variants');

  const limit = pLimit(config.http.concurrency);
  const tasks = models.map((model) =>
    limit(async () => {
      try {
        const [{ calculation, actualProduct }, trimNameRaw] = await Promise.all([
          fcisRenting({ carPriceGross: model.priceGross, baumuster: model.baumuster }),
          tryFetchTrimName(model.baumuster, model.modelSeries),
        ]);
        // Sanity-check the discovered trim name; fall back to displayName
        const trim = trimNameRaw && trimMatchesModel(trimNameRaw, model) ? trimNameRaw : null;
        if (trim) model.displayName = trim;
        const offer = parseMercedesCalc({
          calculation,
          actualProduct,
          model,
          brandConfig,
          scrapedAt: runId,
        });
        return validateOffer(offer);
      } catch (err) {
        logger.warn(
          { name: model.name, baumuster: model.baumuster, err: err.message, code: err.code },
          'Mercedes model failed',
        );
        return null;
      }
    }),
  );
  const results = await Promise.all(tasks);
  // Sort back to original VMOS order
  return results
    .filter(Boolean)
    .sort(
      (a, b) =>
        models.findIndex((m) => m.baumuster === a.modelCode) -
        models.findIndex((m) => m.baumuster === b.modelCode),
    );
}

const adapter = {
  id: 'mercedes',
  displayName: brandConfig.displayName,
  run,
  toExcelRow: defaultToExcelRow,
};

export default adapter;
