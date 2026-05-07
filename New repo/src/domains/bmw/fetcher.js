// BMW configurator I/O: load each model URL via Playwright (it's an SPA) and
// intercept the `default-calculation` JSON response. We don't need stealth —
// configure.bmw.be doesn't block headless.
import { chromium } from 'patchright';
import { BrowserError } from '../../libraries/error-handling/AppError.js';

const COOKIE_BANNER_DROPPER = `
  for (const el of document.querySelectorAll("*")) {
    if (el.shadowRoot) {
      const btn = el.shadowRoot.querySelector("button, [role=button]");
      if (btn && /accept|aanvaard|akkoord|toestaan|allow/i.test(btn.innerText || "")) {
        btn.click();
        break;
      }
    }
  }
`;

export async function launchBmwContext() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'nl-BE',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 },
  });
  return {
    context,
    cleanup: () => browser.close(),
  };
}

export async function captureCalculation(context, url, { logger, timeoutMs = 25000 } = {}) {
  const page = await context.newPage();
  let captured = null;
  page.on('response', async (resp) => {
    const u = resp.url();
    if (
      u.includes('operations/default-calculation') &&
      (resp.headers()['content-type'] || '').includes('json')
    ) {
      try {
        const body = await resp.text();
        const j = JSON.parse(body);
        if (j && Array.isArray(j.data) && j.data.length) {
          captured = j;
        }
      } catch (e) {
        logger.debug({ url: u, err: e.message }, 'BMW calc parse warn');
      }
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.evaluate(COOKIE_BANNER_DROPPER).catch(() => {});
    const start = Date.now();
    while (!captured && Date.now() - start < timeoutMs) {
      await page.waitForTimeout(500);
    }
  } finally {
    await page.close().catch(() => {});
  }

  if (!captured) {
    throw new BrowserError('No default-calculation JSON captured', {
      code: 'BMW_NO_CALC',
      context: { url },
    });
  }
  return captured;
}
