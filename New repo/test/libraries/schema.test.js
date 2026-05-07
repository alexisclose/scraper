import { validateOffer, leaseOfferSchema } from '../../src/libraries/schema/lease-offer.js';

const validOffer = {
  brand: 'tesla',
  url: 'https://www.tesla.com/nl_be/model3/design',
  slug: 'model3',
  modelName: 'Tesla Model 3 Performance',
  modelRange: 'Model 3',
  modelCode: 'Performance',
  scrapedAt: '2026-05-05T10:00:00.000Z',
  financialRenting: {
    productName: 'Tesla Financial Services',
    productId: 'TESLA',
    customerType: 'BUSINESS',
    productType: 'LEASE',
    vehiclePriceNet: 48340.5,
    vehiclePriceGross: 58490,
    monthlyNet: 599,
    monthlyGross: 724.79,
    downPaymentNet: 8050,
    downPaymentGross: 9740.5,
    downPaymentPct: 0.166,
    termMonths: 60,
    annualMileage: 25000,
    contractMileage: 125000,
    interestEffective: 0.04,
    residualValueNet: 9668,
    residualValuePct: 0.2,
    sumOfAllPaymentsNet: 43990,
    sumOfAllPaymentsGross: 53227.9,
  },
};

describe('leaseOfferSchema', () => {
  it('accepts a complete valid offer', () => {
    expect(() => validateOffer(validOffer)).not.toThrow();
  });

  it('accepts nullable financial fields', () => {
    const minimal = {
      ...validOffer,
      financialRenting: {
        ...validOffer.financialRenting,
        monthlyNet: null,
        downPaymentNet: null,
        residualValueNet: null,
        interestEffective: null,
      },
    };
    expect(() => validateOffer(minimal)).not.toThrow();
  });

  it('rejects unknown brand', () => {
    const bad = { ...validOffer, brand: 'audi' };
    expect(() => validateOffer(bad)).toThrow();
  });

  it('rejects negative termMonths', () => {
    const bad = {
      ...validOffer,
      financialRenting: { ...validOffer.financialRenting, termMonths: -1 },
    };
    expect(() => leaseOfferSchema.parse(bad)).toThrow();
  });

  it('rejects non-ISO scrapedAt', () => {
    expect(() => validateOffer({ ...validOffer, scrapedAt: '2026-01-01' })).toThrow();
  });
});
