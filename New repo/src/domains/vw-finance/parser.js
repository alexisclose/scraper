// Pure parser for the D'Ieteren CCF finance form served at
// formsccf.volkswagen.be/ccf/nl/finance/formulastep?code=<code>.
//
// This is the SAME milesFinance widget as Audi's, so the heavy lifting (HTML
// flattening, Oops detection, VAT-basis sniffing, FinanceApi/Calculate JSON
// extraction, bound mapping) is shared via ../shared/ccf-parser.js. Only two
// things genuinely differ from Audi and live here:
//   • the model header markup → VW prints "ID.4" + "Pure Business 58 kWh …"
//   • the catalogue-price wording → VW prints it amount-first:
//       "42.580,01 € (BTW incl.) 35.190,09 € (excl. BTW)"
//     (Audi prints "Totale prijs : € … € … Excl. BTW").
//
// As with Audi: the server-rendered page reliably carries the MODEL and the
// gross/net VEHICLE PRICE; the MONTHLY/term/down/residual come from the
// FinanceApi/Calculate JSON the browser fetcher captures (reCAPTCHA permitting),
// and stay null when that calculation is gated.
import { parseEur } from '../../libraries/currency/parse.js';
import { netToGross, grossToNet } from '../../libraries/finance/btw.js';
import { deriveFinancials } from '../../libraries/finance/irr.js';
import { ParseError } from '../../libraries/error-handling/AppError.js';
import {
  htmlToText,
  isOopsPage,
  hasCalculation,
  detectVatBasis,
  matchAmount,
  extractFromFinanceApi,
} from '../shared/ccf-parser.js';

export { htmlToText, isOopsPage, hasCalculation };

// Extract model name from the CCF finance header. VW splits it into a "brand"
// line (the carline, e.g. "ID.4") and a technical line (e.g. "Pure Business
// 58 kWh 140 kW (190 ch)"). Prefer the passed-in model when we have one.
export function parseModel(html, model) {
  const brand = html.match(/prices__top__text__brand[^>]*>\s*([^<]+?)\s*</i)?.[1] || null;
  const tech = html.match(/__info__technical[^>]*>\s*([^<]+?)\s*</i)?.[1] || null;
  const fromPage = [brand, tech].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (model?.displayName)
    return {
      modelName: /^volkswagen/i.test(model.displayName)
        ? model.displayName
        : `Volkswagen ${model.displayName}`,
      modelRange: model.range ?? brand,
    };
  if (fromPage) return { modelName: `Volkswagen ${fromPage}`, modelRange: brand };
  return { modelName: 'Volkswagen', modelRange: null };
}

// Extract the catalogue/total price. VW prints it amount-first as
//   "42.580,01 € (BTW incl.) 35.190,09 € (excl. BTW)"
// where the FIRST amount is incl. BTW (gross) and the SECOND is excl. BTW (net).
export function parseTotalPrice(text) {
  const m = text.match(/([\d .,]+?)\s*€\s*\(BTW incl\.?\)\s*([\d .,]+?)\s*€\s*\(excl\.?\s*BTW\)/i);
  if (m) return { gross: parseEur(m[1]), net: parseEur(m[2]) };
  // Fallbacks: Audi-style "Totale prijs : € X € Y Excl. BTW", then the
  // euro-first "€ X (BTW incl.) € Y (excl. BTW)" variant.
  const m2 = text.match(/Totale prijs\s*:?\s*€\s*([\d .,]+?)\s*€\s*([\d .,]+?)\s*Excl\.?\s*BTW/i);
  if (m2) return { gross: parseEur(m2[1]), net: parseEur(m2[2]) };
  const m3 = text.match(/€\s*([\d .,]+)\s*\(BTW incl\.?\)\s*€\s*([\d .,]+)\s*\(excl\.?\s*BTW\)/i);
  if (m3) return { gross: parseEur(m3[1]), net: parseEur(m3[2]) };
  return { gross: null, net: null };
}

export function parseVwOffer({
  html,
  url,
  code,
  model,
  brandConfig,
  scrapedAt,
  logger,
  financeApi,
  boundMeanings,
  // Data-quality gate: when a down payment was requested (requireConfirmedDown),
  // renting figures are trusted only if the form's recalc was actually confirmed
  // at the target amount (downVerified). Otherwise the captured Calculate reflects
  // the DEFAULT (~25%) down — a different state — and must NOT be emitted as the
  // 20% offer. `downAmount` lets the extractor pick the matching Calculate.
  // Defaults keep existing callers (and the Audi parser) behaving as before.
  downVerified = false,
  requireConfirmedDown = false,
  downAmount = null,
}) {
  const log = logger || { debug() {}, info() {}, warn() {} };

  if (isOopsPage({ html, url })) {
    throw new ParseError('VW CCF returned the Oops error page (code expired/invalid)', {
      code: 'VW_OOPS',
      context: { code, url },
    });
  }

  const text = htmlToText(html);
  const L = brandConfig.labels || {};
  const { modelName, modelRange } = parseModel(html, model);
  const price = parseTotalPrice(text);
  const calcReady = hasCalculation(html);

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

  // STRICT DOWN-PAYMENT GATE: if a down payment was requested but its recalc was
  // never confirmed, the only Calculate we captured reflects the default (~25%)
  // down — a different state — so we leave ALL renting figures null rather than
  // emit a monthly that does not belong to the 20% offer. The row keeps its
  // vehicle price (price-only) and the caller records VW_DOWN_NOT_CONFIRMED.
  if (requireConfirmedDown && !downVerified) {
    log.info(
      { code, downVerified, reason: 'VW_DOWN_NOT_CONFIRMED' },
      'VW down payment not confirmed at target — renting figures left null (no mixed-state monthly)',
    );
  }

  // Preferred source: the FinanceApi JSON captured by the browser fetcher. The
  // HTML calc block is the fallback for the rare case figures are server-rendered.
  const apiFigures =
    requireConfirmedDown && !downVerified
      ? null
      : extractFromFinanceApi(financeApi, { logger: log, boundMeanings, downAmount });

  if (apiFigures) {
    figureSource = `finance-api:${apiFigures.source}`;
    monthlyNet = apiFigures.monthlyNet ?? null;
    monthlyGross = apiFigures.monthlyGross ?? (monthlyNet != null ? netToGross(monthlyNet) : null);
    if (apiFigures.downNet != null) {
      downPaymentNet = apiFigures.downNet;
      downPaymentGross = netToGross(apiFigures.downNet);
    }
    termMonths = apiFigures.term ?? null;
    annualMileage = apiFigures.annualMileage ?? null;
    contractMileage =
      annualMileage != null && termMonths ? Math.round((annualMileage * termMonths) / 12) : null;
    residualValueNet = apiFigures.residualNet ?? null;
    residualValuePct = apiFigures.residualPct ?? null;
    log.info(
      { code, source: apiFigures.source, term: termMonths, annualMileage, downNet: downPaymentNet },
      'VW renting figures sourced from FinanceApi JSON',
    );
  } else if (calcReady && !(requireConfirmedDown && !downVerified)) {
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
    termMonths = termMatch ? parseInt(termMatch[1] ?? termMatch[2], 10) : null;
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
      'VW finance calculation not present — renting figures left null',
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
    'VW parse extracted',
  );

  // A VW record needs at least a model + a vehicle price. Without any price AND
  // no monthly, there is nothing useful.
  if (price.gross == null && price.net == null && monthlyNet == null) {
    throw new ParseError('VW finance form had no vehicle price or monthly', {
      code: 'VW_NO_DATA',
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
    brand: 'vw',
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
