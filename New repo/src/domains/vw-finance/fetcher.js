// Volkswagen (Belgium) I/O for the CONFIGURATOR-driven finance scrape.
//
// VW's finance offers live on the same D'Ieteren CCF form as Audi's, just on a
// different host: formsccf.volkswagen.be/ccf/...  It is the identical
// milesFinance widget (same #enterprise/#private toggle — here labelled
// "Professionelen"/"Particulieren" — same financial-pack radios with a
// FinancialRenting family, same component-bound inputs, same FinanceApi/Calculate
// endpoint). So the widget-driving helpers below are ports of the Audi fetcher's,
// with the host swapped.
//
// Three concerns live here, all pure I/O (no parsing):
//
//   1. discoverConfiguratorModels — find the "best deals" trims from
//      www.volkswagen.be/nl/modellen.html (an embedded nav tree), resolve each
//      trim's default modelId (E-code) via oneapi.volkswagen.com, and build the
//      configurator summary URL that the browser drives. Cached on disk.
//
//   2. mintFromConfigurator — drive the configurator summary page with a real
//      browser, accept the cookie wall, click "Bereken mijn maandprijs" which
//      mints a FRESH CCF code and opens formsccf.volkswagen.be, then select the
//      BUSINESS "Financiële Renting" product, set the down payment, and capture
//      the recomputed monthly (FinanceApi JSON). Mirrors the Audi flow.
//
//   3. fetchByCode — direct-HTTP fast path for an already-minted CCF code
//      (price-only; codes expire then 302 to Base/Oops).
/* global document, getComputedStyle */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpFetch } from '../../libraries/http/fetch.js';
import { config, brandConfigs } from '../../configs/index.js';
import { JsonCache } from '../../libraries/io/json-cache.js';
import { parseEur } from '../../libraries/currency/parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const brandConfig = brandConfigs['vw-finance'];

// Fail fast (and loudly) if the wrong/incomplete brand config is wired in. The
// configurator endpoints live in vw-finance.json, NOT vw.json — pointing at the
// latter silently builds `undefined?tenant=undefined...` URLs and resolves 0
// models. Validating here turns that silent failure into a clear startup error.
for (const key of ['catalogueModels', 'tenant', 'configurator', 'modelsPage', 'ccfFormulaStep']) {
  if (!brandConfig?.endpoints?.[key]) {
    throw new Error(
      `VW Finance config missing endpoints.${key} — fetcher must use brandConfigs['vw-finance']`,
    );
  }
}

const HTML_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'nl-BE,nl;q=0.9',
};

// ---------------------------------------------------------------------------
// Discovery: best-deals trims -> resolved modelId -> configurator summary URL
// ---------------------------------------------------------------------------

// Committed fallback list of trim descriptors (carline/salesgroup/trim + slugs),
// scraped from modellen.html. Used when live nav-tree discovery comes up empty.
const STATIC_TRIMS = JSON.parse(
  readFileSync(join(__dirname, 'data', 'candidate-trims.json'), 'utf8'),
).trims;

// The modellen.html nav tree is embedded as %-encoded escaped JSON, so the
// field markers appear as `%5C%22<key>%5C%22` (i.e. \"key\"). Match the
// best-deals trim nodes and pull out carlineId / salesgroupId / trimId.
const Q = '%5C%22'; // \"
const TRIM_NODE_RE = new RegExp(
  `${Q}nodeId${Q}:${Q}(/[a-z0-9-]+/best-deals/[a-z0-9-]+)${Q}[\\s\\S]{0,400}?` +
    `${Q}carlineId${Q}:${Q}(\\d+)${Q},${Q}salesgroupId${Q}:${Q}(\\d+)${Q},${Q}trimId${Q}:${Q}([\\s\\S]+?)${Q}` +
    `[\\s\\S]{0,200}?${Q}name${Q}:${Q}([\\s\\S]+?)${Q}`,
  'gi',
);

