import { extractPrices } from '../../src/domains/stickers/parser.js';

describe('extractPrices', () => {
  it('extracts a monthly price and classifies it', () => {
    const out = extractPrices('Nu vanaf € 399 /maand');
    const monthly = out.find((p) => p.kind === 'monthly');
    expect(monthly).toBeDefined();
    expect(monthly.amount).toBe(399);
    expect(monthly.unit).toBe('per_month');
  });

  it('extracts a cash/from price', () => {
    const out = extractPrices('BMW iX1 vanaf € 39.990');
    const cash = out.find((p) => p.amount === 39990);
    expect(cash).toBeDefined();
    expect(cash.kind).toBe('cash');
    expect(cash.unit).toBe('total');
  });

  it('classifies a discount/advantage', () => {
    const out = extractPrices('Voordeel tot € 5.000 op geselecteerde modellen');
    const disc = out.find((p) => p.amount === 5000);
    expect(disc).toBeDefined();
    expect(disc.kind).toBe('discount');
  });

  it('handles French wording (/mois, à partir de)', () => {
    const out = extractPrices('à partir de € 349 /mois');
    expect(out.some((p) => p.kind === 'monthly' && p.amount === 349)).toBe(true);
  });

  it('handles euro after the number and the EUR token', () => {
    expect(extractPrices('399 € par mois').some((p) => p.amount === 399)).toBe(true);
    expect(extractPrices('Prix: 39.990 EUR').some((p) => p.amount === 39990)).toBe(true);
  });

  it('tolerates an NBSP thousands gap and stray OCR spaces', () => {
    const out = extractPrices('vanaf € 39.990');
    expect(out.some((p) => p.amount === 39990)).toBe(true);
  });

  it('requires a euro indicator — ignores bare numbers like model years', () => {
    expect(extractPrices('Model year 2026, 300 pk, 0% APR')).toHaveLength(0);
  });

  it('rejects out-of-range amounts per kind', () => {
    // A "monthly" of 0,01 is below the monthly floor.
    expect(extractPrices('€ 0,01 /maand')).toHaveLength(0);
  });

  it('dedups repeated (kind, amount) pairs', () => {
    const out = extractPrices('€ 399 /maand ... opnieuw € 399 /maand');
    expect(out.filter((p) => p.amount === 399 && p.kind === 'monthly')).toHaveLength(1);
  });

  it('tolerates OCR mangling "/maand" into "Imaand"', () => {
    // Tesseract routinely reads the slash as a capital I / l / 1 / pipe.
    const out = extractPrices('€ 475 Imaand');
    expect(out.some((p) => p.amount === 475 && p.kind === 'monthly')).toBe(true);
  });

  it('classifies by nearest keyword, not a distant one in the same banner', () => {
    // A real OCR dump of one banner: each amount should get its own label.
    const out = extractPrices('Nu vanaf € 39.990  € 475 /maand  Voordeel tot € 5.000');
    const by = Object.fromEntries(out.map((p) => [p.amount, p.kind]));
    expect(by[39990]).toBe('cash');
    expect(by[475]).toBe('monthly');
    expect(by[5000]).toBe('discount');
  });

  it('accepts £ as a euro misread (tesseract confuses € and £)', () => {
    expect(extractPrices('vanaf £ 39.990').some((p) => p.amount === 39990)).toBe(true);
  });

  it('reads a bare "E" as euro from a video frame ("Vanaf E 599 per maand")', () => {
    const out = extractPrices('BMW iX M Edition. Vanaf E 599 per maand excl. btw');
    expect(out.some((p) => p.amount === 599 && p.kind === 'monthly')).toBe(true);
  });

  it('promotes a sub-€1000 "vanaf" price to monthly (OCR-dropped "/maand")', () => {
    // Real video-frame read: "Vanaf € 599; er maan[d]" — the d is lost, so only
    // "Vanaf" (cash) is detected, but €599 is far too low to be a car's price.
    const out = extractPrices('Vanaf € 599 er maan');
    expect(out.some((p) => p.amount === 599 && p.kind === 'monthly' && p.unit === 'per_month')).toBe(
      true,
    );
  });

  it('still keeps a genuine sub-€1000 cash amount out (truncated junk like €47)', () => {
    expect(extractPrices('Vanaf € 47 huur')).toHaveLength(0);
  });

  it('does NOT treat a bare "E" as euro without the tell-tale space (plates, model codes)', () => {
    // "E1510" on a license plate, "BE"/"THE" before a number — all must stay out.
    expect(extractPrices('plate M E1510E')).toHaveLength(0);
    expect(extractPrices('THE 500 club, BE 320 spec')).toHaveLength(0);
  });

  it('returns [] for empty / non-string input', () => {
    expect(extractPrices('')).toEqual([]);
    expect(extractPrices(null)).toEqual([]);
    expect(extractPrices(undefined)).toEqual([]);
  });
});
