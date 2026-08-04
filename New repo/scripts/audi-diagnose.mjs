// Single-model Audi diagnostic. Drives ONE configurator model in a visible
// browser with every relevant lifecycle event instrumented, so we can see what
// actually happens after "Bereken uw maandprijs" is clicked — popup, new tab,
// iframe, redirect, changed host, or a pure API call.
//
//   node scripts/audi-diagnose.mjs [modelId] [--strategy=spawn-cdp|patchright]
//
// Defaults to a3-sportback and the same spawn-cdp strategy production uses.
// Writes a full event trace to data/diagnostics/audi-<model>-<ts>.json.
/* global window, document, location */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, killChromeByProfileDir } from '../src/libraries/browser/launch.js';
import { config } from '../src/configs/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const modelId = args.find((a) => !a.startsWith('--')) || 'a3-sportback';
const strategy = (args.find((a) => a.startsWith('--strategy=')) || '').split('=')[1] || 'spawn-cdp';
const waitAfterClickMs = Number(
  (args.find((a) => a.startsWith('--wait=')) || '').split('=')[1] || 60000,
);

const CANDIDATES = JSON.parse(
  readFileSync(join(__dirname, '..', 'src', 'domains', 'audi', 'data', 'candidate-codes.json'), 'utf8'),
);
const model = (CANDIDATES.models || []).find((m) => m.id === modelId);
if (!model) {
  console.error(`No such Audi model: ${modelId}`);
  console.error('Available:', (CANDIDATES.models || []).map((m) => m.id).join(', '));
  process.exit(1);
}

const t0 = Date.now();
const events = [];
const rec = (type, data = {}) => {
  const e = { t: Date.now() - t0, type, ...data };
  events.push(e);
  const { t, type: ty, ...rest } = e;
  console.log(`[${String(t).padStart(6)}ms] ${ty.padEnd(22)}`, JSON.stringify(rest));
};

const short = (u) => (u && u.length > 220 ? `${u.slice(0, 220)}…` : u);

function instrumentPage(page, tag) {
  page.on('close', () => rec('page.close', { tag, url: short(page.url()) }));
  page.on('crash', () => rec('page.crash', { tag }));
  page.on('popup', (p) => {
    rec('page.popup', { tag, url: short(p.url()) });
    instrumentPage(p, `${tag}>popup`);
  });
  page.on('framenavigated', (f) =>
    rec('framenavigated', {
      tag,
      main: f === page.mainFrame(),
      name: f.name(),
      url: short(f.url()),
    }),
  );
  page.on('frameattached', (f) => rec('frameattached', { tag, name: f.name(), url: short(f.url()) }));
  page.on('framedetached', (f) => rec('framedetached', { tag, url: short(f.url()) }));
  page.on('requestfailed', (r) =>
    rec('requestfailed', {
      tag,
      method: r.method(),
      type: r.resourceType(),
      url: short(r.url()),
      failure: r.failure()?.errorText,
    }),
  );
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    rec('console', { tag, level: m.type(), text: String(m.text()).slice(0, 400) });
  });
  page.on('pageerror', (e) => rec('pageerror', { tag, msg: String(e.message).slice(0, 400) }));
  page.on('dialog', async (d) => {
    rec('dialog', { tag, type: d.type(), msg: d.message() });
    await d.dismiss().catch(() => {});
  });
  page.on('response', (res) => {
    const u = res.url();
    const rt = res.request().resourceType();
    // Everything on formsccf, every document/navigation, every failure status,
    // and anything that smells like the finance flow.
    const interesting =
      /formsccf|ccf\/|finance|calcul|renting|leasing|dieteren/i.test(u) ||
      rt === 'document' ||
      res.status() >= 400;
    if (!interesting) return;
    rec('response', {
      tag,
      status: res.status(),
      type: rt,
      method: res.request().method(),
      url: short(u),
      location: res.headers()['location'] ? short(res.headers()['location']) : undefined,
    });
  });
}

async function dumpState(page, label) {
  const state = await page
    .evaluate(() => {
      const ctas = [];
      for (const el of document.querySelectorAll('a,button,[role="button"],[role="link"]')) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (!/bereken uw maandprijs/i.test(txt)) continue;
        const r = el.getBoundingClientRect();
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = String(a.value).slice(0, 200);
        ctas.push({
          tag: el.tagName,
          text: txt.slice(0, 80),
          visible: !!(el.offsetParent || r.width * r.height),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
          attrs,
        });
      }
      const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
        src: (f.getAttribute('src') || '').slice(0, 220),
        id: f.id,
        name: f.name,
        w: Math.round(f.getBoundingClientRect().width),
        h: Math.round(f.getBoundingClientRect().height),
      }));
      const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ');
      return {
        url: location.href,
        title: document.title,
        consentHost: !!document.getElementById('privacy-shadow'),
        ctas,
        iframes,
        openCalls: window.__openCalls || [],
        errorish: /onverwachte fout|technische problem|erreur|oops|niet beschikbaar/i.test(bodyText)
          ? bodyText.slice(0, 600)
          : null,
        bodySample: bodyText.slice(0, 400),
      };
    })
    .catch((e) => ({ evaluateFailed: e.message }));
  rec(`state:${label}`, state);
  return state;
}

