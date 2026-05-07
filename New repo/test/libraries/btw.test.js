import { netToGross, grossToNet, pairWithBtw, DEFAULT_VAT_RATE } from '../../src/libraries/finance/btw.js';

describe('btw', () => {
  it('default VAT rate is 0.21', () => {
    expect(DEFAULT_VAT_RATE).toBe(0.21);
  });

  it('netToGross multiplies by 1.21 and rounds to 2 decimals', () => {
    expect(netToGross(100)).toBe(121);
    expect(netToGross(36990 / 1.21)).toBeCloseTo(36990, 2);
  });

  it('grossToNet divides by 1.21 and rounds to 2 decimals', () => {
    expect(grossToNet(121)).toBe(100);
    expect(grossToNet(36990)).toBeCloseTo(30570.25, 2);
  });

  it('returns null for nullish input', () => {
    expect(netToGross(null)).toBeNull();
    expect(grossToNet(undefined)).toBeNull();
    expect(netToGross(NaN)).toBeNull();
  });

  it('pairWithBtw fills the missing side', () => {
    expect(pairWithBtw({ net: 100 })).toEqual({ net: 100, gross: 121 });
    expect(pairWithBtw({ gross: 121 })).toEqual({ net: 100, gross: 121 });
    expect(pairWithBtw({})).toEqual({ net: null, gross: null });
  });

  it('respects custom VAT rate', () => {
    expect(netToGross(100, 0.17)).toBe(117);
  });
});
