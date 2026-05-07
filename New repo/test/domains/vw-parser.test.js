import { extractModal, parseVwOffer } from '../../src/domains/vw/parser.js';
import { brandConfigs } from '../../src/configs/index.js';
import { validateOffer } from '../../src/libraries/schema/lease-offer.js';

const brandConfig = brandConfigs.vw;
const scrapedAt = '2026-05-05T10:00:00.000Z';

describe('extractModal', () => {
  it('returns text content of a uk-modal div with proper depth tracking', () => {
    const html =
      `<html><body>` +
      `<div id="legal-mention-monthly" uk-modal>` +
      `<div class="inner"><p>Volkswagen Polo Style Aanbevolen catalogusprijs excl. BTW: € 25.000</p></div>` +
      `</div>` +
      `</body></html>`;
    const text = extractModal(html, 'legal-mention-monthly');
    expect(text).toMatch(/Volkswagen Polo Style/);
    expect(text).toMatch(/€ 25.000/);
  });

  it('returns empty string when the modal is missing', () => {
    expect(extractModal('<html></html>', 'legal-mention-monthly')).toBe('');
  });
});

describe('parseVwOffer', () => {
  it('parses a representative VW page and produces a schema-valid offer', () => {
    const html = `
<html><body>
<div class="header">
  <span>Financiële Renting vanaf
    <span class="price_currency">&euro;</span>&nbsp;435&nbsp;/&nbsp;<span class="price_period">maand</span>
  </span>
</div>
<div id="legal-mention-monthly" uk-modal>
  <div>
    <p>Volkswagen Polo Style 1.0 TSI 95 ch DSG7 Aanbevolen catalogusprijs excl. BTW € 22.500
       60 maand 75.000 kilometer eerste verhoogde huurprijs van € 4.500
       aankoopoptie van 35,5 % bonus-malus 11</p>
  </div>
</div>
<div class="visible">
  Aanbevolen catalogusprijs <span class="price_currency">&euro;</span>&nbsp;22.500
</div>
</body></html>`;
    const offer = parseVwOffer({
      html,
      url: 'https://www.volkswagen.be/app/offers/nl/professional/polo-business',
      slug: 'polo-business',
      brandConfig,
      scrapedAt,
    });
    expect(() => validateOffer(offer)).not.toThrow();
    expect(offer.financialRenting.monthlyNet).toBe(435);
    expect(offer.financialRenting.vehiclePriceNet).toBe(22500);
    expect(offer.financialRenting.termMonths).toBe(60);
    expect(offer.financialRenting.contractMileage).toBe(75000);
    expect(offer.financialRenting.downPaymentNet).toBe(4500);
    expect(offer.financialRenting.residualValuePct).toBeCloseTo(0.355);
    expect(offer.financialRenting.annualMileage).toBe(15000);
    expect(offer.bonusMalus).toBe(11);
  });

  it('throws ParseError when no offer block is present', () => {
    expect(() =>
      parseVwOffer({
        html: '<html><body>nothing here</body></html>',
        url: 'https://example.com',
        slug: 'unknown',
        brandConfig,
        scrapedAt,
      }),
    ).toThrow(/no offer/i);
  });
});
