// Pure parser for the BMW configurator's `default-calculation` JSON response.
// Importable from tests with no Playwright dependency.
import { ParseError } from '../../libraries/error-handling/AppError.js';

// BMW packs the calculation in two parallel structures: a flat
// `parameterMapping` keyed by camelCase, and a nested `parameterValues` keyed
// by JSON-pointer-ish paths. We prefer the typed `parameterValues` form when
// available — it has both net and gross variants of every money figure.
function pv(params, key) {
  const item = params.find((p) => p.key === key);
  if (!item) return null;
  const v = item.value.find((x) => x.key === 'value');
  return v ? v.value : null;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export function pickFinancialRentingOffer(calculation) {
  if (!calculation || !Array.isArray(calculation.data)) return null;
  return (
    calculation.data.find(
      (d) =>
        d?.info?.customerType === 'BUSINESS' ||
        /renting/i.test(d?.info?.productName || '') ||
        d?.info?.productType === 'LEASE',
    ) ?? null
  );
}

export function shapeBmwOffer(offer) {
  if (!offer) return null;
  const m = offer.parameterMapping || {};
  const p = offer.parameterValues || [];
  return {
    productName: offer.info?.productName,
    productId: offer.info?.productId,
    customerType: offer.info?.customerType || 'BUSINESS',
    productType: offer.info?.productType || 'LEASE',
    vehiclePriceNet: num(pv(p, 'vehiclePrices/totalVehiclePrice/salesPrice/netAmount')),
    vehiclePriceGross: num(pv(p, 'vehiclePrices/totalVehiclePrice/salesPrice/grossAmount')),
    monthlyNet: num(pv(p, 'totalInstallment/netAmount') ?? m.totalInstallment ?? m.payment),
    monthlyGross: num(
      pv(p, 'totalInstallment/grossAmount') ?? pv(p, 'installment/grossAmount'),
    ),
    downPaymentNet: num(pv(p, 'downPaymentAmount/netAmount') ?? m.downpayment),
    downPaymentGross: num(pv(p, 'downPaymentAmount/grossAmount')),
    downPaymentPct: num(pv(p, 'downPaymentPercent')),
    termMonths: pv(p, 'term') ? parseInt(pv(p, 'term'), 10) : m.term ? parseInt(m.term, 10) : null,
    annualMileage: pv(p, 'annualMileage')
      ? parseInt(pv(p, 'annualMileage'), 10)
      : m.contractualMileage
        ? parseInt(m.contractualMileage, 10)
        : null,
    contractMileage: null,
    interestEffective: num(pv(p, 'interestEffective')),
    residualValueNet: num(pv(p, 'residualValueAmount/netAmount')),
    residualValuePct: num(pv(p, 'residualValuePercent')),
    sumOfAllPaymentsNet: num(pv(p, 'sumOfAllPayments/netAmount') ?? m.sumOfAllTotalPayments),
    sumOfAllPaymentsGross: num(pv(p, 'sumOfAllPayments/grossAmount')),
  };
}

export function buildBmwOffer({ url, calculation, brandConfig, modelNames, scrapedAt }) {
  const fr = pickFinancialRentingOffer(calculation);
  if (!fr) {
    throw new ParseError('No BUSINESS / Financial Renting offer in calculation', {
      code: 'BMW_NO_FR_OFFER',
      context: { url },
    });
  }
  const shaped = shapeBmwOffer(fr);
  // Override product name to use the configured display name
  shaped.productName = shaped.productName || brandConfig.productName;
  shaped.productId = shaped.productId || brandConfig.productId;

  const m = url.match(/configure\/([A-Z0-9]+)\/([A-Z0-9]+)/);
  const modelRange = m ? m[1] : null;
  const modelCode = m ? m[2] : null;
  const lookupKey = modelRange && modelCode ? `${modelRange}/${modelCode}` : null;

  return {
    brand: 'bmw',
    url,
    slug: modelCode,
    modelName: (lookupKey && modelNames[lookupKey]) || modelCode || 'BMW',
    modelRange,
    modelCode,
    bonusMalus: null,
    scrapedAt,
    financialRenting: shaped,
  };
}
