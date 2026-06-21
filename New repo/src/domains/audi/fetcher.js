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
import { parseEur } from '../../libraries/currency/parse.js';

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

// Click the first VISIBLE clickable element (a/button/role) whose text matches.
// The configurator repeats labels like "Bereken uw maandprijs" across menus and
// tooltips, so getByText(...).first() often grabs a hidden/non-clickable copy and
// the click silently times out. Returns true only when a real click happened.
async function clickVisibleByText(page, rx) {
  const candidates = page
    .locator('a, button, [role="button"], [role="link"]')
    .filter({ hasText: rx });
  const n = await candidates.count().catch(() => 0);
  // Include the plain text node as a final fallback (non-standard clickable wrappers).
  const locators = [];
  for (let i = 0; i < n; i += 1) locators.push(candidates.nth(i));
  locators.push(page.getByText(rx).first());
  for (const el of locators) {
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await el.click({ timeout: 6000 });
      return true;
    } catch {
      /* try the next visible candidate */
    }
  }
  return false;
}

// Dismiss the cookie wall. Audi/D'Ieteren use ENSIGHTEN consent rendered inside
// a `<div id="privacy-shadow">` shadow root, with an accept button
// `#ensAcceptAll` ("Verdergaan met alle cookies"). Until it's dismissed its
// overlay intercepts every click (so the "Bereken uw maandprijs" CTA can't be
// clicked). We click accept inside the shadow root and, as a safety net, remove
// the overlay host so it can never block the page even if consent didn't record.
async function acceptCookies(page, logger) {
  const result = await page
    .evaluate(() => {
      const host = document.getElementById('privacy-shadow');
      const root = host && host.shadowRoot;
      let how = null;
      if (root) {
        const accept =
          root.getElementById('ensAcceptAll') ||
          root.querySelector('[id*="Accept" i], button.button.raised.blue');
        if (accept) {
          accept.click();
          how = 'ens-accept';
        }
      }
      return { how, hadHost: !!host };
    })
    .catch(() => ({ how: null, hadHost: false }));

  if (result.how) {
    await page.waitForTimeout(1500);
    // If the overlay is still up, drop it so it can't intercept clicks.
    await page
      .evaluate(() => document.getElementById('privacy-shadow')?.remove())
      .catch(() => {});
    logger.debug('Audi cookie consent accepted (Ensighten)');
    return;
  }

  // Fallback for other consent variants: text engine, then a shadow brute force.
  const labels = /verdergaan met alle|alles toestaan|alles accepteren|accepteer alles|akkoord|aanvaard|accept all|agree/i;
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
      document.getElementById('privacy-shadow')?.remove();
    }, labels.source)
    .catch(() => {});
}

