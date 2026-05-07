// Pure parser for the FCIS calc response.
import { netToGross } from '../../libraries/finance/btw.js';
import { impliedAnnualRate } from '../../libraries/finance/irr.js';
import { ParseError } from '../../libraries/error-handling/AppError.js';

export function parseMercedesCalc({
  calculation,
  actualProduct,
  model,
  brandConfig,
  scrapedAt,
}) {
  const full = calculation.output?.containers?.find((c) => c.id === 'fullSummary');
  if (!full) throw new ParseError('FCIS calc has no fullSummary');
  const item = (id) => full.items.find((i) => i.id === id);
  const num = (id) => parseFloat(item(id)?.businessValue || '0') || null;

  const monthlyNet = num('pmtNet');
  // Mercedes returns monthlyGross as a formatted "rate" string at the top level.
  const rateStr = calculation.output?.rate;
  const monthlyGross = rateStr
    ? parseFloat(rateStr.replace(/[^\d,]/g, '').replace(',', '.')) || null
    : null;
  const downPaymentNet = num('dpNet');
  const carNet = num('carPriceNetOutput');
  // Field name differs by product: rvNet for Renting, rvLeasing for FL
  const residualValueNet = num('rvNet') || num('rvLeasing');
  const financed = num('invoicingPrice');
  const termMonths =
    parseInt(item('numberInstallments')?.businessValue || '60', 10) || 60;
  const interestEffective =
    monthlyNet && financed != null && residualValueNet != null
      ? impliedAnnualRate({
          financed,
          residual: residualValueNet,
          monthly: monthlyNet,
          termMonths,
        })
      : null;
  const productLabel = item('fpName')?.value || actualProduct;

  return {
    brand: 'mercedes',
    url: null,
    slug: model.baumuster,
    modelName: model.displayName || model.name,
    modelRange: model.modelSeries,
    modelCode: model.baumuster,
    bonusMalus: null,
    scrapedAt,
    financialRenting: {
      productName: productLabel || brandConfig.productName,
      productId: calculation.output?.financingProduct?.id || actualProduct || brandConfig.productId,
      customerType: 'BUSINESS',
      productType: 'LEASE',
      vehiclePriceNet: carNet,
      vehiclePriceGross: netToGross(carNet),
      monthlyNet,
      monthlyGross: monthlyGross ?? netToGross(monthlyNet),
      downPaymentNet,
      downPaymentGross: netToGross(downPaymentNet),
      downPaymentPct: carNet ? downPaymentNet / carNet : null,
      termMonths,
      annualMileage: null, // FCIS doesn't expose this for Renting/FL
      contractMileage: null,
      interestEffective,
      residualValueNet,
      residualValuePct: carNet && residualValueNet != null ? residualValueNet / carNet : null,
      sumOfAllPaymentsNet:
        monthlyNet != null && downPaymentNet != null
          ? Math.round((monthlyNet * termMonths + downPaymentNet) * 100) / 100
          : null,
      sumOfAllPaymentsGross:
        monthlyGross != null && downPaymentNet != null
          ? Math.round(
              (monthlyGross * termMonths + netToGross(downPaymentNet)) * 100,
            ) / 100
          : null,
    },
  };
}
