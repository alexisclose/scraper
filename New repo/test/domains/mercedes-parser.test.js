import { parseMercedesCalc } from '../../src/domains/mercedes/parser.js';
import { trimMatchesModel, buildBaumuster } from '../../src/domains/mercedes/fetcher.js';
import { brandConfigs } from '../../src/configs/index.js';
import { validateOffer } from '../../src/libraries/schema/lease-offer.js';

const brandConfig = brandConfigs.mercedes;
const scrapedAt = '2026-05-05T10:00:00.000Z';

const sampleCalc = {
  output: {
    rate: '€ 599,99',
    financingProduct: { id: 'Renting' },
    containers: [
      {
        id: 'fullSummary',
        items: [
          { id: 'pmtNet', businessValue: '495.85' },
          { id: 'dpNet', businessValue: '6000' },
          { id: 'carPriceNetOutput', businessValue: '30000' },
          { id: 'rvNet', businessValue: '6000' },
          { id: 'invoicingPrice', businessValue: '24000' },
          { id: 'numberInstallments', businessValue: '60' },
          { id: 'fpName', value: 'Operationele Renting' },
        ],
      },
    ],
  },
};

describe('parseMercedesCalc', () => {
  it('produces a schema-valid offer', () => {
    const offer = parseMercedesCalc({
      calculation: sampleCalc,
      actualProduct: 'Renting',
      model: {
        baumuster: '2060411',
        name: 'C-Klasse',
        displayName: 'C-Klasse',
        modelSeries: 'W206',
        classId: 'C-Class',
      },
      brandConfig,
      scrapedAt,
    });
    expect(() => validateOffer(offer)).not.toThrow();
    expect(offer.financialRenting.monthlyNet).toBe(495.85);
    expect(offer.financialRenting.monthlyGross).toBeCloseTo(599.99, 2);
    expect(offer.financialRenting.vehiclePriceNet).toBe(30000);
    expect(offer.financialRenting.downPaymentPct).toBeCloseTo(0.2);
    expect(offer.financialRenting.residualValuePct).toBeCloseTo(0.2);
    expect(offer.financialRenting.termMonths).toBe(60);
  });

  it('throws when fullSummary is missing', () => {
    expect(() =>
      parseMercedesCalc({
        calculation: { output: { containers: [] } },
        actualProduct: 'Renting',
        model: { baumuster: 'X', name: 'X', modelSeries: 'X' },
        brandConfig,
        scrapedAt,
      }),
    ).toThrow(/fullSummary/i);
  });
});

describe('trimMatchesModel', () => {
  it('matches by family name prefix', () => {
    expect(
      trimMatchesModel('CLA 200', { name: 'CLA', classId: 'CLA-class', modelSeries: 'C178' }),
    ).toBe(true);
  });

  it('rejects when EQ-class is missing the EQ prefix', () => {
    expect(
      trimMatchesModel('T 220 d', {
        name: 'EQT',
        classId: 'EQT-class',
        modelSeries: 'E420',
      }),
    ).toBe(false);
  });
});

describe('buildBaumuster', () => {
  it('uses the known suffix for known series', () => {
    expect(buildBaumuster('2060', 'W206')).toBe('2060411');
  });

  it('falls back to 111 for unknown series', () => {
    expect(buildBaumuster('9999', 'UNKNOWN')).toBe('9999111');
  });

  it('returns null for missing bm4', () => {
    expect(buildBaumuster(null, 'W206')).toBeNull();
  });
});
