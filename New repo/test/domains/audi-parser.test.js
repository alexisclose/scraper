import {
  htmlToText,
  isOopsPage,
  hasCalculation,
  detectVatBasis,
  parseModel,
  parseTotalPrice,
  extractFromFinanceApi,
  parseAudiOffer,
} from '../../src/domains/audi/parser.js';
import { brandConfigs } from '../../src/configs/index.js';
import { validateOffer } from '../../src/libraries/schema/lease-offer.js';

const brandConfig = brandConfigs.audi;
const scrapedAt = '2026-06-17T10:00:00.000Z';

// A trimmed but structurally faithful slice of a real live formulastep page
// (code A1JMCU8H): a calculation-less A3 Sportback with gross/net total price.
const LIVE_PRICE_ONLY = `
  <div class="finance__content__prices__top__text">
    <p class="finance__content__prices__top__text__brand ">A3 Sportback</p>
    <p class="finance__content__prices__top__text__info">
      <span class="finance__content__prices__top__text__info__technical">Attraction TFSI 85 kW 6 vitesses</span>
      <strong>&euro; 32 429,99</strong>
    </p>
  </div>
  <div class="price"> Totale prijs : <span> &euro; 32 429,99 </span> <span> &euro; 26 801,65 Excl. BTW </span></div>
  <div class="finance__stepper">
    <div data-has-initial-product-name="False" data-has-calculation-information="False" class="stepper-next-step">
      <p class="finance__content__prices__title">Maandbedrag</p>
    </div>
  </div>`;

describe('htmlToText', () => {
  it('strips tags/scripts and decodes entities to a collapsed string', () => {
    const html =
      '<html><head><style>.x{}</style></head><body>' +
      '<script>var a=1;</script>' +
      '<p>Audi&nbsp;A3 &euro;&nbsp;399 / maand</p></body></html>';
    expect(htmlToText(html)).toBe('Audi A3 € 399 / maand');
  });
});

describe('isOopsPage', () => {
  it('detects the Oops URL', () => {
    expect(isOopsPage({ html: '', url: 'https://formsccf.audi.be/ccf/nl/Base/Oops?code=X' })).toBe(
      true,
    );
  });
  it('detects the Oops body text', () => {
    expect(isOopsPage({ html: 'Oeps, er is een fout opgetreden...', url: '' })).toBe(true);
  });
  it('is false for a normal page', () => {
    expect(isOopsPage({ html: 'maandprijs € 399', url: '/ccf/nl/finance/formulastep' })).toBe(
      false,
    );
  });
});

describe('hasCalculation', () => {
  it('is false when the page flags no calculation info', () => {
    expect(hasCalculation('data-has-calculation-information="False"')).toBe(false);
  });
  it('is true when a calculation is rendered', () => {
    expect(hasCalculation('data-has-calculation-information="True"')).toBe(true);
  });
});

describe('parseModel', () => {
  it('combines the brand + technical lines from the finance header', () => {
    const { modelName, modelRange } = parseModel(LIVE_PRICE_ONLY, null);
    expect(modelName).toBe('Audi A3 Sportback Attraction TFSI 85 kW 6 vitesses');
    expect(modelRange).toBe('A3 Sportback');
  });
  it('prefers the passed-in model identity when present', () => {
    const { modelName, modelRange } = parseModel(LIVE_PRICE_ONLY, {
      displayName: 'Audi A3 Sportback',
      range: 'A3',
    });
    expect(modelName).toBe('Audi A3 Sportback');
    expect(modelRange).toBe('A3');
  });
});

describe('parseTotalPrice', () => {
  it('reads gross (incl. BTW) then net (excl. BTW), space-thousands aware', () => {
    const { gross, net } = parseTotalPrice(htmlToText(LIVE_PRICE_ONLY));
    expect(gross).toBe(32429.99);
    expect(net).toBe(26801.65);
  });
});

describe('detectVatBasis', () => {
  const text = 'maandprijs € 399 excl. btw en catalogusprijs € 35.000 incl. btw';
  it('reads net when excl. btw is nearest', () => {
    expect(detectVatBasis(text, text.indexOf('399'))).toBe('net');
  });
  it('reads gross when incl. btw is nearest', () => {
    expect(detectVatBasis(text, text.indexOf('35.000'))).toBe('gross');
  });
  it('returns null when no marker is nearby', () => {
    expect(detectVatBasis('maandprijs € 399', 11)).toBe(null);
  });
});

