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
// The CCF/milesFinance widget parsing is shared with VW (same D'Ieteren form).
// Re-export the brand-agnostic helpers so this module's public API (and its
// tests) stay unchanged after the extraction.
import {
  htmlToText,
  isOopsPage,
  hasCalculation,
  detectVatBasis,
  matchAmount,
  mapBounds,
  extractFromFinanceApi,
} from '../shared/ccf-parser.js';

export { htmlToText, isOopsPage, hasCalculation, detectVatBasis, mapBounds, extractFromFinanceApi };

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
  const m = text.match(/Totale prijs\s*:?\s*€\s*([\d .,]+?)\s*€\s*([\d .,]+?)\s*Excl\.?\s*BTW/i);
  if (m) return { gross: parseEur(m[1]), net: parseEur(m[2]) };
  // Fallback: "€ X (BTW incl.) € Y (excl. BTW)" wording in the spec line.
  const m2 = text.match(/€\s*([\d .,]+)\s*\(BTW incl\.?\)\s*€\s*([\d .,]+)\s*\(excl\.?\s*BTW\)/i);
  if (m2) return { gross: parseEur(m2[1]), net: parseEur(m2[2]) };
  return { gross: null, net: null };
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
