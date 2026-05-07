import { buildOffer } from '../../src/domains/tesla/parser.js';
import { brandConfigs } from '../../src/configs/index.js';
import { validateOffer } from '../../src/libraries/schema/lease-offer.js';

const brandConfig = brandConfigs.tesla;
const scrapedAt = '2026-05-05T10:00:00.000Z';

describe('Tesla parser.buildOffer', () => {
  it('produces a schema-valid offer for a complete reading', () => {
    const offer = buildOffer({
      brandConfig,
      trimKey: 'Performance',
      cashGross: 58490,
      monthlyNetRaw: '599',
      panelReading: { dp: '8.050', term: '60', km: '125000', rv: '9.668' },
      url: 'https://www.tesla.com/nl_be/model3/design',
      scrapedAt,
    });
    expect(() => validateOffer(offer)).not.toThrow();
    expect(offer.modelName).toBe('Tesla Model 3 Performance');
    expect(offer.financialRenting.vehiclePriceGross).toBe(58490);
    expect(offer.financialRenting.vehiclePriceNet).toBeCloseTo(58490 / 1.21, 2);
    expect(offer.financialRenting.monthlyNet).toBe(599);
    expect(offer.financialRenting.monthlyGross).toBeCloseTo(599 * 1.21, 2);
    expect(offer.financialRenting.downPaymentNet).toBe(8050);
    expect(offer.financialRenting.residualValueNet).toBe(9668);
    expect(offer.financialRenting.termMonths).toBe(60);
    // 125000 km / 60 mo × 12 → 25000 km/yr
    expect(offer.financialRenting.annualMileage).toBe(25000);
    expect(offer.financialRenting.interestEffective).toBeGreaterThanOrEqual(0);
  });

  it('handles missing monthly gracefully', () => {
    const offer = buildOffer({
      brandConfig,
      trimKey: 'Achterwielaandrijving (RWD)',
      cashGross: 36990,
      monthlyNetRaw: null,
      panelReading: null,
      url: null,
      scrapedAt,
    });
    expect(() => validateOffer(offer)).not.toThrow();
    expect(offer.financialRenting.monthlyNet).toBeNull();
    expect(offer.financialRenting.interestEffective).toBeNull();
    expect(offer.financialRenting.sumOfAllPaymentsNet).toBeNull();
  });
});
