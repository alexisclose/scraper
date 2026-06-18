// Audi (Belgium) I/O. Two ways to obtain the finance-form HTML:
//
//   1. fetchByCode()        — direct HTTP GET of the CCF formulastep page for an
//                             already-minted code. Uses the shared proxy-aware
//                             httpFetch, so it works behind the corporate proxy
//                             exactly like the VW/Mercedes fetchers. Cheap, but
//                             codes expire (then the server 302s to Base/Oops).
//
//   2. mintFromConfigurator — drives the JS configurator on www.audi.be with a
//                             real browser (Playwright/patchright via the shared
//                             launcher), accepts the cookie wall, clicks
//                             "Bereken uw maandprijs", and follows the redirect
//                             to formsccf — which mints a FRESH code. Heavier,
//                             but immune to code expiry. Mirrors the Tesla flow.
//
// Pure I/O only — no parsing. The parser turns the returned HTML into an offer.
/* global document */
import { httpFetch } from '../../libraries/http/fetch.js';

const HTML_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'nl-BE,nl;q=0.9',
};

// GET the formulastep page for a code, following redirects. Native fetch exposes
// the post-redirect URL on res.url, which is how we detect the Base/Oops bounce
// without parsing the body.
export async function fetchByCode(code, brandConfig) {
  const requestUrl = brandConfig.endpoints.ccfFormulaStep.replace('{code}', encodeURIComponent(code));
  const res = await httpFetch(requestUrl, { headers: HTML_HEADERS });
  const html = await res.text();
  const finalUrl = res.url || requestUrl;
  return {
    requestUrl,
    finalUrl,
    status: res.status,
    redirectedToOops: /\/Base\/Oops/i.test(finalUrl),
    html,
  };
}

// Best-effort cookie-consent dismissal. Audi nests the banner in (possibly
// multiple) shadow roots; Playwright's text engine pierces *open* shadow DOM so
// getByText usually suffices, but we also brute-force any shadow buttons.
async function acceptCookies(page, logger) {
  const labels = /alles toestaan|alles accepteren|accepteer alles|akkoord|aanvaard|accept all|agree/i;
  try {
    const btn = page.getByText(labels).first();
    if (await btn.count()) {
      await btn.click({ timeout: 5000 });
      logger.debug('Audi cookie banner accepted (text engine)');
      return;
    }
  } catch {
    /* fall through to shadow brute force */
  }
  await page
    .evaluate((src) => {
      const re = new RegExp(src, 'i');
      const walk = (root) => {
        for (const el of root.querySelectorAll('button,[role=button],a')) {
          if (re.test(el.innerText || el.textContent || '')) {
            el.click();
            return true;
          }
          if (el.shadowRoot && walk(el.shadowRoot)) return true;
        }
        return false;
      };
      walk(document);
    }, labels.source)
    .catch(() => {});
}

// On the formsccf finance form, switch to the BUSINESS ("Professionelen") tab
// and pick the Financial Renting product so the milesFinance JS fires the
// calculation XHR for the product we actually want. Best-effort: the monthly
// only materialises if the reCAPTCHA score lets /ccf/FinanceApi/ respond.
async function selectBusinessRenting(page, logger) {
  for (const rx of [/professionelen/i, /professionnels/i, /professional/i, /zakelijk/i]) {
    const el = page.getByText(rx).first();
    if (await el.count().catch(() => 0)) {
      await el.click({ timeout: 6000 }).catch(() => {});
      logger.info({ tab: String(rx) }, 'Audi selected business customer tab');
      await page.waitForTimeout(3000);
      break;
    }
  }
  for (const rx of [/financi[eë]le renting/i, /financial renting/i, /\brenting\b/i, /leasing/i]) {
    const el = page.getByText(rx).first();
    if (await el.count().catch(() => 0)) {
      await el.click({ timeout: 6000 }).catch(() => {});
      logger.info({ product: String(rx) }, 'Audi selected finance product');
      await page.waitForTimeout(4000);
      break;
    }
  }
}

