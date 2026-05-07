import { parseEur, formatEur } from '../../src/libraries/currency/parse.js';

describe('parseEur', () => {
  it.each([
    ['€ 49.723,14', 49723.14],
    ['€&nbsp;49.723,14', 49723.14],
    ['€ 435', 435],
    ['€ 299', 299],
    ['  € 6.800  ', 6800],
    ['1.350', 1350],
    ['0,37', 0.37],
  ])('parses %j → %s', (input, expected) => {
    expect(parseEur(input)).toBe(expected);
  });

  it.each([null, undefined, '', '   ', 'not a number', 'abc'])('returns null for %j', (input) => {
    expect(parseEur(input)).toBeNull();
  });
});

describe('formatEur', () => {
  it('formats with thousand-separator dot and decimal comma', () => {
    expect(formatEur(49723.14).replace(/\s/g, ' ')).toMatch(/49\.723,14/);
  });
  it('returns dash for null/NaN', () => {
    expect(formatEur(null)).toBe('–');
    expect(formatEur(NaN)).toBe('–');
  });
});
