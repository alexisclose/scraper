// Pure parser for the static HTML returned by Volkswagen Belgium's offers
// pages. Importable from tests against fixtures.
import { parseEur } from '../../libraries/currency/parse.js';
import { netToGross } from '../../libraries/finance/btw.js';
import { deriveFinancials } from '../../libraries/finance/irr.js';
import { ParseError } from '../../libraries/error-handling/AppError.js';

// Headline price ("Financiële Renting vanaf €&nbsp;435 / maand") is shown net.
const HEADER_RE =
  /Financi[eë]le Renting vanaf[\s\S]{0,400}?<span class="price_currency">&euro;<\/span>&nbsp;([\d.,]+)\s*&nbsp;\/&nbsp;<span class="price_period">maand/i;

const VISIBLE_CATALOG_RE =
  /Aanbevolen catalogusprijs[\s\S]{0,400}?<span class="price_currency">&euro;<\/span>&nbsp;([\d.,]+)/i;

const LEGAL_DIV_OPEN = (idAttr) => `<div id="${idAttr}" uk-modal>`;

// Extract the text inside <div id="legal-mention-monthly" uk-modal>…</div>,
// flattening to a whitespace-collapsed string. Tracks <div> nesting so we
// don't truncate at the first inner closer.
export function extractModal(html, idAttr) {
  const tag = LEGAL_DIV_OPEN(idAttr);
  const start = html.indexOf(tag);
  if (start < 0) return '';
  let depth = 0;
  let end = start;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = start;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    } else {
      depth += 1;
    }
  }
  return html
    .slice(start, end)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&euro;/g, '€')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function findLegalText(html) {
  const primary = extractModal(html, 'legal-mention-monthly');
  if (primary) return primary;
  // Fallback: scan every legal-mention-* modal for one with both signatures.
  const ids = [
    ...new Set(
      [...html.matchAll(/<div\s+id="(legal-mention-[^"]+)"\s+uk-modal/gi)].map((m) => m[1]),
    ),
  ];
  for (const id of ids) {
    const t = extractModal(html, id);
    if (/Financi[eë]le Renting/i.test(t) && /Aanbevolen catalogusprijs/i.test(t)) return t;
  }
  return '';
}

function deriveTrimName(legalText, slug) {
  const m = legalText.match(
    /Volkswagen[\s\S]+?(?=\s*(?:Aanbevolen catalogusprijs|Huurprijs|excl\. BTW|Offerte))/i,
  );
  let trim = m ? m[0].replace(/[.\s]+$/, '').trim() : null;
  // VW's spec sometimes drops the model word (Amarok appears as
  // "Volkswagen STYLE Double Cabine ..."). Insert the slug's leading model
  // token if it's missing from the trim string.
  const slugFirst = (slug || '').split('-')[0];
  const slugCore = (slugFirst.match(/^[a-z]+\d*/) || [''])[0];
  const norm = trim?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
  if (trim && slugCore && !norm.includes(slugCore)) {
    const word = slugCore.toUpperCase().replace(/^([A-Z]+)(\d*)$/, (_, a, b) =>
      a.length <= 2 ? a + b : a.charAt(0) + a.slice(1).toLowerCase() + b,
    );
    trim = trim.replace(/^Volkswagen/i, `Volkswagen ${word}`);
  }
  if (!trim) {
    trim =
      'Volkswagen ' +
      (slug || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return trim;
}

export function parseVwOffer({ html, url, slug, brandConfig, scrapedAt }) {
  const headerMatch = html.match(HEADER_RE);
  const monthlyNet = headerMatch ? parseEur(headerMatch[1]) : null;
  const legalText = findLegalText(html);

  let vehiclePriceNet = null;
  const cat = legalText.match(/catalogusprijs\s*excl\.?\s*BTW[:\s]*€?\s*([\d.,]+)/i);
  if (cat) vehiclePriceNet = parseEur(cat[1]);
  // VW occasionally truncates the catalogue price in the legal text (e.g. Tayron
  // renders it as "€ 44."). When the legal value is missing or implausibly small
  // for a car, fall back to the visible summary price.
  if (vehiclePriceNet == null || vehiclePriceNet < 1000) {
    const visible = html.match(VISIBLE_CATALOG_RE);
    const v = visible ? parseEur(visible[1]) : null;
    if (v != null && v >= 1000) vehiclePriceNet = v;
  }

  const trimName = deriveTrimName(legalText, slug);

  const termMatch = legalText.match(/(\d{2,3})\s*maand/i);
  const kmMatch = legalText.match(/([\d.,]+)\s*kilometer/i);
  const dpMatch = legalText.match(/eerste\s+verhoogde\s+huurprijs[\s\S]{0,80}?€\s*([\d.,]+)/i);
  const rvMatch = legalText.match(/aankoopoptie\s+van\s+(\d+(?:[.,]\d+)?)\s*%/i);
  const bmMatch = legalText.match(/bonus[- ]?malus[\s\S]{0,30}?(\d+)/i);

  const termMonths = termMatch ? parseInt(termMatch[1], 10) : null;
  const contractMileage = kmMatch ? parseInt(kmMatch[1].replace(/[.,]/g, ''), 10) : null;
  const downPaymentNet = dpMatch ? parseEur(dpMatch[1]) : null;
  const residualValuePct = rvMatch
    ? parseFloat(rvMatch[1].replace(',', '.')) / 100
    : null;

  if (!monthlyNet && !vehiclePriceNet && !legalText) {
    throw new ParseError('No offer block on VW page', {
      code: 'VW_NO_OFFER',
      context: { slug, url },
    });
  }

  const derived = deriveFinancials({
    vehiclePriceNet,
    monthlyNet,
    downPaymentNet,
    termMonths,
    residualValuePct,
  });

  return {
    brand: 'vw',
    url,
    slug,
    modelName: trimName,
    modelRange: null,
    modelCode: slug,
    bonusMalus: bmMatch ? parseInt(bmMatch[1], 10) : null,
    scrapedAt,
    financialRenting: {
      productName: brandConfig.productName,
      productId: brandConfig.productId,
      customerType: 'BUSINESS',
      productType: 'LEASE',
      vehiclePriceNet,
      vehiclePriceGross: netToGross(vehiclePriceNet),
      monthlyNet,
      monthlyGross: netToGross(monthlyNet),
      downPaymentNet,
      downPaymentGross: netToGross(downPaymentNet),
      downPaymentPct: derived.downPaymentPct,
      termMonths,
      annualMileage:
        contractMileage && termMonths ? Math.round((contractMileage / termMonths) * 12) : null,
      contractMileage,
      interestEffective: derived.interestEffective,
      residualValueNet: derived.residualValueNet,
      residualValuePct,
      sumOfAllPaymentsNet: derived.sumOfAllPaymentsNet,
      sumOfAllPaymentsGross:
        derived.sumOfAllPaymentsNet != null ? netToGross(derived.sumOfAllPaymentsNet) : null,
    },
  };
}
