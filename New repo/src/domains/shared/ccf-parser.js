// Brand-agnostic helpers for parsing the D'Ieteren CCF finance form (the
// milesFinance widget served at formsccf.<brand>.be/ccf/...). Audi and VW share
// the exact same widget, so these live here and both domain parsers import them.
// Only the page-chrome bits that genuinely differ between brands — the model
// header markup and the catalogue-price wording — stay in each domain's parser.
import { parseEur } from '../../libraries/currency/parse.js';
import { netToGross } from '../../libraries/finance/btw.js';

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

// Does the server-rendered page carry a real finance calculation? When false the
// monthly/term/residual are simply not present (reCAPTCHA-gated calc).
export function hasCalculation(html) {
  return /data-has-calculation-information="True"/i.test(html || '');
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

export function matchAmount(text, pattern) {
  if (!pattern) return { value: null, index: -1 };
  const m = text.match(new RegExp(pattern, 'i'));
  if (!m) return { value: null, index: -1 };
  return { value: parseEur(m[1] ?? m[2]), index: m.index };
}

// ---- FinanceApi JSON extraction --------------------------------------------
const RANGES = {
  monthly: [40, 20000],
  term: [6, 120],
  down: [0, 300000],
  residual: [0, 400000],
};
const KEY = {
  monthly: /(monthly|mensual|montant.*mois|\bmaand|\bmnd\b|per[\s_-]?month|rent.*amount)/i,
  term: /(duration|dur[ée]e|looptijd|\bterm\b|months|maanden|periode|nbpay|payments)/i,
  down: /(down\s*payment|acompte|voorschot|first\s*payment|initial|advance|aanbetaling)/i,
  residual:
    /(residual|r[ée]sidu|\brest|balloon|purchase\s*option|option.*achat|rachat|aankoopoptie)/i,
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
// fall back to value ranges.
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
//   body the fetcher captures alongside it.
export function extractFromFinanceApi(responses, { logger, boundMeanings, downAmount } = {}) {
  const log = logger || { debug() {}, info() {} };
  const list = responses || [];

  // Successful Calculate responses, most-recent first.
  const successful = [...list]
    .reverse()
    .filter((r) => /FinanceApi\/Calculate/i.test(r.url || '') && r.json && r.json.Success);
  // When a target down payment is known, prefer the MOST RECENT Calculate whose
  // request bounds actually carry that amount — so monthly/term/mileage/residual
  // all come from the SAME confirmed-down calculation, never the default-down one
  // that fires automatically when the product card is first selected. Tolerance
  // mirrors the fetcher's own recalc check (€1), widened slightly for rounding.
  const matchesDown = (r) => {
    if (downAmount == null || !Array.isArray(r.requestBody?.bounds)) return false;
    const tol = Math.max(2, Math.abs(downAmount) * 0.01);
    return r.requestBody.bounds.some((b) => {
      const v = parseEur(b && b.value);
      return v != null && Math.abs(v - downAmount) <= tol;
    });
  };
  const calc = (downAmount != null && successful.find(matchesDown)) || successful[0] || null;
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
      log.info(figures, 'CCF monthly+terms extracted from FinanceApi/Calculate');
      return figures;
    }
  }

  let best = null;
  for (const r of list) {
    const cand = scanFinanceNode(r.json);
    if (cand && (!best || cand.score > best.score)) best = cand;
  }
  if (!best) return null;
  log.info(
    { monthly: best.monthly, term: best.term, score: best.score },
    'CCF finance figures extracted from FinanceApi JSON (heuristic — verify against raw dump)',
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
