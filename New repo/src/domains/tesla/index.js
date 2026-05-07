// Tesla brand adapter — orchestrates the four-phase Akamai-aware scrape.
/* global document */
import { join } from 'node:path';
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
} from './browser-actions.js';
import { buildOffer } from './parser.js';

const brandConfig = brandConfigs.tesla;

async function findOrOpenTeslaPage(context) {
  const url = brandConfig.endpoints.model3Design;
  const existing = context.pages().find((p) => /tesla\.com/i.test(p.url()));
  const page = existing ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page
    .waitForFunction(() => /€\s*[\d.]{3,}/.test(document.body.innerText), { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(4000);
  return page;
}

async function run({ logger, runId }) {
  const profileDir = join(config.paths.browserProfilesDir, 'tesla');
  const { context, cleanup } = await launchBrowser({
    strategy: 'spawn-cdp',
    port: config.tesla.cdpPort,
    profileDir,
    startUrl: brandConfig.endpoints.model3Design,
  });

  try {
    const page = await findOrOpenTeslaPage(context);

    logger.info('Phase A: reading cash prices');
    const cashByTrim = await readCashPrices(page);
    if (Object.keys(cashByTrim).length === 0) {
      throw new BrowserError('No Tesla trims found on the design page', {
        code: 'TESLA_NO_TRIMS',
      });
    }
    logger.info({ cashByTrim }, 'cash prices');

    logger.info('Phase B: switching payment type to Zakelijk → Financiële Renting');
    const dropdown = await selectBusinessFinancialRenting(page);
    logger.info({ dropdown }, 'dropdown switched');

    logger.info('Phase C: reading per-trim monthlies');
    const monthlyByTrim = await readMonthliesByTrim(page);
    logger.info({ monthlyByTrim }, 'monthlies');

    const offers = [];
    for (const trimKey of Object.keys(cashByTrim)) {
      logger.info({ trim: trimKey }, 'reading panel');
      const panel = await selectTrimAndReadPanel(page, trimKey);
      const offer = buildOffer({
        brandConfig,
        trimKey,
        cashGross: cashByTrim[trimKey],
        monthlyNetRaw: monthlyByTrim[trimKey],
        panelReading: panel,
        url: brandConfig.endpoints.model3Design,
        scrapedAt: runId,
      });
      offers.push(validateOffer(offer));
    }
    return offers;
  } finally {
    await cleanup();
  }
}

const adapter = {
  id: 'tesla',
  displayName: brandConfig.displayName,
  run,
  toExcelRow: defaultToExcelRow,
};

export default adapter;
