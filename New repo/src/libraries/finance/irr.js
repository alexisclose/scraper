// Lease-style implicit interest rate solver.
//
// Given the financed amount (catalog price minus downpayment), residual value,
// monthly payment and term in months, returns the annualised rate that makes
// the lease cashflows balance. Uses the same convention as Excel's RATE() for
// an annuity-due-style schedule (residual paid at end).
//
// Returns null if the inputs are insufficient or the solver can't converge.

const ITERATIONS = 80;
const LO = 0;
const HI = 1.0; // 100% annual — well past any real-world auto-lease rate

export function impliedAnnualRate({ financed, residual, monthly, termMonths }) {
  if (!financed || !monthly || !termMonths) return null;
  if (residual === null || residual === undefined) return null;

  const f = (rate) => {
    const m = rate / 12;
    if (Math.abs(m) < 1e-12) {
      return monthly - (financed - residual) / termMonths;
    }
    const annuityFactor = m / (1 - Math.pow(1 + m, -termMonths));
    return monthly - (financed - residual / Math.pow(1 + m, termMonths)) * annuityFactor;
  };

  if (f(LO) < 0) return 0;
  if (f(HI) > 0) return null;

  let lo = LO;
  let hi = HI;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Convenience helper that derives every dependent figure from a partial
// LeaseOffer-shaped record. All the brand parsers end up doing this — DRY it.
export function deriveFinancials({
  vehiclePriceNet,
  monthlyNet,
  downPaymentNet,
  termMonths,
  residualValueNet,
  residualValuePct,
}) {
  const rvNet =
    residualValueNet ??
    (vehiclePriceNet != null && residualValuePct != null
      ? Math.round(vehiclePriceNet * residualValuePct * 100) / 100
      : null);
  const rvPct =
    residualValuePct ??
    (vehiclePriceNet && rvNet != null ? rvNet / vehiclePriceNet : null);
  const dpPct =
    vehiclePriceNet && downPaymentNet != null ? downPaymentNet / vehiclePriceNet : null;
  const financed =
    vehiclePriceNet != null && downPaymentNet != null ? vehiclePriceNet - downPaymentNet : null;
  const interestEffective =
    financed != null && rvNet != null && monthlyNet && termMonths
      ? impliedAnnualRate({
          financed,
          residual: rvNet,
          monthly: monthlyNet,
          termMonths,
        })
      : null;
  const sumOfAllPaymentsNet =
    monthlyNet != null && termMonths && downPaymentNet != null
      ? Math.round((monthlyNet * termMonths + downPaymentNet) * 100) / 100
      : null;
  return {
    residualValueNet: rvNet,
    residualValuePct: rvPct,
    downPaymentPct: dpPct,
    financedNet: financed,
    interestEffective,
    sumOfAllPaymentsNet,
  };
}
