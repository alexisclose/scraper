// Refresh the committed Audi configurator `pr=` strings.
//
// Each model in candidate-codes.json carries a full configurator URL whose `pr=`
// query is a point-in-time snapshot of a valid car configuration. When Audi
// facelifts a range (new model year, retired option codes) that snapshot goes
// stale: the "Bereken uw maandprijs" CTA still renders, but Audi's quote backend
// answers the click with "Onverwachte fout — technische problemen" and never mints
// a CCF code. The fetcher recovers at runtime (it rebuilds a config and retries),
// but that recovery costs minutes per model — Audi is ~94% of a full sweep's wall
// clock. Running this script folds the recovery back into the data file so the
// fast path hits again.
//
// For each model: open the BARE configurator URL, let the SPA build its own valid
// default configuration (it rewrites the URL with a fresh `pr=` within seconds),
// and keep that URL with `#summary` appended — that fragment is the step where the
// finance CTA lives.
//
// Usage:  node scripts/refresh-audi-configs.mjs [--dry] [--only=q3-suv,a6-avant]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, killChromeByProfileDir } from '../src/libraries/browser/launch.js';
import { config } from '../src/configs/index.js';
import { logger } from '../src/libraries/log/logger.js';

/* global document */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'src', 'domains', 'audi', 'data', 'candidate-codes.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()) : null;

const acceptCookies = (page) =>
  page
    .evaluate(() => {
      const host = document.getElementById('privacy-shadow');
      const accept =
        host?.shadowRoot &&
        (host.shadowRoot.getElementById('ensAcceptAll') ||
          host.shadowRoot.querySelector('[id*="Accept" i]'));
      if (accept) accept.click();
      setTimeout(() => document.getElementById('privacy-shadow')?.remove(), 1200);
    })
    .catch(() => {});

// Open the bare configurator and return the URL once the SPA has stamped a `pr=`
// configuration into it, or null if it never does.
async function harvest(page, model) {
  const bare = model.configuratorUrl.split('?')[0].split('#')[0];
  await page.goto(bare, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await acceptCookies(page);
  for (let i = 0; i < 25; i += 1) {
    await page.waitForTimeout(1000);
    const u = page.url();
    if (/[?&]pr=/.test(u)) {
      // Let the config settle — the SPA can refine it for another beat.
      await page.waitForTimeout(3000);
      const settled = page.url();
      return `${(/[?&]pr=/.test(settled) ? settled : u).split('#')[0]}#summary`;
    }
  }
  return null;
}

async function main() {
  const data = JSON.parse(readFileSync(DATA, 'utf8'));
  const models = data.models.filter((m) => !only || only.includes(m.id));
  logger.info({ models: models.length, dryRun }, 'refreshing Audi configurator configs');

  const profileDir = join(config.paths.browserProfilesDir, 'audi-refresh');
  const { context } = await launchBrowser({
    strategy: 'spawn-cdp',
    port: config.tesla.cdpPort + 900,
    profileDir,
    startUrl: 'about:blank',
  });

  let changed = 0;
  let failed = 0;
  for (const model of models) {
    const page = await context.newPage();
    try {
      const fresh = await harvest(page, model);
      if (!fresh) {
        logger.warn({ model: model.id }, 'no fresh config produced — keeping the existing URL');
        failed += 1;
      } else if (fresh === model.configuratorUrl) {
        logger.info({ model: model.id }, 'config unchanged');
      } else {
        logger.info({ model: model.id, fresh: fresh.slice(0, 110) }, 'config refreshed');
        model.configuratorUrl = fresh;
        changed += 1;
      }
    } catch (err) {
      logger.warn({ model: model.id, err: err.message }, 'refresh failed — keeping the existing URL');
      failed += 1;
    } finally {
      await page.close().catch(() => {});
    }
  }

  await context.close().catch(() => {});
  await killChromeByProfileDir(profileDir);

  if (dryRun) {
    logger.info({ changed, failed }, 'DRY RUN — candidate-codes.json not written');
    return;
  }
  if (changed) {
    data._comment =
      `${(data._comment || '').replace(/ Configs last refreshed .*$/, '')} ` +
      `Configs last refreshed ${new Date().toISOString().slice(0, 10)} by scripts/refresh-audi-configs.mjs ` +
      `(the pr= strings go stale when Audi facelifts a range; refresh them when the fetcher starts self-healing often).`.trim();
    writeFileSync(DATA, `${JSON.stringify(data, null, 2)}\n`);
  }
  logger.info({ changed, failed, written: changed > 0 }, 'Audi config refresh done');
}

main().catch((err) => {
  logger.error({ err: err.message }, 'refresh script failed');
  process.exit(1);
});