// On the formsccf finance form, switch the customer type to BUSINESS
// (Enterprise) and pick the FINANCIAL RENTING product — NOT the default "Verhuur
// lange termijn" (Long Term Rental). The products are radios named
// "financial-pack": each carries a data-familyid plus a hidden
// #financing-type-<id> whose value is "FinancialRenting" / "LongTimeRenting". We
// target the FinancialRenting one by that value so we never depend on label text.
// Selecting it makes milesFinance fire GetComponentList + Calculate for that
// family (whose default down payment is 25% of the catalogue, excl. BTW).
async function selectBusinessRenting(page, logger) {
  // Customer type = Enterprise (business). The radio is hidden behind a label;
  // click the label so the framework's change handler fires.
  await page
    .locator('label[for="enterprise"]')
    .first()
    .click({ timeout: 4000, force: true })
    .catch(() => {});
  await page.waitForTimeout(1500);

  // Identify the FinancialRenting family id (FinancingType === FinancialRenting),
  // skipping the hidden print-modal duplicates. POLL for it: the product cards
  // render asynchronously and can lag under parallel load — not waiting here was
  // the main cause of "radio not found" and the downstream retry storm.
  const findFamily = () =>
    page
      .evaluate(() => {
        // The print copy and the live copy share the same family id, so no need
        // to filter by container — just take the first FinancialRenting radio.
        for (const r of document.querySelectorAll('input[name="financial-pack"]')) {
          const id = r.getAttribute('data-familyid') || r.value;
          const ft = document.querySelector(`#financing-type-${id}`);
          if (
            (ft && /FinancialRenting/i.test(ft.value)) ||
            /renting financier/i.test(r.getAttribute('data-tracking-financialname') || '')
          ) {
            return id;
          }
        }
        return null;
      })
      .catch(() => null);

  let familyId = await findFamily();
  for (let i = 0; i < 25 && !familyId; i += 1) {
    await page.waitForTimeout(1000);
    familyId = await findFamily();
  }

  let checked = false;
  if (familyId) {
    // The radios are CSS-hidden custom cards (and duplicated in the DOM). A
    // force-click on the radio's own box doesn't flip them — the framework
    // switches product on a real click of the VISIBLE card. Click its on-screen
    // centre with the mouse, and verify ANY copy of the radio became checked.
    const isChecked = () =>
      page
        .evaluate(
          (fid) =>
            [...document.querySelectorAll('input[name="financial-pack"]')].some(
              (r) => String(r.getAttribute('data-familyid') || r.value) === String(fid) && r.checked,
            ),
          familyId,
        )
        .catch(() => false);

    checked = await isChecked();
    for (let attempt = 0; attempt < 5 && !checked; attempt += 1) {
      const box = await page
        .evaluate((fid) => {
          for (const c of document.querySelectorAll('.card--pack')) {
            const r = c.querySelector('input[name="financial-pack"]');
            const id = r && (r.getAttribute('data-familyid') || r.value);
            if (String(id) !== String(fid)) continue;
            c.scrollIntoView({ block: 'center' });
            const rect = c.getBoundingClientRect();
            // Visible on-screen card only (the hidden print copy has zero box).
            if (rect.width > 0 && rect.height > 0)
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          return null;
        }, familyId)
        .catch(() => null);
      if (!box) {
        await page.waitForTimeout(1000);
        continue;
      }
      await page.mouse.click(box.x, box.y).catch(() => {});
      await page.waitForTimeout(2000);
      checked = await isChecked();
    }
    logger.info({ familyId, checked }, 'Audi selected Financiële Renting product');
  } else {
    logger.warn('Audi Financiële Renting radio not found — staying on default product');
  }
  // Give GetComponentList + the default Calculate a moment; setDownPaymentPct
  // then polls for the down field, so this doesn't need to be generous.
  await page.waitForTimeout(2500);
  return checked;
}

// Set the down-payment ("Voorschot"/"Eerste verhoogde huur") to `pct` of the
// vehicle's net price on the live form, then let the form's OWN calculator
// recompute the monthly — we never compute the payment ourselves. We VERIFY the
// recalc actually landed (a fresh Calculate whose down bound ≈ our amount) by
// watching the live `financeApi` capture, and re-fill if it didn't. Returns
// { amount, netPrice, verified } or null if the control/price couldn't be found.
async function setDownPaymentPct(page, pct, logger, financeApi = []) {
  const probe = () =>
    page
      .evaluate(() => {
        const inputs = [
          ...document.querySelectorAll('input[id^="component-bound-"],input[name^="component-bound-"]'),
        ];
        // The down payment is "Voorschot" (Long Term Rental) or "Eerste verhoogde
        // huur" (Financiële Renting) — NOT "Aankoopoptie", which is the residual.
        const isDown = (el) => {
          const near = ((el.closest('label') || el.parentElement || {}).innerText || '').toLowerCase();
          if (/aankoopoptie|option d.achat|purchase|restwaarde|residu/.test(near)) return false;
          const dn = (el.getAttribute('data-name') || '').toLowerCase();
          return (
            /voorschot|eerste verhoogde huur|premier loyer|acompte|aanbetaling/.test(near) ||
            /upfront|firstincreased|downpayment|increasedrent/.test(dn)
          );
        };
        // Prefer the VISIBLE down field — the form keeps a hidden print copy with
        // duplicate ids, so visibility (not a class filter) is what disambiguates.
        const el =
          inputs.find((e) => isDown(e) && (e.offsetParent || e.getClientRects().length)) ||
          inputs.find(isDown);
        const txt = document.body.innerText || '';
        const m = txt.match(/Totale prijs\s*:?\s*€\s*[\d\s.,]+€\s*([\d\s.,]+?)\s*Excl/i);
        return {
          downId: el ? el.id || el.name : null,
          currentDefault: el ? el.value : null,
          defaultNet: el ? el.getAttribute('data-value-vat-excluded') : null,
          netPriceRaw: m ? m[1] : null,
        };
      })
      .catch(() => ({ downId: null, netPriceRaw: null, defaultNet: null }));

  // Poll only until the down field exists AND we have a catalogue net — either
  // the printed "Totale prijs" OR (much sooner, and accurate to the euro) the
  // field's own 25% default value. The "Totale prijs" line often stays stuck on
  // "Prijs aan het berekenen…", so waiting for it just burns ~30s/model.
  // Exits as soon as the field is ready, so the higher cap only costs time on
  // heavy configurations (e.g. A1's very long build) that are slow to render it.
  const ready = (x) => x.downId && (x.netPriceRaw || parseEur(x.defaultNet));
  let info = await probe();
  for (let i = 0; i < 15 && !ready(info); i += 1) {
    await page.waitForTimeout(1000);
    info = await probe();
  }

  if (!info.downId) {
    logger.warn(info, 'Audi down-payment control not found — leaving default');
    return null;
  }
  // Catalogue net: prefer the printed total; else derive from the field's default
  // (the standard 25% first-increased-rent → catalogue = default / 0.25).
  let netPrice = parseEur(info.netPriceRaw);
  if (!netPrice) {
    const defNet = parseEur(info.defaultNet);
    if (defNet) netPrice = Math.round((defNet / 0.25) * 100) / 100;
  }
  if (!netPrice) {
    logger.warn(info, 'Audi net price not found — leaving default down payment');
    return null;
  }
  const amount = Math.round(pct * netPrice * 100) / 100;
  const display = amount.toFixed(2).replace('.', ','); // Belgian decimal comma
  const input = page.locator(`#${info.downId}`);

  // A Calculate whose request carries a bound ≈ our amount confirms the form
  // re-priced with the down we typed (not the 25% default).
  const recalcLanded = (since) =>
    financeApi
      .slice(since)
      .some(
        (r) =>
          /FinanceApi\/Calculate/i.test(r.url || '') &&
          r.json &&
          r.json.Success &&
          Array.isArray(r.requestBody?.bounds) &&
          r.requestBody.bounds.some((b) => Math.abs((parseEur(b.value) ?? -1e9) - amount) < 1),
      );

  for (let fillTry = 1; fillTry <= 3; fillTry += 1) {
    const since = financeApi.length;
    try {
      await input.fill('');
      await input.fill(display);
      await input.press('Tab'); // blur → most widgets recalc on blur
    } catch (err) {
      logger.warn({ downId: info.downId, err: err.message, fillTry }, 'Audi could not fill down-payment input');
      continue;
    }
    // Some layouts need an explicit recalc button.
    for (const rx of [/bereken uw maandelijkse betaling/i, /herbereken/i, /\bbereken\b/i]) {
      const b = page.getByText(rx).first();
      if (await b.count().catch(() => 0)) {
        await b.click().catch(() => {});
        break;
      }
    }
    // Wait (bounded) for the verified recalc to land.
    let verified = false;
    for (let i = 0; i < 12 && !verified; i += 1) {
      await page.waitForTimeout(1000);
      verified = recalcLanded(since);
    }
    if (verified) {
      logger.info(
        { downId: info.downId, replacedDefault: info.currentDefault, netPrice, pct, amount, fillTry },
        'Audi down payment applied and recalculation verified',
      );
      return { amount, netPrice, verified: true };
    }
    logger.warn({ downId: info.downId, amount, fillTry }, 'Audi down recalc not confirmed — retrying fill');
  }
  return { amount, netPrice, verified: false };
}

// Build a { componentId: meaning } map from the form's bound inputs so the
// parser can label the Calculate bounds (which carry only numeric component ids).
// Component ids differ per finance family, and for Financiële Renting the down
// payment ("Eerste verhoogde huur") and the residual ("Aankoopoptie") default to
// the SAME 25% value — so they can only be told apart by their on-form label.
async function readBoundMeanings(page) {
  return page
    .evaluate(() => {
      const map = {};
      for (const el of document.querySelectorAll(
        'input[id^="component-bound-"],select[id^="component-bound-"]',
      )) {
        const idnum = (el.id.match(/(\d+)$/) || [])[1];
        if (!idnum) continue;
        const near = ((el.closest('label') || el.parentElement || {}).innerText || '').toLowerCase();
        const dn = (el.getAttribute('data-name') || '').toLowerCase();
        let meaning = null;
        if (/aankoopoptie|option d.achat|purchase|restwaarde|residu/.test(near) || /purchase|residual/.test(dn))
          meaning = 'residual';
        else if (
          /eerste verhoogde huur|voorschot|premier loyer|acompte|aanbetaling/.test(near) ||
          /upfront|firstincreased|downpayment|increasedrent/.test(dn)
        )
          meaning = 'down';
        else if (/looptijd|duur|dur[ée]e|maanden|term/.test(near) || /duration|term/.test(dn))
          meaning = 'term';
        else if (/kilomet|afstand|\bkm\b/.test(near) || /mileage|distance|kilomet/.test(dn))
          meaning = 'mileage';
        if (meaning && !map[idnum]) map[idnum] = meaning;
      }
      return map;
    })
    .catch(() => ({}));
}

// Open one model's configurator, click through to the finance step, and return
// the finance-form HTML + the freshly minted code + any captured FinanceApi
// JSON. Throws if we never land on formsccf so the caller can record the reason.
export async function mintFromConfigurator(
  context,
  model,
  { logger, timeoutMs = 90000, downPaymentPct = 0 },
) {
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
      financeApi.push({ url: u, method: res.request().method(), status: res.status(), json, requestBody });
    } catch {
      /* non-JSON / empty body — ignore */
    }
  };
  context.on('response', onResponse);
  // The finance step loads in the same tab or a popup. A MUTABLE flag (rather
  // than a one-shot promise) lets us re-click the CTA and keep waiting — the
  // first click sometimes doesn't navigate (button not yet wired, or the click
  // hit a tooltip copy). Listeners are detached after to avoid leaking onto the
  // shared context.
  let landed = null;
  const onFrame = (frame) => {
    if (!landed && frame === page.mainFrame() && /formsccf\.audi\.be\/ccf/i.test(frame.url())) {
      landed = { page, url: frame.url() };
    }
  };
  const onPage = async (popup) => {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
      if (!landed && /formsccf\.audi\.be\/ccf/i.test(popup.url())) {
        landed = { page: popup, url: popup.url() };
      }
    } catch {
      /* ignore */
    }
  };
  page.on('framenavigated', onFrame);
  context.on('page', onPage);

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

  // Wait for the finance CTA to render (the "Prijs aan het berekenen…" label
  // lingers even after the price resolves, so wait on the button, not the text).
  const berekenCta = page
    .locator('a, button, [role="button"]')
    .filter({ hasText: /bereken uw maandprijs/i })
    .first();
  await berekenCta.waitFor({ state: 'visible', timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Click the finance CTA and WAIT (generously — the mint + redirect can be slow)
  // for the formsccf navigation. Only re-click after a long wait, so we don't
  // fire a second click while the first navigation is still in flight.
  for (let clickAttempt = 1; clickAttempt <= 3 && !landed; clickAttempt += 1) {
    if (clickAttempt === 1) await clickVisibleByText(page, /configuratie bekijken/i);
    await berekenCta.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const clicked = await clickVisibleByText(page, /bereken uw maandprijs/i);
    logger[clicked ? 'info' : 'debug'](
      { model: model.id, clickAttempt },
      clicked ? 'Audi clicked Bereken uw maandprijs' : 'Audi Bereken button not clickable',
    );
    for (let i = 0; i < 35 && !landed; i += 1) await page.waitForTimeout(1000);
    if (!landed && clickAttempt < 3) {
      logger.warn({ model: model.id, clickAttempt }, 'Audi no formsccf yet — re-clicking CTA');
    }
  }
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
  let boundMeanings = {};
  let downVerified = false;
  await finalPage.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  await finalPage.waitForTimeout(2000);
  if (!/\/Base\/Oops/i.test(finalUrl)) {
    await selectBusinessRenting(finalPage, logger).catch((err) =>
      logger.warn({ model: model.id, err: err.message }, 'Audi product selection error'),
    );
    // setDownPaymentPct polls for the down field, so no generous settle needed.
    await finalPage.waitForTimeout(1500);

    // Set the down payment to the configured % and let the form recalculate.
    // setDownPaymentPct verifies the recalc landed and retries the fill itself.
    if (downPaymentPct > 0) {
      const set = await setDownPaymentPct(finalPage, downPaymentPct, logger, financeApi).catch(
        (err) => {
          logger.debug({ model: model.id, err: err.message }, 'Audi down-payment step failed');
          return null;
        },
      );
      downVerified = !!set?.verified;
    }

    // Capture the componentId → meaning map (down / residual / term / mileage)
    // from the form so the parser can label the Calculate bounds correctly.
    boundMeanings = await readBoundMeanings(finalPage);
    logger.info({ model: model.id, boundMeanings, downVerified }, 'Audi bound-component meanings');
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
    { model: model.id, financeApiResponses: financeApi.length, recaptchaBlocked, downVerified },
    'Audi finance-form captured',
  );
  if (!html) throw new Error('AUDI_CONTENT_UNREADABLE: finance page closed before HTML captured');
  return {
    code,
    finalUrl,
    html,
    financeApi,
    boundMeanings,
    recaptchaBlocked,
    redirectedToOops: /\/Base\/Oops/i.test(finalUrl),
  };
}
