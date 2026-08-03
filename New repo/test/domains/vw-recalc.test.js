import { monthlyForRate, recalcForDownPayment } from '../../src/domains/vw/recalc.js';
import { impliedAnnualRate } from '../../src/libraries/finance/irr.js';

// A representative VW promotion offer (Amarok-like): real published figures.
// interestEffective is the precisely-solved implied rate (as the scrapers store
// it), so recalculating at the original down payment reproduces the monthly.
const TRUE_RATE = impliedAnnualRate({
  financed: 50900 - 6624.92,
  residual: 15270,
  monthly: 589,
  termMonths: 60,
});
const baseOffer = {
  brand: 'vw',
  url: 'https://www.volkswagen.be/app/offers/nl/professional/amarok',
  slug: 'amarok',
  modelName: 'Volkswagen Amarok STYLE',
  scrapedAt: '2026-06-23T10:00:00.000Z',
  financialRenting: {
    productName: 'VW FR',
    productId: 'VW_FIN_RENTING',
    customerType: 'BUSINESS',
    productType: 'LEASE',
    vehiclePriceNet: 50900,
    vehiclePriceGross: 61589,
    monthlyNet: 589,
    monthlyGross: 712.69,
    downPaymentNet: 6624.92,
    downPaymentGross: 8016.15,
    downPaymentPct: 0.1302,
    termMonths: 60,
    annualMileage: 15000,
    contractMileage: 75000,
    interestEffective: TRUE_RATE,
    residualValueNet: 15270,
    residualValuePct: 0.3,
    sumOfAllPaymentsNet: 41964.92,
    sumOfAllPaymentsGross: 50777.55,
  },
};

describe('monthlyForRate', () => {
  it('is the exact inverse of impliedAnnualRate (round-trips the monthly)', () => {
    const f = baseOffer.financialRenting;
    const financed = f.vehiclePriceNet - f.downPaymentNet;
    const rate = impliedAnnualRate({
      financed,
      residual: f.residualValueNet,
      monthly: f.monthlyNet,
      termMonths: f.termMonths,
    });
    const monthly = monthlyForRate({
      financed,
      residual: f.residualValueNet,
      termMonths: f.termMonths,
      annualRate: rate,
    });
    expect(monthly).toBeCloseTo(f.monthlyNet, 0);
  });

  it('returns null when inputs are insufficient', () => {
    expect(
      monthlyForRate({ financed: null, residual: 100, termMonths: 60, annualRate: 0.05 }),
    ).toBeNull();
    expect(
      monthlyForRate({ financed: 1000, residual: 100, termMonths: 0, annualRate: 0.05 }),
    ).toBeNull();
  });
});

describe('recalcForDownPayment', () => {
  it('sets the down payment to the requested % of the net price', () => {
    const out = recalcForDownPayment(baseOffer, 0.2);
    expect(out.financialRenting.downPaymentNet).toBeCloseTo(0.2 * 50900, 2);
    expect(out.financialRenting.downPaymentPct).toBeCloseTo(0.2, 4);
  });

  it('raises the monthly when the down payment shrinks (10% < 13%)', () => {
    const out = recalcForDownPayment(baseOffer, 0.1);
    expect(out.financialRenting.monthlyNet).toBeGreaterThan(baseOffer.financialRenting.monthlyNet);
  });

  it('lowers the monthly when the down payment grows (20% > 13%)', () => {
    const out = recalcForDownPayment(baseOffer, 0.2);
    expect(out.financialRenting.monthlyNet).toBeLessThan(baseOffer.financialRenting.monthlyNet);
  });

  it('keeps term, residual, mileage and price unchanged', () => {
    const out = recalcForDownPayment(baseOffer, 0.2).financialRenting;
    const f = baseOffer.financialRenting;
    expect(out.termMonths).toBe(f.termMonths);
    expect(out.residualValueNet).toBe(f.residualValueNet);
    expect(out.annualMileage).toBe(f.annualMileage);
    expect(out.vehiclePriceNet).toBe(f.vehiclePriceNet);
  });

  it('reproduces the original monthly when recalculated at the original down %', () => {
    const f = baseOffer.financialRenting;
    const exactDownPct = f.downPaymentNet / f.vehiclePriceNet;
    const out = recalcForDownPayment(baseOffer, exactDownPct);
    expect(out.financialRenting.downPaymentNet).toBeCloseTo(f.downPaymentNet, 2);
    expect(out.financialRenting.monthlyNet).toBeCloseTo(f.monthlyNet, 0);
  });

  it('blanks the basis-dependent figures when it cannot recompute at the target down %', () => {
    const partial = {
      ...baseOffer,
      financialRenting: { ...baseOffer.financialRenting, interestEffective: null },
    };
    const out = recalcForDownPayment(partial, 0.2).financialRenting;
    // basis-dependent figures blanked (would otherwise misread as "at 20% down")
    expect(out.monthlyNet).toBeNull();
    expect(out.monthlyGross).toBeNull();
    expect(out.downPaymentNet).toBeNull();
    expect(out.downPaymentPct).toBeNull();
    expect(out.sumOfAllPaymentsNet).toBeNull();
    // basis-independent figures preserved so the row still shows the car + price
    expect(out.vehiclePriceNet).toBe(baseOffer.financialRenting.vehiclePriceNet);
    expect(out.termMonths).toBe(baseOffer.financialRenting.termMonths);
    expect(out.residualValueNet).toBe(baseOffer.financialRenting.residualValueNet);
  });

  it('leaves the offer untouched for an out-of-range down %', () => {
    expect(recalcForDownPayment(baseOffer, 1.2)).toBe(baseOffer);
    expect(recalcForDownPayment(baseOffer, -0.1)).toBe(baseOffer);
    expect(recalcForDownPayment(baseOffer, null)).toBe(baseOffer);
  });

  it('carries the implied rate through unchanged (no re-derivation drift)', () => {
    const out = recalcForDownPayment(baseOffer, 0.2).financialRenting;
    expect(out.interestEffective).toBe(baseOffer.financialRenting.interestEffective);
  });
});