async function main() {
  const profileDir = join(config.paths.browserProfilesDir, `audi-diag-${Date.now()}`);
  rec('launch', { strategy, profileDir, model: model.id, url: short(model.configuratorUrl) });

  const handle = await launchBrowser({
    strategy,
    port: config.tesla.cdpPort + 40,
    profileDir,
    startUrl: 'about:blank',
  });
  const { context, browser } = handle;
  if (browser) browser.on('disconnected', () => rec('browser.disconnected'));
  context.on('close', () => rec('context.close'));
  context.on('page', (p) => {
    rec('context.page', { url: short(p.url()) });
    instrumentPage(p, 'ctx-new-page');
  });

  // Record window.open / target=_blank attempts even if the browser blocks them.
  await context
    .addInitScript(() => {
      window.__openCalls = [];
      const orig = window.open;
      window.open = function (...a) {
        window.__openCalls.push({ args: a.map(String).slice(0, 3), at: Date.now() });
        const r = orig.apply(this, a);
        window.__openCalls[window.__openCalls.length - 1].returnedNull = r == null;
        return r;
      };
    })
    .catch((e) => rec('addInitScript.failed', { err: e.message }));

  const page = await context.newPage();
  instrumentPage(page, 'main');

  rec('goto', { url: short(model.configuratorUrl) });
  await page.goto(model.configuratorUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);

  // --- cookie consent (same logic as the fetcher) ---
  const consent = await page
    .evaluate(() => {
      const host = document.getElementById('privacy-shadow');
      const root = host && host.shadowRoot;
      if (!root) return { how: null, hadHost: !!host };
      const accept =
        root.getElementById('ensAcceptAll') ||
        root.querySelector('[id*="Accept" i], button.button.raised.blue');
      if (accept) {
        accept.click();
        return { how: 'ens-accept', hadHost: true };
      }
      return { how: null, hadHost: true };
    })
    .catch((e) => ({ err: e.message }));
  rec('consent', consent);
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.getElementById('privacy-shadow')?.remove()).catch(() => {});

  await page.waitForTimeout(4000);
  await dumpState(page, 'before-click');

  // Wait for the CTA to render, then click it exactly once and watch.
  const cta = page
    .locator('a, button, [role="button"]')
    .filter({ hasText: /bereken uw maandprijs/i })
    .first();
  await cta.waitFor({ state: 'visible', timeout: 45000 }).catch((e) => rec('cta.waitFailed', { err: e.message }));
  await dumpState(page, 'cta-ready');

  rec('click', { what: 'Bereken uw maandprijs' });
  const clicked = await cta
    .click({ timeout: 10000 })
    .then(() => true)
    .catch((e) => {
      rec('click.failed', { err: e.message });
      return false;
    });
  rec('click.result', { clicked });

  // Watch for the specified window, snapshotting state periodically.
  const deadline = Date.now() + waitAfterClickMs;
  let tick = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    tick += 1;
    const pages = context.pages();
    rec('poll', {
      tick,
      pages: pages.map((p) => short(p.url())),
      mainUrl: short(page.url()),
      frames: page.frames().map((f) => short(f.url())),
    });
    if (/formsccf/i.test(pages.map((p) => p.url()).join(' ') + page.frames().map((f) => f.url()).join(' '))) {
      rec('LANDED_FORMSCCF', {});
      break;
    }
  }

  await dumpState(page, 'after-click');

  // Persist the HTML of whatever we ended on, for offline inspection.
  const outDir = join(config.paths.dataDir, 'diagnostics');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const htmlPath = join(outDir, `audi-${model.id}-${stamp}.html`);
  writeFileSync(htmlPath, await page.content().catch(() => ''), 'utf8');
  const jsonPath = join(outDir, `audi-${model.id}-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify({ model: model.id, strategy, events }, null, 2), 'utf8');
  rec('written', { htmlPath, jsonPath });

  await handle.cleanup().catch(() => {});
  await browser?.close?.().catch(() => {});
  if (strategy === 'spawn-cdp') await killChromeByProfileDir(profileDir);
  process.exit(0);
}

main().catch((err) => {
  rec('FATAL', { err: err.message, stack: String(err.stack).slice(0, 1200) });
  process.exit(1);
});