// Parse the best-deals trim descriptors out of the modellen.html source.
export function parseTrimsFromModelsPage(html) {
  const seen = new Set();
  const trims = [];
  let m;
  const re = new RegExp(TRIM_NODE_RE.source, 'gi');
  while ((m = re.exec(html))) {
    const nodeId = m[1];
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const parts = nodeId.split('/'); // ["", carline, "best-deals", trim]
    trims.push({
      id: nodeId.replace(/^\//, '').replace(/\/best-deals\//, '__'),
      carlineSlug: parts[1],
      trimSlug: parts[3],
      carlineId: m[2],
      salesgroupId: m[3],
      trimId: decodeURIComponent(m[4].replace(/\+/g, ' ')),
      name: decodeURIComponent(m[5].replace(/\+/g, ' ')),
    });
  }
  return trims.sort((a, b) => a.id.localeCompare(b.id));
}

// Build the configurator summary URL the browser drives to mint a code. The
// `---=` navigation param must be encoded EXACTLY ONCE (URLSearchParams would
// double-encode it), so we assemble it by hand and append the rest normally.
export function buildConfiguratorUrl(model) {
  const { carlineSlug, trimSlug, carlineId, salesgroupId, trimId, modelId, modelYear } = model;
  const configStep = encodeURIComponent(
    JSON.stringify({ context: `${carlineId}-${salesgroupId}-${trimId}`, selectedStep: 'summary' }),
  );
  const nav = encodeURIComponent(
    JSON.stringify({ 'configuration-step-navigation-service': `/?configStep=${configStep}` }),
  );
  const rest = new URLSearchParams({
    'category-app': 'private',
    'carlineId-app': carlineId,
    'salesGroupId-app': salesgroupId,
    'trimName-app': trimId,
    'modelId-app': modelId,
    'modelVersion-app': '0',
    'modelYear-app': String(modelYear || new Date().getFullYear()),
  });
  return `${brandConfig.endpoints.configurator}/__app/${carlineSlug}/best-deals/${trimSlug}.app?---=${nav}&${rest}`;
}

// Resolve a trim's default modelId (E-code) via the public configurator API.
// Returns { modelId, modelYear, longName, carlineName, priceGross } or null.
async function resolveModelId(trim, { logger }) {
  const url =
    `${brandConfig.endpoints.catalogueModels}?tenant=${brandConfig.endpoints.tenant}` +
    `&salesgroupKey=${trim.salesgroupId}&carlineKey=${trim.carlineId}` +
    `&modelFilters=${encodeURIComponent('EquipmentLine:' + trim.trimId)}&fetchPrices=true`;
  try {
    const res = await httpFetch(url, {
      headers: {
        Accept: 'application/json',
        'x-api-key': config.vw.oneapiKey,
        Origin: 'https://www.volkswagen.be',
        Referer: 'https://www.volkswagen.be/',
      },
    });
    const json = await res.json();
    const model = (json.models || [])[0];
    if (!model?.code) {
      logger.warn({ trim: trim.id }, 'VW model resolve returned no code');
      return null;
    }
    const priceGross =
      parseEur(model.prices?.total?.value) ??
      parseEur(model.prices?.cash?.value) ??
      parseEur(model.prices?.[0]?.value) ??
      null;
    return {
      modelId: model.code,
      modelYear: model.year || null,
      longName: model.longName || model.name || null,
      carlineName: model.carlineName || null,
      priceGross,
    };
  } catch (err) {
    logger.warn({ trim: trim.id, err: err.message }, 'VW model resolve failed');
    return null;
  }
}

// Discover every best-deals trim and turn it into a configurator model the
// browser can drive. Prefers a live crawl of modellen.html (self-updating);
// falls back to the committed trim list. Resolves each trim's modelId via the
// oneapi catalogue, drops trims that can't resolve (logged). Cached on disk.
export async function discoverConfiguratorModels({ logger }) {
  const cache = new JsonCache({
    dir: join(config.paths.dataDir, 'cache', 'vw-finance'),
    bypass: config.vw.noCache,
    ttlMs: 24 * 60 * 60 * 1000, // 1 day
  });
  // Serve a non-empty cached result; a cached EMPTY list is treated as a miss so a
  // past transient failure can't pin discovery at 0 for the whole TTL.
  const cached = cache.get('configurator-models');
  if (cached && cached.length) return cached;

  let trims = [];
  try {
    const res = await httpFetch(brandConfig.endpoints.modelsPage, { headers: HTML_HEADERS });
    trims = parseTrimsFromModelsPage(await res.text());
    logger.info({ trims: trims.length }, 'VW best-deals trims discovered (live nav tree)');
  } catch (err) {
    logger.warn({ err: err.message }, 'VW live trim discovery failed — using committed list');
  }
  if (!trims.length) {
    trims = STATIC_TRIMS;
    logger.info({ trims: trims.length }, 'VW using committed trim list');
  }

  const models = [];
  for (const trim of trims) {
    const resolved = await resolveModelId(trim, { logger });
    if (!resolved) continue;
    const model = { ...trim, ...resolved };
    model.displayName = resolved.longName || `Volkswagen ${trim.name}`.replace(/\s+/g, ' ').trim();
    model.range = resolved.carlineName || null;
    model.configuratorUrl = buildConfiguratorUrl(model);
    models.push(model);
  }
  logger.info({ resolved: models.length, fromTrims: trims.length }, 'VW configurator models resolved');

  // Never cache an empty list: caching 0 would silently starve every run for the
  // next 24h (the exact trap behind the original "discovers 0 models" report).
  if (models.length) {
    cache.set('configurator-models', models);
  } else {
    logger.warn(
      { fromTrims: trims.length },
      'VW resolved 0 configurator models — NOT caching the empty result. Check oneapi reachability and x-api-key (VW_ONEAPI_KEY).',
    );
  }
  return models;
}

// ---------------------------------------------------------------------------
// Direct-HTTP fast path (already-minted code, price-only)
// ---------------------------------------------------------------------------

// GET the formulastep page for a code, following redirects. Native fetch exposes
// the post-redirect URL on res.url, which is how we detect the Base/Oops bounce.
export async function fetchByCode(code) {
  const requestUrl = brandConfig.endpoints.ccfFormulaStep.replace(
    '{code}',
    encodeURIComponent(code),
  );
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

// ---------------------------------------------------------------------------
// milesFinance widget driving (ports of the Audi helpers — identical widget)
// ---------------------------------------------------------------------------

// Click the first VISIBLE clickable element whose text matches. The configurator
// repeats labels across menus/tooltips, so getByText(...).first() often grabs a
// hidden copy and the click silently times out. Returns true only on a real click.
async function clickVisibleByText(page, rx) {
  const candidates = page
    .locator('a, button, [role="button"], [role="link"]')
    .filter({ hasText: rx });
  const n = await candidates.count().catch(() => 0);
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

// Dismiss the cookie wall. D'Ieteren use ENSIGHTEN consent rendered inside a
// `<div id="privacy-shadow">` shadow root with an accept button `#ensAcceptAll`.
// Until dismissed its overlay intercepts every click. Click accept, then remove
// the host as a safety net.
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
    await page.evaluate(() => document.getElementById('privacy-shadow')?.remove()).catch(() => {});
    logger.debug('VW cookie consent accepted (Ensighten)');
    return;
  }

  const labels =
    /verdergaan met alle|alles toestaan|alles accepteren|accepteer alles|akkoord|aanvaard|accept all|agree/i;
  try {
    const btn = page.getByText(labels).first();
    if (await btn.count()) {
      await btn.click({ timeout: 5000 });
      logger.debug('VW cookie banner accepted (text engine)');
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
// ("Professionelen") and pick the FINANCIAL RENTING product — NOT the default
// "Long Term Rental". Products are radios named "financial-pack", each carrying a
// data-familyid plus a hidden #financing-type-<id> whose value is
// "FinancialRenting"/"LongTimeRenting". We target FinancialRenting by that value
// so we never depend on label text. (Identical to the Audi widget.)
async function selectBusinessRenting(page, logger) {
  // CRITICAL VW vs Audi difference: VW keeps the product-cards container
  // (`.finance__content__packs`) at display:none until a REAL click on the
  // "Professionelen" (enterprise) toggle reveals it. A JS-dispatched change marks
  // the radio checked but does NOT reveal the packs — so we gate on the
  // container's actual visibility, never on the checkbox state (which would be a
  // false "success" that leaves no clickable card behind).
  const state = () =>
    page
      .evaluate(() => {
        const ent = document.querySelector('#enterprise');
        const packs = document.querySelector('.finance__content__packs');
        const packsVisible = !!packs && getComputedStyle(packs).display !== 'none';
        const hasRenting = [...document.querySelectorAll('input[name="financial-pack"]')].some(
          (r) => {
            const id = r.getAttribute('data-familyid') || r.value;
            const ft = document.querySelector(`#financing-type-${id}`);
            return (
              (ft && /FinancialRenting/i.test(ft.value)) ||
              /renting financier/i.test(r.getAttribute('data-tracking-financialname') || '')
            );
          },
        );
        return { hasEnterprise: !!ent, enterpriseChecked: !!ent?.checked, packsVisible, hasRenting };
      })
      .catch(() => ({ hasEnterprise: false, enterpriseChecked: false, packsVisible: false, hasRenting: false }));

  // Real click on the visible Professionelen toggle: label first, then the text,
  // then a programmatic label click as a last resort. (No checkbox dispatch — it
  // doesn't reveal the packs.)
  const clickEnterprise = async () => {
    const byLabel = await page
      .locator('label[for="enterprise"]')
      .first()
      .click({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (byLabel) return;
    const byText = await page
      .getByText(/^\s*Professionelen\s*$/i)
      .first()
      .click({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (byText) return;
    await page.evaluate(() => document.querySelector('label[for="enterprise"]')?.click()).catch(() => {});
  };

  // Gate on the REAL signal that business engaged: the FinancialRenting families
  // are present in the DOM (hasRenting) and #enterprise is checked. (Earlier code
  // gated on `.finance__content__packs` visibility, but that container is flaky to
  // read — multiple desktop/mobile copies — and produced false "not revealed"
  // warnings even when the switch had actually worked. Mirrors the Audi helper.)
  let s = await state();
  for (let attempt = 1; attempt <= 12 && !(s.enterpriseChecked && s.hasRenting); attempt += 1) {
    if (s.hasEnterprise) {
      // Strip the cookie-consent overlay first: it can re-inject and intercept the
      // toggle click just as it does the card click, leaving the business switch
      // unconfirmed. Mirrors the defensive removal in the card-selection loop.
      await page.evaluate(() => document.getElementById('privacy-shadow')?.remove()).catch(() => {});
      await clickEnterprise();
    }
    await page.waitForTimeout(1200);
    s = await state();
  }
  logger[s.hasRenting ? 'debug' : 'warn'](
    s,
    s.hasRenting
      ? 'VW business customer type selected (renting families present)'
      : 'VW business switch not confirmed — FinancialRenting absent',
  );
  await page.waitForTimeout(800);

  const findFamily = () =>
    page
      .evaluate(() => {
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
  for (let i = 0; i < 5 && !familyId; i += 1) {
    await page.waitForTimeout(1000);
    familyId = await findFamily();
  }

  let checked = false;
  if (familyId) {
    const isChecked = () =>
      page
        .evaluate(
          (fid) =>
            [...document.querySelectorAll('input[name="financial-pack"]')].some(
              (r) =>
                String(r.getAttribute('data-familyid') || r.value) === String(fid) && r.checked,
            ),
          familyId,
        )
        .catch(() => false);

    // Click the VISIBLE card's HEADER top — the tall VW card's geometric centre
    // lands on the bullet-list body, which doesn't select the product. Poll for
    // the sized card (it renders after the packs reveal + family reload).
    checked = await isChecked();
    for (let attempt = 0; attempt < 8 && !checked; attempt += 1) {
      const box = await page
        .evaluate((fid) => {
          for (const r of document.querySelectorAll('input[name="financial-pack"]')) {
            const id = r.getAttribute('data-familyid') || r.value;
            if (String(id) !== String(fid)) continue;
            const card = r.closest('.card--pack');
            if (!card) continue;
            const header =
              card.querySelector('.card--pack__header__top') ||
              card.querySelector('.card--pack__header') ||
              card;
            const rect = header.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              header.scrollIntoView({ block: 'center' });
              const r2 = header.getBoundingClientRect();
              return { x: r2.x + r2.width / 2, y: r2.y + r2.height / 2 };
            }
          }
          return null;
        }, familyId)
        .catch(() => null);
      if (!box) {
        await page.waitForTimeout(1000);
        continue;
      }
      // The cookie-consent overlay can re-inject between clicks; strip it again so
      // it can't intercept the card click (the root cause of the old "card never
      // selects" symptom).
      await page.evaluate(() => document.getElementById('privacy-shadow')?.remove()).catch(() => {});
      await page.mouse.click(box.x, box.y).catch(() => {});
      await page.waitForTimeout(2000);
      checked = await isChecked();
    }
    logger.info({ familyId, checked }, 'VW selected Financiële Renting product');
  } else {
    logger.warn('VW Financiële Renting radio not found — staying on default product');
  }
  await page.waitForTimeout(2500);
  return checked;
}

// Set the down-payment ("Voorschot"/"Eerste verhoogde huur") to `pct` of the
// vehicle's net price on the live form, then let the form's OWN calculator
// recompute the monthly. We VERIFY the recalc landed by watching the live
// financeApi capture, and re-fill if it didn't. (Port of the Audi helper.)
async function setDownPaymentPct(page, pct, logger, financeApi = []) {
  const probe = () =>
    page
      .evaluate(() => {
        const inputs = [
          ...document.querySelectorAll(
            'input[id^="component-bound-"],input[name^="component-bound-"]',
          ),
        ];
        const isDown = (el) => {
          const near = (
            (el.closest('label') || el.parentElement || {}).innerText || ''
          ).toLowerCase();
          if (/aankoopoptie|option d.achat|purchase|restwaarde|residu/.test(near)) return false;
          const dn = (el.getAttribute('data-name') || '').toLowerCase();
          return (
            /voorschot|eerste verhoogde huur|premier loyer|acompte|aanbetaling/.test(near) ||
            /upfront|firstincreased|downpayment|increasedrent/.test(dn)
          );
        };
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

  const ready = (x) => x.downId && (x.netPriceRaw || parseEur(x.defaultNet));
  let info = await probe();
  for (let i = 0; i < 15 && !ready(info); i += 1) {
    await page.waitForTimeout(1000);
    info = await probe();
  }

  if (!info.downId) {
    logger.warn(info, 'VW down-payment control not found — leaving default');
    return null;
  }
  let netPrice = parseEur(info.netPriceRaw);
  if (!netPrice) {
    const defNet = parseEur(info.defaultNet);
    if (defNet) netPrice = Math.round((defNet / 0.25) * 100) / 100;
  }
  if (!netPrice) {
    logger.warn(info, 'VW net price not found — leaving default down payment');
    return null;
  }
  const amount = Math.round(pct * netPrice * 100) / 100;
  const display = amount.toFixed(2).replace('.', ','); // Belgian decimal comma
  const input = page.locator(`#${info.downId}`);

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
      await input.press('Tab');
    } catch (err) {
      logger.warn(
        { downId: info.downId, err: err.message, fillTry },
        'VW could not fill down-payment input',
      );
      continue;
    }
    for (const rx of [/bereken uw maandelijkse betaling/i, /herbereken/i, /\bbereken\b/i]) {
      const b = page.getByText(rx).first();
      if (await b.count().catch(() => 0)) {
        await b.click().catch(() => {});
        break;
      }
    }
    let verified = false;
    for (let i = 0; i < 12 && !verified; i += 1) {
      await page.waitForTimeout(1000);
      verified = recalcLanded(since);
    }
    if (verified) {
      logger.info(
        {
          downId: info.downId,
          replacedDefault: info.currentDefault,
          netPrice,
          pct,
          amount,
          fillTry,
        },
        'VW down payment applied and recalculation verified',
      );
      return { amount, netPrice, verified: true };
    }
    logger.warn(
      { downId: info.downId, amount, fillTry },
      'VW down recalc not confirmed — retrying fill',
    );
  }
  return { amount, netPrice, verified: false };
}

// Build a { componentId: meaning } map from the form's bound inputs so the
// parser can label the Calculate bounds (which carry only numeric ids).
async function readBoundMeanings(page) {
  return page
    .evaluate(() => {
      const map = {};
      for (const el of document.querySelectorAll(
        'input[id^="component-bound-"],select[id^="component-bound-"]',
      )) {
        const idnum = (el.id.match(/(\d+)$/) || [])[1];
        if (!idnum) continue;
        const near = (
          (el.closest('label') || el.parentElement || {}).innerText || ''
        ).toLowerCase();
        const dn = (el.getAttribute('data-name') || '').toLowerCase();
        let meaning = null;
        if (
          /aankoopoptie|option d.achat|purchase|restwaarde|residu/.test(near) ||
          /purchase|residual/.test(dn)
        )
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

// ---------------------------------------------------------------------------
// Configurator -> CCF mint flow
// ---------------------------------------------------------------------------

// Open one model's configurator summary, click "Bereken mijn maandprijs" (which
// mints a fresh CCF code and opens formsccf.volkswagen.be), drive the
// business-renting selection + down payment, and return the finance-form HTML +
// minted code + captured FinanceApi JSON. Throws if we never land on formsccf so
// the caller can record the reason. (Mirrors Audi's mintFromConfigurator.)
export async function mintFromConfigurator(
  context,
  model,
  { logger, timeoutMs = 90000, downPaymentPct = 0 },
) {
  const page = await context.newPage();

  // Capture every finance-calculation XHR across the whole flow (incl. popups).
  const financeApi = [];
  let recaptchaBlocked = false;
  const onResponse = async (res) => {
    const u = res.url();
    if (!/formsccf\.volkswagen\.be\/ccf\/FinanceApi/i.test(u)) return;
    if (/FinanceApi\/Oops/i.test(u) && /error=Recaptcha/i.test(u)) recaptchaBlocked = true;
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;
    try {
      const json = await res.json();
      let requestBody = null;
      try {
        const raw = res.request().postData();
        requestBody = raw ? JSON.parse(raw) : null;
      } catch {
        requestBody = res.request().postData() || null;
      }
      financeApi.push({
        url: u,
        method: res.request().method(),
        status: res.status(),
        json,
        requestBody,
      });
    } catch {
      /* non-JSON / empty body — ignore */
    }
  };
  context.on('response', onResponse);

  // The finance step loads in a popup (or same tab). A mutable flag lets us
  // re-click the CTA and keep waiting. Listeners detached after to avoid leaks.
  let landed = null;
  const onFrame = (frame) => {
    if (
      !landed &&
      frame === page.mainFrame() &&
      /formsccf\.volkswagen\.be\/ccf/i.test(frame.url())
    ) {
      landed = { page, url: frame.url() };
    }
  };
  const onPage = async (popup) => {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
      if (!landed && /formsccf\.volkswagen\.be\/ccf/i.test(popup.url())) {
        landed = { page: popup, url: popup.url() };
      }
    } catch {
      /* ignore */
    }
  };
  page.on('framenavigated', onFrame);
  context.on('page', onPage);

  logger.info({ model: model.id, url: model.configuratorUrl }, 'VW opening configurator');
  await page.goto(model.configuratorUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForTimeout(4000);

  const title = await page.title().catch(() => '');
  if (/not available|wartungsarbeiten|maintenance/i.test(title)) {
    context.off('response', onResponse);
    await page.close().catch(() => {});
    throw new Error(`VW_SITE_UNAVAILABLE: configurator returned "${title}"`);
  }

  await acceptCookies(page, logger);
  await page.waitForTimeout(2000);

  // Wait for the finance CTA to render.
  const berekenCta = page
    .locator('a, button, [role="button"]')
    .filter({ hasText: /bereken mijn maandprijs/i })
    .first();
  await berekenCta.waitFor({ state: 'visible', timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Click the finance CTA and WAIT for the formsccf navigation. Only re-click
  // after a long wait so we don't fire a second click mid-navigation.
  for (let clickAttempt = 1; clickAttempt <= 3 && !landed; clickAttempt += 1) {
    await berekenCta.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const clicked = await clickVisibleByText(page, /bereken mijn maandprijs/i);
    logger[clicked ? 'info' : 'debug'](
      { model: model.id, clickAttempt },
      clicked ? 'VW clicked Bereken mijn maandprijs' : 'VW Bereken button not clickable',
    );
    for (let i = 0; i < 35 && !landed; i += 1) await page.waitForTimeout(1000);
    if (!landed && clickAttempt < 3) {
      logger.warn({ model: model.id, clickAttempt }, 'VW no formsccf yet — re-clicking CTA');
    }
  }
  page.off('framenavigated', onFrame);
  context.off('page', onPage);

  if (!landed) {
    context.off('response', onResponse);
    await page.close().catch(() => {});
    throw new Error('VW_NO_FORMSCCF: never navigated to formsccf finance form');
  }

  const finalPage = landed.page;
  const finalUrl = landed.url;
  const code = finalUrl.includes('code=') ? new URL(finalUrl).searchParams.get('code') : null;
  logger.info({ model: model.id, finalUrl, code }, 'VW reached finance form');

  let boundMeanings = {};
  let downVerified = false;
  await finalPage.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  // The form often opens in a popup/background tab; bring it to front so it lays
  // out and is interactable before we dismiss its cookie overlay and drive the
  // renting selection.
  await finalPage.bringToFront().catch(() => {});
  await finalPage.waitForTimeout(2000);
  if (!/\/Base\/Oops/i.test(finalUrl)) {
    // CRITICAL: the finance form (formsccf) renders its OWN cookie-consent overlay
    // (`#privacy-shadow`), separate from the configurator's. Until it is dismissed
    // it sits on top of the form and intercepts EVERY real click — the
    // "Professionelen" customer-type toggle and the product cards included — so the
    // business switch silently no-ops, no card is selected, and FinanceApi/Calculate
    // never fires (which previously looked like a reCAPTCHA/render wall but was just
    // this overlay). Accepting cookies on the configurator page does NOT cover this
    // separate page, so we must dismiss it here before driving the selection.
    await acceptCookies(finalPage, logger);
    await finalPage.waitForTimeout(1500);
    await selectBusinessRenting(finalPage, logger).catch((err) =>
      logger.warn({ model: model.id, err: err.message }, 'VW product selection error'),
    );
    await finalPage.waitForTimeout(1500);

    if (downPaymentPct > 0) {
      const set = await setDownPaymentPct(finalPage, downPaymentPct, logger, financeApi).catch(
        (err) => {
          logger.debug({ model: model.id, err: err.message }, 'VW down-payment step failed');
          return null;
        },
      );
      downVerified = !!set?.verified;
    }

    boundMeanings = await readBoundMeanings(finalPage);
    logger.info({ model: model.id, boundMeanings, downVerified }, 'VW bound-component meanings');
  }

  // The finance app re-renders after landing, which can transiently tear down
  // the execution context. Retry content() once.
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
    'VW finance-form captured',
  );
  if (!html) throw new Error('VW_CONTENT_UNREADABLE: finance page closed before HTML captured');
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