describe('extractFromFinanceApi', () => {
  // Verified live shape: POST /ccf/FinanceApi/Calculate returns the monthly with
  // both VAT bases explicit (captured from a real A3 business-renting session).
  it('reads the monthly net+gross from a Calculate response', () => {
    const responses = [
      { url: '/ccf/FinanceApi/GetComponentList?lg=nl', json: { BoundIds: [913, 914], Success: true } },
      {
        url: 'https://formsccf.audi.be/ccf/FinanceApi/Calculate?lg=nl',
        status: 200,
        json: {
          PriceVatExcluded: '528,36',
          PriceVatIncluded: '630,84',
          BalloonRate: null,
          Success: true,
          Status: 0,
        },
      },
    ];
    const f = extractFromFinanceApi(responses);
    expect(f.source).toBe('calculate');
    expect(f.monthlyNet).toBe(528.36);
    expect(f.monthlyGross).toBe(630.84);
  });

  it('reads BalloonRate as a residual percentage when present', () => {
    const f = extractFromFinanceApi([
      {
        url: '/ccf/FinanceApi/Calculate',
        json: { PriceVatExcluded: '300,00', PriceVatIncluded: '363,00', BalloonRate: '35,5', Success: true },
      },
    ]);
    expect(f.residualPct).toBeCloseTo(0.355, 3);
  });

  // Heuristic fallback for an as-yet-unseen list shape.
  it('falls back to a heuristic scan for the business renting product', () => {
    const responses = [
      {
        json: {
          products: [
            { name: 'Lening', customerType: 'private', monthlyAmount: 350, durationMonths: 48 },
            {
              name: 'Financiële Renting',
              customerType: 'business',
              monthlyAmount: 412.5,
              durationMonths: 60,
              downPayment: 5360.33,
              residualValue: 8040.5,
            },
          ],
        },
      },
    ];
    const f = extractFromFinanceApi(responses);
    expect(f.source).toBe('heuristic');
    expect(f.monthlyNet).toBe(412.5);
    expect(f.monthlyGross).toBeCloseTo(499.13, 1);
    expect(f.term).toBe(60);
    expect(f.downNet).toBeCloseTo(5360.33, 2);
  });

  it('rejects implausible numbers and returns null when nothing fits', () => {
    expect(extractFromFinanceApi([{ json: { monthlyAmount: 9, durationMonths: 999 } }])).toBeNull();
  });

  it('returns null for empty/missing input', () => {
    expect(extractFromFinanceApi([])).toBeNull();
    expect(extractFromFinanceApi(undefined)).toBeNull();
  });
});

describe('parseAudiOffer', () => {
  it('throws AUDI_OOPS on the error page so the caller can skip', () => {
    expect(() =>
      parseAudiOffer({
        html: 'Oeps, er is een fout opgetreden...',
        url: 'https://formsccf.audi.be/ccf/nl/Base/Oops?code=AB8YS3VH',
        code: 'AB8YS3VH',
        brandConfig,
        scrapedAt,
      }),
    ).toThrow(/Oops/i);
  });

  it('throws AUDI_NO_DATA when neither price nor monthly is present', () => {
    expect(() =>
      parseAudiOffer({
        html: '<html><body><p>Audi A3 — geen prijs</p></body></html>',
        url: 'https://formsccf.audi.be/ccf/nl/finance/formulastep?code=X',
        code: 'X',
        brandConfig,
        scrapedAt,
      }),
    ).toThrow(/no vehicle price or monthly/i);
  });

  it('parses the live price-only form into a schema-valid offer (renting figures null)', () => {
    const offer = parseAudiOffer({
      html: LIVE_PRICE_ONLY,
      url: 'https://formsccf.audi.be/ccf/nl/finance/formulastep?code=A1JMCU8H',
      code: 'A1JMCU8H',
      model: { id: 'a3-sportback', displayName: 'Audi A3 Sportback', range: 'A3' },
      brandConfig,
      scrapedAt,
    });
    expect(() => validateOffer(offer)).not.toThrow();
    expect(offer.brand).toBe('audi');
    expect(offer.modelName).toBe('Audi A3 Sportback');
    expect(offer.financialRenting.customerType).toBe('BUSINESS');
    expect(offer.financialRenting.vehiclePriceGross).toBe(32429.99);
    expect(offer.financialRenting.vehiclePriceNet).toBe(26801.65);
    // reCAPTCHA-gated calculator → no monthly fabricated
    expect(offer.financialRenting.monthlyNet).toBeNull();
    expect(offer.financialRenting.termMonths).toBeNull();
  });

  it('sources renting figures from captured FinanceApi JSON when present', () => {
    const offer = parseAudiOffer({
      html: LIVE_PRICE_ONLY,
      url: 'https://formsccf.audi.be/ccf/nl/finance/formulastep?code=A1JMCU8H',
      code: 'A1JMCU8H',
      model: { id: 'a3-sportback', displayName: 'Audi A3 Sportback', range: 'A3' },
      brandConfig,
      scrapedAt,
      financeApi: [
        {
          json: {
            name: 'Financiële Renting',
            customerType: 'business',
            monthlyAmount: 412.5,
            durationMonths: 60,
            downPayment: 5360.33,
            residualValue: 8040.5,
          },
        },
      ],
    });
    expect(() => validateOffer(offer)).not.toThrow();
    // monthly comes from JSON, assumed excl. BTW (net) → gross derived at 21%
    expect(offer.financialRenting.monthlyNet).toBe(412.5);
    expect(offer.financialRenting.monthlyGross).toBeCloseTo(499.13, 1);
    expect(offer.financialRenting.termMonths).toBe(60);
    expect(offer.financialRenting.downPaymentNet).toBeCloseTo(5360.33, 2);
    // price still from the HTML
    expect(offer.financialRenting.vehiclePriceGross).toBe(32429.99);
  });

  it('extracts the monthly when a real calculation IS rendered (calc=True)', () => {
    const html =
      LIVE_PRICE_ONLY.replace(
        'data-has-calculation-information="False"',
        'data-has-calculation-information="True"',
      ) + '<div>Maandbedrag € 399,00 /maand (excl. BTW)</div>';
    const offer = parseAudiOffer({
      html,
      url: 'https://formsccf.audi.be/ccf/nl/finance/formulastep?code=Z',
      code: 'Z',
      model: { id: 'a3-sportback', displayName: 'Audi A3 Sportback', range: 'A3' },
      brandConfig,
      scrapedAt,
    });
    expect(offer.financialRenting.monthlyNet).toBe(399);
    expect(offer.financialRenting.monthlyGross).toBeCloseTo(482.79, 1);
  });
});
