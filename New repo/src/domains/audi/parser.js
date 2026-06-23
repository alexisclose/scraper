// Pure parser for the D'Ieteren CCF finance form served at
// formsccf.audi.be/ccf/nl/finance/formulastep?code=<code>.
//
// WHAT THE PAGE ACTUALLY EXPOSES (verified against a live minted code):
//   • Server-rendered HTML reliably contains the MODEL and the TOTAL VEHICLE
//     PRICE, quoted both incl. BTW (gross) and excl. BTW (net) — explicitly
//     labelled, so no VAT guessing is needed for the price.
//   • The MONTHLY / term / down-payment / residual are NOT in the HTML. They are
//     computed by the milesFinance JS via /ccf/FinanceApi/GetComponentList,
//     which is **reCAPTCHA-protected**: automated requests get an empty result
//     and a redirect to FinanceApi/Oops?error=Recaptcha. The static page marks
//     this with data-has-calculation-information="False". We therefore do NOT
//     fabricate those figures — they stay null unless a real calculation block
//     is present (data-has-calculation-information="True"), and we never try to
//     defeat the reCAPTCHA.
//
// So an Audi CCF record is honestly: model + gross/net catalogue price, with the
// renting figures null when the calculator is gated. The label regexes for the
// (rare) calculated case live in configs/brands/audi.json and degrade to null.
import { parseEur } from '../../libraries/currency/parse.js';
import { netToGross, grossToNet } from '../../libraries/finance/btw.js';
import { deriveFinancials } from '../../libraries/finance/irr.js';
import { ParseError } from '../../libraries/error-handling/AppError.js';

// Flatten HTML to a single whitespace-collapsed, entity-decoded string, used by
// the value regexes so they don't trip over markup between a label and a value.
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&euro;/g, '€')
    .replace(/&amp;/g, '&')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&eacute;/g, 'é')
    .replace(/&euml;/g, 'ë')
    .replace(/\s+/g, ' ')
    .trim();
}

// True when the response is the branded error page rather than a real offer.
export function isOopsPage({ html, url }) {
  if (url && /\/Base\/Oops/i.test(url)) return true;
  return /Oeps,\s*er is een fout/i.test(html || '');
}

// Does the server-rendered page carry a real finance calculation? When this is
// false the monthly/term/residual are simply not present (reCAPTCHA-gated calc).
export function hasCalculation(html) {
  return /data-has-calculation-information="True"/i.test(html || '');
}

// Extract model name from the CCF finance header. The page splits it into a
// "brand" line (e.g. "A3 Sportback") and a technical line (e.g. "Attraction
// TFSI 85 kW 6 vitesses"). Prefer the passed-in model when we have one.
export function parseModel(html, model) {
  const brand = html.match(/prices__top__text__brand[^>]*>\s*([^<]+?)\s*</i)?.[1] || null;
  const tech = html.match(/__info__technical[^>]*>\s*([^<]+?)\s*</i)?.[1] || null;
  const fromPage = [brand, tech].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (model?.displayName) return { modelName: model.displayName, modelRange: model.range ?? brand };
  if (fromPage) return { modelName: `Audi ${fromPage}`, modelRange: brand };
  return { modelName: 'Audi', modelRange: null };
}

// Extract the catalogue/total price. The form prints it as
//   "Totale prijs : € 32 429,99   € 26 801,65 Excl. BTW"
// where the FIRST amount is incl. BTW (gross) and the SECOND is excl. BTW (net).
// Both labels are explicit, so we read them directly instead of guessing.
export function parseTotalPrice(text) {
  const m = text.match(
    /Totale prijs\s*:?\s*€\s*([\d .,]+?)\s*€\s*([\d .,]+?)\s*Excl\.?\s*BTW/i,
  );
  if (m) return { gross: parseEur(m[1]), net: parseEur(m[2]) };
  // Fallback: "€ X (BTW incl.) € Y (excl. BTW)" wording in the spec line.
  const m2 = text.match(
    /€\s*([\d .,]+)\s*\(BTW incl\.?\)\s*€\s*([\d .,]+)\s*\(excl\.?\s*BTW\)/i,
  );
  if (m2) return { gross: parseEur(m2[1]), net: parseEur(m2[2]) };
  return { gross: null, net: null };
}

