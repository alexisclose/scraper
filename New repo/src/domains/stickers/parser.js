// Price extraction — the brand-agnostic core of the sticker-price scraper.
//
// Given a chunk of text (from the DOM, or from OCR over an image / video
// frame), find every advertised euro amount and classify it. This is a pure
// function with no I/O so it's cheap to unit-test against the messy strings
// OCR actually emits ("vanaf €39.990" but also "€ 39 .990" or "EUR399 /maand").
//
// We deliberately require a euro indicator (€ / EUR / "euro") adjacent to the
// number. Sticker prices always carry one, and the alternative — treating any
// bare number as a price — turns model years, horsepower, and "0% APR" into
// false positives, which is far worse over noisy OCR text.
import { parseEur } from '../../libraries/currency/parse.js';

// U+00A0 non-breaking space — used as a thousands gap by several brand sites
// and emitted by OCR. Expressed via escape so source stays plain ASCII.
const NBSP_RE = new RegExp(' ', 'g');

// A Belgian-formatted amount: 1–3 leading digits, dot/space thousands groups,
// optional ",dd" decimals — or a plain run of digits with optional decimals.
// OCR sometimes inserts stray spaces inside the thousands group, so we tolerate
// a space as a group separator too and let parseEur sort it out.
const AMOUNT = String.raw`\d{1,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?`;

// Euro indicator. Tesseract very often misreads "€" as "£" or "¢" on stylised
// marketing type, so we accept those glyphs as euro too — safe on Belgian car
// pages, where no genuine pound/cent prices appear.
const EURO = String.raw`€|£|¢|\bEUR\b`;

// A bare capital "E" is the other common "€" misread (seen in video frames:
// "Vanaf E 599"). That's far riskier — "E" appears in plates, model names, etc.
// — so we only accept it when it stands alone (not preceded by a letter) AND is
// followed by a *space* before the number. The required space rules out plates
// like "E1510" and words like "THE"/"BE".
const PRICE_RE = new RegExp(
  String.raw`(?:${EURO})\s*(${AMOUNT})` + // €399 / £399 / EUR 399  → group 1
    String.raw`|(?<![A-Za-z])E\s(${AMOUNT})` + // "E 599" (misread €)     → group 2
    String.raw`|(${AMOUNT})\s*(?:${EURO}|\beuro\b)`, // 399€ / 399 EUR    → group 3
  'gi',
);

// Context keyword groups (Dutch + French — Belgium is bilingual). The "/" in
// "/maand" is frequently mis-OCR'd as I, l, 1 or |, so the monthly separator is
// optional and we treat the bare word "maand"/"mnd"/"mois" as a monthly signal.
// "maand?" (optional trailing d) because OCR routinely drops the final letter
// ("per maand" → "er maan"); same generosity for the misread "/".
const MONTHLY_RE =
  /(?:[/Il1|]\s?)?(?:maand?|mnd|mois)\b|p\.?\s?m\.?|per\s+maand?|maandelijks|par\s+mois/i;
const DISCOUNT_RE = /voordeel|korting|bespaar|avantage|remise|économ|\btot\b|jusqu/i;
const DEPOSIT_RE = /voorschot|acompte|eerste\s+(?:huur|storting)|premier\s+loyer|aanbetaling/i;
const CASH_RE = /vanaf|à\s+partir|d[eè]s|catalogus|prijs|prix|nu\s+(?:al|voor)|adviesprijs/i;

// Classification is proximity-based: the keyword whose match sits *closest* to
// the amount wins, so a far-off "Voordeel tot" in the same banner can't hijack
// a "€ 39.990 vanaf". Ties break by this priority order.
const CATEGORIES = [
  ['monthly', MONTHLY_RE],
  ['cash', CASH_RE],
  ['discount', DISCOUNT_RE],
  ['deposit', DEPOSIT_RE],
];
const PRIORITY = { monthly: 0, cash: 1, discount: 2, deposit: 3, unknown: 4 };

// Plausibility bounds so OCR garbage ("€ 0,01", a misread "€ 1.299.000.000")
// doesn't pollute the output. Monthly payments and outright prices live in
// very different ranges.
const BOUNDS = {
  monthly: [20, 9999],
  deposit: [100, 200000],
  discount: [50, 200000],
  cash: [1000, 1000000],
  unknown: [20, 1000000],
};

// Pick the category whose keyword match is nearest to the amount within a
// window of `region`. `center` is the amount's offset inside `region`.
function classify(region, center) {
  let best = { kind: 'unknown', dist: Infinity };
  for (const [kind, re] of CATEGORIES) {
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let mm;
    while ((mm = scan.exec(region)) !== null) {
      const dist = Math.abs(mm.index - center);
      if (dist < best.dist || (dist === best.dist && PRIORITY[kind] < PRIORITY[best.kind])) {
        best = { kind, dist };
      }
      if (mm.index === scan.lastIndex) scan.lastIndex += 1; // avoid zero-width loop
    }
  }
  return best.kind;
}

function inBounds(kind, amount) {
  const [lo, hi] = BOUNDS[kind] || BOUNDS.unknown;
  return amount >= lo && amount <= hi;
}

/**
 * Extract every euro price from a blob of text.
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.window=28] chars of context to read on each side
 * @returns {Array<{amount:number,currency:'EUR',kind:string,unit:string,raw:string,context:string}>}
 */
export function extractPrices(text, { window = 28 } = {}) {
  if (!text || typeof text !== 'string') return [];
  // Normalise NBSP and collapse runs of whitespace so the context windows and
  // keyword regexes see consistent input.
  const norm = text.replace(NBSP_RE, ' ').replace(/[ \t]+/g, ' ');

  const out = [];
  const seen = new Set();
  PRICE_RE.lastIndex = 0;
  let m;
  while ((m = PRICE_RE.exec(norm)) !== null) {
    const rawAmount = m[1] ?? m[2] ?? m[3];
    const amount = parseEur(rawAmount);
    if (amount == null || amount <= 0) continue;

    const ctxStart = Math.max(0, m.index - window);
    const ctxEnd = Math.min(norm.length, m.index + m[0].length + window);
    const region = norm.slice(ctxStart, ctxEnd);
    const ctx = region.trim();

    let kind = classify(region, m.index - ctxStart);

    // Reconciliation: a "from"/catalogue price (`cash`) below the cash floor
    // can't be a car's purchase price — it's a monthly rate whose "/maand" the
    // OCR lost (common on video frames: "Vanaf € 599 [per maan]d"). Promote it
    // rather than drop it, but only above €100 so truncated junk ("€ 47") still
    // falls away.
    if (kind === 'cash' && amount < BOUNDS.cash[0] && amount >= 100) {
      kind = 'monthly';
    }
    if (!inBounds(kind, amount)) continue;

    // Dedup on (kind, amount) — the same banner often repeats a price.
    const key = `${kind}:${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      amount,
      currency: 'EUR',
      kind,
      unit: kind === 'monthly' ? 'per_month' : 'total',
      raw: m[0].trim(),
      context: ctx,
    });
  }
  return out;
}
