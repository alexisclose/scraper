import { findChromeExecutable } from '../../src/libraries/browser/chrome-detect.js';

describe('findChromeExecutable', () => {
  it('returns the override when given', () => {
    expect(findChromeExecutable('/path/to/custom/chrome')).toBe('/path/to/custom/chrome');
  });

  it('returns null or a non-empty string', () => {
    const result = findChromeExecutable();
    expect(result === null || (typeof result === 'string' && result.length > 0)).toBe(true);
  });
});