// Look at the wording around a matched amount to decide whether it is quoted
// incl. BTW (gross) or excl. BTW (net). The marker NEAREST the amount wins.
export function detectVatBasis(text, matchIndex, window = 80) {
  if (matchIndex == null || matchIndex < 0) return null;
  const start = Math.max(0, matchIndex - window);
  const slice = text.slice(start, matchIndex + window).toLowerCase();
  const rel = matchIndex - start;
  const NET_RE = /excl\.?\s*btw|exclusief btw|zonder btw|netto/g;
  const GROSS_RE = /incl\.?\s*btw|inclusief btw|met btw|bruto/g;
  const nearest = (re) => {
    let best = Infinity;
    let m;
    while ((m = re.exec(slice))) best = Math.min(best, Math.abs(m.index - rel));
    return best;
  };
  const net = nearest(NET_RE);
  const gross = nearest(GROSS_RE);
  if (net === Infinity && gross === Infinity) return null;
  return net <= gross ? 'net' : 'gross';
}

function matchAmount(text, pattern) {
  if (!pattern) return { value: null, index: -1 };
  const m = text.match(new RegExp(pattern, 'i'));
  if (!m) return { value: null, index: -1 };
  return { value: parseEur(m[1] ?? m[2]), index: m.index };
}

// ---- FinanceApi JSON extraction --------------------------------------------
// The monthly/term/down-payment/residual are computed by the milesFinance JS
// via /ccf/FinanceApi/* and returned as JSON (captured by the browser fetcher
// when the reCAPTCHA score allows). We have NOT yet observed a successful
// response shape, so this scan is heuristic AND sanity-checked: it only accepts
// values inside plausible ranges and returns null otherwise. The fetcher always
// dumps the raw JSON to data/cache/audi so the exact keys can be pinned after
// the first un-gated run — at which point this can be replaced with a precise
// field map. Never returns an implausible number.
const RANGES = {
  monthly: [40, 20000],
  term: [6, 120],
  down: [0, 300000],
  residual: [0, 400000],
};
const KEY = {
  // "monthly" not bare "month" — otherwise "durationMonths" (a term field) would
  // be misread as the monthly payment.
  monthly: /(monthly|mensual|montant.*mois|\bmaand|\bmnd\b|per[\s_-]?month|rent.*amount)/i,
  term: /(duration|dur[ée]e|looptijd|\bterm\b|months|maanden|periode|nbpay|payments)/i,
  down: /(down\s*payment|acompte|voorschot|first\s*payment|initial|advance|aanbetaling)/i,
  residual: /(residual|r[ée]sidu|\brest|balloon|purchase\s*option|option.*achat|rachat|aankoopoptie)/i,
  pct: /(rate|taux|percent|pct|taeg|jkp|interest)/i,
};

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return parseEur(v);
  return null;
}
const inRange = (n, [lo, hi]) => n != null && n >= lo && n <= hi;