// Open one model's configurator, click through to the finance step, and return
// the finance-form HTML + the freshly minted code + any captured FinanceApi
// JSON. Throws if we never land on formsccf so the caller can record the reason.
export async function mintFromConfigurator(context, model, { logger, timeoutMs = 90000 }) {
  const page = await context.newPage();

  // Capture every finance-calculation XHR across the whole flow (incl. popups).
  // /ccf/FinanceApi/GetComponentList (+ any calculate endpoint) carries the
  // monthly when reCAPTCHA lets it through; we keep the raw JSON for parsing and
  // calibration. A reCAPTCHA-blocked call shows up as a redirect to
  // FinanceApi/Oops?error=Recaptcha, which we record as a clear signal.
  const financeApi = [];
  let recaptchaBlocked = false;
  const onResponse = async (res) => {
    const u = res.url();
    if (!/formsccf\.audi\.be\/ccf\/FinanceApi/i.test(u)) return;
    if (/FinanceApi\/Oops/i.test(u) && /error=Recaptcha/i.test(u)) recaptchaBlocked = true;
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;
    try {
      const json = await res.json();
      // The monthly comes back in the Calculate *response*; the selected term/
      // mileage/down-payment live in its *request* payload. Capture both so the
      // parser (and future calibration) can read term/mileage from the request.
      let requestBody = null;
      try {
        const raw = res.request().postData();
        requestBody = raw ? JSON.parse(raw) : null;
      } catch {
        requestBody = res.request().postData() || null;
      }
      financeApi.push({ url: u, status: res.status(), json, requestBody });
    } catch {
      /* non-JSON / empty body — ignore */
    }
  };
  context.on('response', onResponse);
  // The finance step may open in the same tab or a popup; catch both. Keep
  // references to the listeners so we can detach them — otherwise each model
  // leaks handlers onto the shared context and earlier popups can interfere.
  let onFrame;
  let onPage;
  const formsccfReached = new Promise((resolve) => {
    onFrame = (frame) => {
      if (frame === page.mainFrame() && /formsccf\.audi\.be\/ccf/i.test(frame.url())) {
        resolve({ page, url: frame.url() });
      }
    };
    onPage = async (popup) => {
      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
        if (/formsccf\.audi\.be\/ccf/i.test(popup.url())) resolve({ page: popup, url: popup.url() });
      } catch {
        /* ignore */
      }
    };
    page.on('framenavigated', onFrame);
    context.on('page', onPage);
  });

  logger.info({ model: model.id, url: model.configuratorUrl }, 'Audi opening configurator');
  await page.goto(model.configuratorUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForTimeout(4000);

  // Bail early with a clear signal if Audi served the geo/maintenance wall.
  const title = await page.title().catch(() => '');
  if (/not available|wartungsarbeiten|maintenance/i.test(title)) {
    context.off('response', onResponse);
    await page.close().catch(() => {});
    throw new Error(`AUDI_SITE_UNAVAILABLE: configurator returned "${title}"`);
  }

  await acceptCookies(page, logger);
  await page.waitForTimeout(2000);

  // "configuratie bekijken" → summary, then "Bereken uw maandprijs". Both are
  // plain buttons/links; click whichever is present, summary first.
  for (const rx of [/configuratie bekijken/i, /bereken uw maandprijs/i]) {
    try {
      const el = page.getByText(rx).first();
      if (await el.count()) {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 8000 });
        logger.info({ model: model.id, button: String(rx) }, 'Audi clicked step button');
        await page.waitForTimeout(3000);
      } else {
        logger.debug({ model: model.id, button: String(rx) }, 'Audi step button not found');
      }
    } catch (err) {
      logger.debug({ model: model.id, button: String(rx), err: err.message }, 'Audi click failed');
    }
  }

  const landed = await Promise.race([
    formsccfReached,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  // Detach listeners regardless of outcome so they don't leak onto the context.
  page.off('framenavigated', onFrame);
  context.off('page', onPage);

  if (!landed) {
    context.off('response', onResponse);
    await page.close().catch(() => {});
    throw new Error('AUDI_NO_FORMSCCF: never navigated to formsccf finance form');
  }

  const finalPage = landed.page;
  const finalUrl = landed.url;
  const code = finalUrl.includes('code=') ? new URL(finalUrl).searchParams.get('code') : null;
  logger.info({ model: model.id, finalUrl, code }, 'Audi reached finance form');

  // Let the page settle, then drive the business-renting selection so the calc
  // XHR fires for the right product, and give it time to come back.
  await finalPage.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  await finalPage.waitForTimeout(2500);
  if (!/\/Base\/Oops/i.test(finalUrl)) {
    await selectBusinessRenting(finalPage, logger).catch((err) =>
      logger.debug({ model: model.id, err: err.message }, 'Audi business-renting selection failed'),
    );
    await finalPage.waitForTimeout(4000);
  }

  // Read the HTML defensively: the finance app re-renders after landing, which
  // can transiently tear down the execution context. Retry content() once.
  let html = '';
  for (let i = 0; i < 2 && !html; i += 1) {
    html = await finalPage.content().catch(() => '');
    if (!html) await finalPage.waitForTimeout(2000);
  }

  context.off('response', onResponse);
  if (finalPage !== page) await page.close().catch(() => {});
  await finalPage.close().catch(() => {});

  logger.info(
    { model: model.id, financeApiResponses: financeApi.length, recaptchaBlocked },
    'Audi finance-form captured',
  );
  if (!html) throw new Error('AUDI_CONTENT_UNREADABLE: finance page closed before HTML captured');
  return {
    code,
    finalUrl,
    html,
    financeApi,
    recaptchaBlocked,
    redirectedToOops: /\/Base\/Oops/i.test(finalUrl),
  };
}
