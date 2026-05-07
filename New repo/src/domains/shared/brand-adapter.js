// Brand adapter contract.
//
// Each `domains/<brand>/index.js` exports a default object that conforms to
// `BrandAdapter`. The CLI runner (commands/scrape.js) treats brands as opaque
// — all brand-specific weirdness must be hidden behind these two functions.
//
// Why a typed-comment contract instead of TS interfaces? The project is
// plain JS to keep the toolchain small; JSDoc gives us the same editor hints
// in VS Code without bringing in a compiler.

/**
 * @typedef {Object} BrandRunContext
 * @property {import('pino').Logger} logger
 * @property {Object} brandConfig  loaded JSON from configs/brands/<brand>.json
 * @property {string} runId        ISO timestamp of this scrape run
 */

/**
 * @typedef {Object} BrandAdapter
 * @property {('bmw'|'mercedes'|'tesla'|'vw')} id
 * @property {string} displayName
 * @property {(ctx: BrandRunContext) => Promise<import('zod').infer<
 *   typeof import('../../libraries/schema/lease-offer.js').leaseOfferArraySchema>>} run
 *   Returns an array of validated LeaseOffer records.
 * @property {(offer: any) => Object} toExcelRow
 *   Maps a single offer to the flat row shape the Excel writer expects.
 */

// Default Excel-row mapper. Brands can override `toExcelRow` if they need
// brand-specific columns (e.g. BMW wants a friendly model name from a lookup).
export function defaultToExcelRow(offer) {
  const f = offer.financialRenting || {};
  const round2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
  const pct1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 10);
  return {
    Brand: offer.brand,
    Model: offer.modelName || '',
    'Series / Range': offer.modelRange || '',
    'Variant Code': offer.modelCode || offer.slug || '',
    'Vehicle Price (gross)': round2(f.vehiclePriceGross),
    'Vehicle Price (net)': round2(f.vehiclePriceNet),
    'Monthly (net)': round2(f.monthlyNet),
    'Monthly (gross)': round2(f.monthlyGross),
    'Down Payment (net)': round2(f.downPaymentNet),
    'Down Payment (gross)': round2(f.downPaymentGross),
    'Down Payment %': pct1(f.downPaymentPct),
    'Term (months)': f.termMonths,
    'Annual km': f.annualMileage,
    'Interest %': pct1(f.interestEffective),
    'Residual Value (net)': round2(f.residualValueNet),
    'Residual Value %': pct1(f.residualValuePct),
    'Total Cost (net)': round2(f.sumOfAllPaymentsNet),
    'FR Product': f.productName || '',
    URL: offer.url || '',
  };
}