// Walk the JSON; for every object node, read any directly-keyed figures that
// match a category and fall in range. Score the node for how "business renting"
// it looks, and keep the best-scoring node that carries a monthly.
function scanFinanceNode(json) {
  let best = null;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);

    const flat = JSON.stringify(node).toLowerCase();
    let score = 0;
    if (/renting/.test(flat)) score += 2;
    if (/business|profession|zakelijk/.test(flat)) score += 2;
    if (/lease|leasing/.test(flat)) score += 1;

    const pick = (re, range) => {
      for (const [k, v] of Object.entries(node)) {
        if (re.test(k)) {
          const n = toNumber(v);
          if (inRange(n, range)) return n;
        }
      }
      return null;
    };
    const monthly = pick(KEY.monthly, RANGES.monthly);
    if (monthly != null) {
      const cand = {
        score,
        monthly,
        term: pick(KEY.term, RANGES.term),
        down: pick(KEY.down, RANGES.down),
        residual: pick(KEY.residual, RANGES.residual),
        // percentage fields are 0–100 in JSON; normalise to a fraction
        pct: (() => {
          for (const [k, v] of Object.entries(node)) {
            if (KEY.pct.test(k)) {
              const n = toNumber(v);
              if (n != null && n > 0 && n < 100) return n / 100;
            }
          }
          return null;
        })(),
        productName:
          Object.entries(node).find(([k]) => /name|label|title|product|libell/i.test(k))?.[1] ||
          null,
      };
      if (!best || cand.score > best.score) best = cand;
    }
    Object.values(node).forEach(visit);
  };
  visit(json);
  return best;
}

// Map the Calculate request's `bounds` array to down-payment / residual / term /
// annual mileage. The bounds carry only a numeric componentId + value, so we
// prefer an explicit { componentId: meaning } map captured from the form (the
// down "Eerste verhoogde huur" and residual "Aankoopoptie" both default to 25%
// and are indistinguishable by value). For any bound the map doesn't cover we
// fall back to value ranges: a 6–120 integer is the term, a ≥3000 value is the
// annual mileage, and the remainder is the down payment.
export function mapBounds(bounds, meanings = {}) {
  if (!Array.isArray(bounds) || !bounds.length) return {};
  const parsed = bounds.map((b) => ({ id: String(b && b.componentId), v: toNumber(b && b.value) }));
  let down = null;
  let residual = null;
  let term = null;
  let annualMileage = null;
  const leftover = [];
  for (const b of parsed) {
    const m = meanings[b.id];
    if (m === 'down') down = b.v;
    else if (m === 'residual') residual = b.v;
    else if (m === 'term') term = b.v;
    else if (m === 'mileage') annualMileage = b.v;
    else leftover.push(b.v);
  }
  for (const n of leftover) {
    if (n == null) continue;
    if (term == null && Number.isInteger(n) && n >= 6 && n <= 120) term = n;
    else if (annualMileage == null && n >= 3000) annualMileage = n;
    else if (down == null) down = n;
  }
  return { down, residual, term, annualMileage };
}

// Public: reduce captured FinanceApi responses to a normalised renting figure
// set, or null. Returns { monthlyNet, monthlyGross, downNet, term, annualMileage,
// residualNet, residualPct, source }.
//
// Verified shapes (configurator-originated session, reCAPTCHA passed):
//   POST /ccf/FinanceApi/Calculate?lg=nl
//     response → { PriceVatExcluded:"528,36", PriceVatIncluded:"630,84",
//                  BalloonRate:null, Success:true }  (monthly, both VAT bases)
//     request  → { FamilyId, Code, bounds:[down, term, mileage], Token }
//   The monthly comes from the response; term/mileage/down from the *request*
//   body the fetcher captures alongside it. GetComponentList returns only
//   component ids (no amounts).
export function extractFromFinanceApi(responses, { logger, boundMeanings } = {}) {
  const log = logger || { debug() {}, info() {} };
  const list = responses || [];

  // Precise path: the most recent successful Calculate response (+ its request).
  const calc = [...list]
    .reverse()
    .find((r) => /FinanceApi\/Calculate/i.test(r.url || '') && r.json && r.json.Success);
  if (calc) {
    const net = parseEur(calc.json.PriceVatExcluded);
    const gross = parseEur(calc.json.PriceVatIncluded);
    if (net != null || gross != null) {
      const balloon = calc.json.BalloonRate;
      const residualPct =
        balloon != null && balloon !== ''
          ? parseFloat(String(balloon).replace(',', '.')) / 100
          : null;
      const bounds =
        calc.requestBody && typeof calc.requestBody === 'object'
          ? mapBounds(calc.requestBody.bounds, boundMeanings || {})
          : {};
      const figures = {
        monthlyNet: net,
        monthlyGross: gross,
        downNet: bounds.down ?? null,
        term: bounds.term ?? null,
        annualMileage: bounds.annualMileage ?? null,
        residualNet: bounds.residual ?? null,
        residualPct,
        source: 'calculate',
      };
      log.info(figures, 'Audi monthly+terms extracted from FinanceApi/Calculate');
      return figures;
    }
  }

  // Fallback: heuristic deep scan for an as-yet-unseen response shape. Sanity-
  // checked; assumes excl.-BTW basis (caller derives gross).
  let best = null;
  for (const r of list) {
    const cand = scanFinanceNode(r.json);
    if (cand && (!best || cand.score > best.score)) best = cand;
  }
  if (!best) return null;
  log.info(
    { monthly: best.monthly, term: best.term, score: best.score },
    'Audi finance figures extracted from FinanceApi JSON (heuristic — verify against raw dump)',
  );
  return {
    monthlyNet: best.monthly,
    monthlyGross: best.monthly != null ? netToGross(best.monthly) : null,
    downNet: best.down,
    term: best.term,
    annualMileage: null,
    residualNet: best.residual,
    residualPct: best.pct,
    source: 'heuristic',
  };
}

