import { impliedAnnualRate, deriveFinancials } from '../../src/libraries/finance/irr.js';

describe('impliedAnnualRate', () => {
  it('returns null when essential inputs are missing', () => {
    expect(impliedAnnualRate({ financed: 0, residual: 0, monthly: 0, termMonths: 0 })).toBeNull();
    expect(
      impliedAnnualRate({ financed: 10000, residual: 5000, monthly: 0, termMonths: 60 }),
    ).toBeNull();
  });

  it('returns ~0 for a zero-interest lease that exactly amortises', () => {
    // 12000 financed, 0 residual, 60 months × 200 = 12000 → rate 0
    const r = impliedAnnualRate({ financed: 12000, residual: 0, monthly: 200, termMonths: 60 });
    expect(r).toBeCloseTo(0, 4);
  });

  it('returns a positive rate when total payments > principal', () => {
    const r = impliedAnnualRate({
      financed: 30000,
      residual: 10000,
      monthly: 500,
      termMonths: 60,
    });
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(0.2); // sanity bound
  });
});

describe('deriveFinancials', () => {
  it('fills downPaymentPct from net price', () => {
    expect(
      deriveFinancials({ vehiclePriceNet: 50000, downPaymentNet: 10000 }).downPaymentPct,
    ).toBeCloseTo(0.2);
  });

  it('computes residual amount from pct + price', () => {
    const out = deriveFinancials({
      vehiclePriceNet: 50000,
      residualValuePct: 0.2,
    });
    expect(out.residualValueNet).toBe(10000);
    expect(out.residualValuePct).toBe(0.2);
  });

  it('returns null sumOfAllPaymentsNet when monthly is missing', () => {
    expect(
      deriveFinancials({ vehiclePriceNet: 30000, downPaymentNet: 6000, termMonths: 60 })
        .sumOfAllPaymentsNet,
    ).toBeNull();
  });
});
