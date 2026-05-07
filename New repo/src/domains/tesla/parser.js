// Pure functions that turn the raw browser-actions output into LeaseOffer
// records. Importable from tests with no Playwright dependency.
import { parseEur } from '../../libraries/currency/parse.js';
import { netToGross, grossToNet } from '../../libraries/finance/btw.js';
import { deriveFinancials } from '../../libraries/finance/irr.js';

// Tesla's renting view shows the cash price INCL BTW (gross) but the monthly,
// downpayment and residual all NET (excl BTW) — there's an explicit
// "Alle bedragen zijn exclusief BTW" disclaimer on screen.
export function buildOffer({
  brandConfig,
  trimKey,
  cashGross,
  monthlyNetRaw,
  panelReading,
  url,
  scrapedAt,
}) {
  const monthlyNet = parseEur(monthlyNetRaw);
  const downPaymentNet = parseEur(panelReading?.dp);
  const residualValueNet = parseEur(panelReading?.rv);
  const termMonths = panelReading?.term ? parseInt(panelReading.term, 10) : null;
  const contractMileage =
    panelReading?.km != null
      ? parseInt(String(panelReading.km).replace(/[.,]/g, ''), 10)
      : null;

  const vehiclePriceGross = cashGross ?? null;
  const vehiclePriceNet = grossToNet(vehiclePriceGross);

  const derived = deriveFinancials({
    vehiclePriceNet,
    monthlyNet,
    downPaymentNet,
    termMonths,
    residualValueNet,
  });

  return {
    brand: 'tesla',
    url: url ?? brandConfig.endpoints.model3Design,
    slug: 'model3',
    modelName: `Tesla Model 3 ${trimKey}`,
    modelRange: 'Model 3',
    modelCode: trimKey,
    bonusMalus: null,
    scrapedAt,
    financialRenting: {
      productName: brandConfig.productName,
      productId: brandConfig.productId,
      customerType: 'BUSINESS',
      productType: 'LEASE',
      vehiclePriceNet,
      vehiclePriceGross,
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
      residualValueNet,
      residualValuePct: derived.residualValuePct,
      sumOfAllPaymentsNet: derived.sumOfAllPaymentsNet,
      sumOfAllPaymentsGross:
        derived.sumOfAllPaymentsNet != null ? netToGross(derived.sumOfAllPaymentsNet) : null,
    },
  };
}