export function parseAudiOffer({
  html,
  url,
  code,
  model,
  brandConfig,
  scrapedAt,
  logger,
  financeApi,
  boundMeanings,
}) {
  const log = logger || { debug() {}, info() {}, warn() {} };

  if (isOopsPage({ html, url })) {
    throw new ParseError('Audi CCF returned the Oops error page (code expired/invalid)', {
      code: 'AUDI_OOPS',
      context: { code, url },
    });
  }

  const text = htmlToText(html);
  const L = brandConfig.labels || {};
  const { modelName, modelRange } = parseModel(html, model);
  const price = parseTotalPrice(text);
  const calcReady = hasCalculation(html);

  // Renting figures only exist when a real calculation is rendered. With the
  // reCAPTCHA-gated calculator that is normally false for automated fetches, so
  // we keep these null rather than match stray numbers elsewhere on the page.
  let monthlyNet = null;
  let monthlyGross = null;
  let downPaymentNet = null;
  let downPaymentGross = null;
  let termMonths = null;
  let annualMileage = null;
  let contractMileage = null;
  let residualValueNet = null;
  let residualValuePct = null;
  let figureSource = null;

  // Preferred source: the FinanceApi JSON captured by the browser fetcher (the
  // real milesFinance calculation output). The HTML calc block is the fallback
  // for the rare case the figures are server-rendered but no JSON was captured.
  const apiFigures = extractFromFinanceApi(financeApi, { logger: log, boundMeanings });

  if (apiFigures) {
    figureSource = `finance-api:${apiFigures.source}`;
    // The Calculate endpoint gives both VAT bases explicitly; the heuristic
    // fallback already derived gross from a net assumption. Either way both
    // sides arrive populated here.
    monthlyNet = apiFigures.monthlyNet ?? null;
    monthlyGross = apiFigures.monthlyGross ?? (monthlyNet != null ? netToGross(monthlyNet) : null);
    if (apiFigures.downNet != null) {
      downPaymentNet = apiFigures.downNet;
      downPaymentGross = netToGross(apiFigures.downNet);
    }
    termMonths = apiFigures.term ?? null;
    // The Calculate request quotes mileage per YEAR; contract mileage is the
    // annual figure across the full term.
    annualMileage = apiFigures.annualMileage ?? null;
    contractMileage =
      annualMileage != null && termMonths ? Math.round((annualMileage * termMonths) / 12) : null;
    residualValueNet = apiFigures.residualNet ?? null;
    residualValuePct = apiFigures.residualPct ?? null;
    log.info(
      { code, source: apiFigures.source, term: termMonths, annualMileage, downNet: downPaymentNet },
      'Audi renting figures sourced from FinanceApi JSON',
    );
  } else if (calcReady) {
    figureSource = 'html-calc';
    const monthly = matchAmount(text, L.monthly);
    if (monthly.value != null) {
      const basis = detectVatBasis(text, monthly.index) || 'net';
      if (basis === 'gross') {
        monthlyGross = monthly.value;
        monthlyNet = grossToNet(monthly.value);
      } else {
        monthlyNet = monthly.value;
        monthlyGross = netToGross(monthly.value);
      }
    }
    const dp = matchAmount(text, L.downPayment);
    if (dp.value != null) {
      const basis = detectVatBasis(text, dp.index) || 'net';
      downPaymentNet = basis === 'gross' ? grossToNet(dp.value) : dp.value;
      downPaymentGross = basis === 'gross' ? dp.value : netToGross(dp.value);
    }
    const termMatch = L.term ? text.match(new RegExp(L.term, 'i')) : null;
    termMonths = termMatch ? parseInt(termMatch[1], 10) : null;
    const kmMatch = L.mileage ? text.match(new RegExp(L.mileage, 'i')) : null;
    contractMileage = kmMatch ? parseInt(kmMatch[1].replace(/[.\s]/g, ''), 10) : null;
    annualMileage =
      contractMileage && termMonths ? Math.round((contractMileage / termMonths) * 12) : null;
    if (L.residual) {
      const rm = text.match(new RegExp(L.residual, 'i'));
      if (rm?.[1] != null) residualValueNet = parseEur(rm[1]);
      if (rm?.[2] != null) residualValuePct = parseFloat(rm[2].replace(',', '.')) / 100;
    }
  } else {
    log.info(
      {
        code,
        reason:
          'no FinanceApi JSON captured and data-has-calculation-information=False (reCAPTCHA-gated calculator)',
      },
      'Audi finance calculation not present — renting figures left null',
    );
  }

  log.info(
    {
      code,
      modelName,
      vehiclePriceGross: price.gross,
      vehiclePriceNet: price.net,
      figureSource,
      monthlyNet,
      downPaymentNet,
      termMonths,
      contractMileage,
      residualValueNet,
    },
    'Audi parse extracted',
  );

  // An Audi record needs at least a model + a vehicle price (the reliably
  // scrapeable data). Without any price AND no monthly, there is nothing useful.
  if (price.gross == null && price.net == null && monthlyNet == null) {
    throw new ParseError('Audi finance form had no vehicle price or monthly', {
      code: 'AUDI_NO_DATA',
      context: { code, url, sample: text.slice(0, 300) },
    });
  }

  const derived = deriveFinancials({
    vehiclePriceNet: price.net,
    monthlyNet,
    downPaymentNet,
    termMonths,
    residualValueNet,
    residualValuePct,
  });

  return {
    brand: 'audi',
    url,
    slug: code || model?.id || null,
    modelName,
    modelRange: modelRange ?? null,
    modelCode: code ?? model?.id ?? null,
    scrapedAt,
    financialRenting: {
      productName: brandConfig.productName,
      productId: brandConfig.productId,
      customerType: 'BUSINESS',
      productType: 'LEASE',
      vehiclePriceNet: price.net,
      vehiclePriceGross: price.gross ?? (price.net != null ? netToGross(price.net) : null),
      monthlyNet,
      monthlyGross,
      downPaymentNet,
      downPaymentGross,
      downPaymentPct: derived.downPaymentPct,
      termMonths,
      annualMileage,
      contractMileage,
      interestEffective: derived.interestEffective,
      residualValueNet: derived.residualValueNet,
      residualValuePct: derived.residualValuePct,
      sumOfAllPaymentsNet: derived.sumOfAllPaymentsNet,
      sumOfAllPaymentsGross:
        derived.sumOfAllPaymentsNet != null ? netToGross(derived.sumOfAllPaymentsNet) : null,
    },
  };
}
