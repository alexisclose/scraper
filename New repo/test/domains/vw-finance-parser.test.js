import {
  htmlToText,
  isOopsPage,
  hasCalculation,
  parseModel,
  parseTotalPrice,
  parseVwOffer,
} from '../../src/domains/vw-finance/parser.js';
import { brandConfigs } from '../../src/configs/index.js';
import { validateOffer } from '../../src/libraries/schema/lease-offer.js';

const brandConfig = brandConfigs['vw-finance'];
const scrapedAt = '2026-06-22T10:00:00.000Z';

// A trimmed but structurally faithful slice of a real live VW formulastep page
// (code VDCN9X6X): an ID.4 Pure Business with the amount-first gross/net price
// and no rendered calculation (reCAPTCHA-gated).
const LIVE_PRICE_ONLY = `
  <div class="finance__content__prices__top__text">
    <p class="finance__content__prices__top__text__brand ">ID.4</p>
    <p class="finance__content__prices__top__text__info">
      <span class="finance__content__prices__top__text__info__technical">Pure Business 58 kWh 140 kW (190 ch)</span>
    </p>
  </div>
  <div class="price">42.580,01 &euro; (BTW incl.) 35.190,09 &euro; (excl. BTW)</div>
  <div class="finance__stepper">
    <div data-has-calculation-information="False" class="stepper-next-step">
      <p class="finance__content__prices__title">Maandbedrag</p>
    </div>
  </div>`;

describe('htmlToText', () => {
  it('strips tags/scripts and decodes entities to a collapsed string', () => {
    const html =
      '<html><head><style>.x{}</style></head><body>' +
      '<script>var a=1;</script>' +
      '<p>Volkswagen&nbsp;ID.4 &euro;&nbsp;399 / maand</p></body></html>';
    expect(htmlToText(html)).toBe('Volkswagen ID.4 € 399 / maand');
  });
});

describe('isOopsPage', () => {
  it('detects the Oops URL', () => {
    expect(
      isOopsPage({ html: '', url: 'https://formsccf.volkswagen.be/ccf/nl/Base/Oops?code=X' }),
    ).toBe(true);
  });
  it('is false for a normal page', () => {
    expect(isOopsPage({ html: 'maandprijs € 399', url: '/ccf/nl/finance/formulastep' })).toBe(
      false,
    );
  });
});

describe('parseTotalPrice', () => {
  it('reads VW amount-first "X € (BTW incl.) Y € (excl. BTW)"', () => {
    const text = htmlToText(LIVE_PRICE_ONLY);
    const price = parseTotalPrice(text);
    expect(price.gross).toBeCloseTo(42580.01);
    expect(price.net).toBeCloseTo(35190.09);
  });
  it('returns nulls when no price is present', () => {
    expect(parseTotalPrice('nothing here')).toEqual({ gross: null, net: null });
  });
});

describe('parseModel', () => {
  it('joins the carline + technical line into a Volkswagen-prefixed name', () => {
    const { modelName, modelRange } = parseModel(LIVE_PRICE_ONLY, null);
    expect(modelName).toBe('Volkswagen ID.4 Pure Business 58 kWh 140 kW (190 ch)');
    expect(modelRange).toBe('ID.4');
  });
  it('prefers a passed-in model display name', () => {
    const { modelName } = parseModel(LIVE_PRICE_ONLY, { displayName: 'ID.4 Pure Business' });
    expect(modelName).toBe('Volkswagen ID.4 Pure Business');
  });
});

describe('hasCalculation', () => {
  it('is false when the reCAPTCHA-gated calc is absent', () => {
    expect(hasCalculation(LIVE_PRICE_ONLY)).toBe(false);
  });
});

describe('parseVwOffer', () => {
  it('parses the live price-only form into a schema-valid offer (renting figures null)', () => {
    const offer = parseVwOffer({
      html: LIVE_PRICE_ONLY,
      url: 'https://formsccf.volkswagen.be/ccf/nl/finance/formulastep?code=VDCN9X6X',
      code: 'VDCN9X6X',
      brandConfig,
      scrapedAt,
    });
    expect(() => validateOffer(offer)).not.toThrow();
    expect(offer.brand).toBe('vw');
    expect(offer.modelName).toMatch(/Volkswagen ID\.4/);
    expect(offer.financialRenting.vehiclePriceGross).toBeCloseTo(42580.01);
    expect(offer.financialRenting.vehiclePriceNet).toBeCloseTo(35190.09);
    expect(offer.financialRenting.monthlyNet).toBeNull();
  });

  it('sources renting figures from captured FinanceApi JSON when present', () => {
    const financeApi = [
      {
        url: 'https://formsccf.volkswagen.be/ccf/FinanceApi/Calculate?lg=nl',
        method: 'POST',
        status: 200,
        json: {
          PriceVatExcluded: '528,36',
          PriceVatIncluded: '630,84',
          BalloonRate: null,
          Success: true,
        },
        requestBody: {
          FamilyId: 318,
          bounds: [
            { componentId: 1, value: '8000' },
            { componentId: 2, value: '60' },
            { componentId: 3, value: '15000' },
          ],
        },
      },
    ];
    const offer = parseVwOffer({
      html: LIVE_PRICE_ONLY,
      url: 'https://formsccf.volkswagen.be/ccf/nl/finance/formulastep?code=VDCN9X6X',
      code: 'VDCN9X6X',
      brandConfig,
      scrapedAt,
      financeApi,
      boundMeanings: { 1: 'down', 2: 'term', 3: 'mileage' },
    });
    expect(() => validateOffer(offer)).not.toThrow();
    expect(offer.financialRenting.monthlyNet).toBeCloseTo(528.36);
    expect(offer.financialRenting.monthlyGross).toBeCloseTo(630.84);
    expect(offer.financialRenting.termMonths).toBe(60);
    expect(offer.financialRenting.annualMileage).toBe(15000);
    expect(offer.financialRenting.downPaymentNet).toBeCloseTo(8000);
  });

  it('throws VW_OOPS on the error page so the caller can skip', () => {
    expect(() =>
      parseVwOffer({
        html: '',
        url: 'https://formsccf.volkswagen.be/ccf/nl/Base/Oops?code=X',
        code: 'X',
        brandConfig,
        scrapedAt,
      }),
    ).toThrow(/Oops/i);
  });

  it('throws VW_NO_DATA when neither price nor monthly is present', () => {
    expect(() =>
      parseVwOffer({
        html: '<html><body>nothing here</body></html>',
        url: 'https://formsccf.volkswagen.be/ccf/nl/finance/formulastep?code=Y',
        code: 'Y',
        brandConfig,
        scrapedAt,
      }),
    ).toThrow(/no vehicle price or monthly/i);
  });
});
