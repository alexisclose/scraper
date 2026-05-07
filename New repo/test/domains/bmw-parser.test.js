import {
  pickFinancialRentingOffer,
  shapeBmwOffer,
  buildBmwOffer,
} from '../../src/domains/bmw/parser.js';
import { brandConfigs } from '../../src/configs/index.js';
import { validateOffer } from '../../src/libraries/schema/lease-offer.js';

const brandConfig = brandConfigs.bmw;

const sampleCalc = {
  data: [
    {
      info: { customerType: 'PRIVATE', productName: 'BMW Select', productId: 'SEL' },
      parameterMapping: {},
      parameterValues: [],
    },
    {
      info: {
        customerType: 'BUSINESS',
        productName: 'BMW Financial Renting',
        productId: 'FR',
        productType: 'LEASE',
      },
      parameterMapping: {},
      parameterValues: [
        {
          key: 'vehiclePrices/totalVehiclePrice/salesPrice/netAmount',
          value: [{ key: 'value', value: '50000' }],
        },
        {
          key: 'vehiclePrices/totalVehiclePrice/salesPrice/grossAmount',
          value: [{ key: 'value', value: '60500' }],
        },
        { key: 'totalInstallment/netAmount', value: [{ key: 'value', value: '599' }] },
        { key: 'downPaymentAmount/netAmount', value: [{ key: 'value', value: '0' }] },
        { key: 'downPaymentPercent', value: [{ key: 'value', value: '0' }] },
        { key: 'term', value: [{ key: 'value', value: '60' }] },
        { key: 'annualMileage', value: [{ key: 'value', value: '25000' }] },
        { key: 'interestEffective', value: [{ key: 'value', value: '0.045' }] },
        { key: 'residualValueAmount/netAmount', value: [{ key: 'value', value: '15000' }] },
        { key: 'residualValuePercent', value: [{ key: 'value', value: '0.30' }] },
      ],
    },
  ],
};

describe('BMW parser', () => {
  it('picks the BUSINESS offer over PRIVATE', () => {
    const fr = pickFinancialRentingOffer(sampleCalc);
    expect(fr.info.customerType).toBe('BUSINESS');
  });

  it('shapeBmwOffer maps net + gross prices', () => {
    const fr = pickFinancialRentingOffer(sampleCalc);
    const out = shapeBmwOffer(fr);
    expect(out.vehiclePriceNet).toBe(50000);
    expect(out.vehiclePriceGross).toBe(60500);
    expect(out.monthlyNet).toBe(599);
    expect(out.termMonths).toBe(60);
    expect(out.annualMileage).toBe(25000);
    expect(out.residualValuePct).toBe(0.3);
  });

  it('buildBmwOffer produces a schema-valid offer', () => {
    const offer = buildBmwOffer({
      url: 'https://configure.bmw.be/nl_BE/configure/F70/24BV',
      calculation: sampleCalc,
      brandConfig,
      modelNames: { 'F70/24BV': '1 Series' },
      scrapedAt: '2026-05-05T10:00:00.000Z',
    });
    expect(() => validateOffer(offer)).not.toThrow();
    expect(offer.modelRange).toBe('F70');
    expect(offer.modelCode).toBe('24BV');
    expect(offer.modelName).toBe('1 Series');
  });

  it('throws when no BUSINESS offer is present', () => {
    expect(() =>
      buildBmwOffer({
        url: 'https://configure.bmw.be/nl_BE/configure/X/Y',
        calculation: { data: [{ info: { customerType: 'PRIVATE' } }] },
        brandConfig,
        modelNames: {},
        scrapedAt: '2026-05-05T10:00:00.000Z',
      }),
    ).toThrow(/BUSINESS/i);
  });
});
