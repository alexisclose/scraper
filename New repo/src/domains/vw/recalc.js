// Recalculate a VW promotions offer's monthly for a different down payment.
//
// VW publishes real Financiële Renting offers on its promotion pages, each with
// its own down payment ("eerste verhoogde huurprijs"). To compare offers on a
// common basis, this recomputes the monthly for a chosen down-payment percentage
// while holding the deal's own implied interest rate, term, residual and mileage
// fixed. It's pure arithmetic on already-scraped data — no new requests.
import { netToGross } from '../../libraries/finance/btw.js';

const round2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

// Inverse of the implied-rate solver in irr.js: the monthly annuity payment that
// amortises (financed − present-value(residual)) over `termMonths` at the given
// annual rate. Mirrors that solver's f(rate) === 0 condition exactly, so feeding
// an offer's own `interestEffective` back in reproduces its scraped monthly.
export function monthlyForRate({ financed, residual, termMonths, annualRate }) {
  if (financed == null || residual == null || !termMonths || annualRate == null) return null;
  const m = annualRate / 12;
  if (Math.abs(m) < 1e-12) return round2((financed - residual) / termMonths);
  const annuityFactor = m / (1 - Math.pow(1 + m, -termMonths));
  return round2((financed - residual / Math.pow(1 + m, termMonths)) * annuityFactor);
}

// Return a copy of `offer` with the down payment set to `downPct` of the net
// catalogue price and the monthly recomputed at the offer's own implied rate.
// Term, residual, mileage and price are unchanged.
//
// Two guards keep the resulting sheet honest:
//   • A `downPct` outside [0, 1) would make the financed amount non-positive, so
//     a bad caller leaves the offer untouched rather than producing nonsense.
//   • An offer that lacks the inputs to recompute (implied rate / residual /
//     term / price) gets its basis-DEPENDENT figures BLANKED — the row still
//     shows the car + catalogue price, but no monthly/down that would falsely
//     read as "at <downPct>% down". Leaving the original promo figures in a
//     sheet labelled "<pct>% down" misrepresents them.
export function recalcForDownPayment(offer, downPct) {
  if (downPct == null || downPct < 0 || downPct >= 1) return offer;

  const f = offer.financialRenting || {};
  const price = f.vehiclePriceNet;
  const rate = f.interestEffective;
  const residual = f.residualValueNet;
  const term = f.termMonths;

  const downNet = price != null ? round2(downPct * price) : null;
  const monthlyNet =
    price != null && rate != null && residual != null && term
      ? monthlyForRate({ financed: price - downNet, residual, termMonths: term, annualRate: rate })
      : null;

  // Couldn't recompute at the target down payment — blank the basis-dependent
  // figures so the sheet doesn't pass off promo numbers as <pct>%-down ones.
  if (monthlyNet == null) {
    return {
      ...offer,
      financialRenting: {
        ...f,
        monthlyNet: null,
        monthlyGross: null,
        downPaymentNet: null,
        downPaymentGross: null,
        downPaymentPct: null,
        interestEffective: null,
        sumOfAllPaymentsNet: null,
        sumOfAllPaymentsGross: null,
      },
    };
  }

  // Down % and implied rate are exact by construction (down = downPct·price; the
  // rate was held fixed), so carry them through directly — no re-derivation, no
  // rounding drift. Total = down + monthly·term.
  const sumNet = round2(monthlyNet * term + downNet);
  return {
    ...offer,
    financialRenting: {
      ...f,
      monthlyNet,
      monthlyGross: netToGross(monthlyNet),
      downPaymentNet: downNet,
      downPaymentGross: netToGross(downNet),
      downPaymentPct: downPct,
      interestEffective: rate,
      sumOfAllPaymentsNet: sumNet,
      sumOfAllPaymentsGross: netToGross(sumNet),
    },
  };
}
