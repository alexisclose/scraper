import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson, readJson, readJsonOr, safeWrite } from '../../src/libraries/io/json-store.js';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lease-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('json-store', () => {
  it('writeJson + readJson round-trip', () => {
    const path = join(tmp, 'a/b/c.json');
    writeJson(path, { hello: 'world' });
    expect(readJson(path)).toEqual({ hello: 'world' });
  });

  it('readJsonOr returns fallback for missing file', () => {
    expect(readJsonOr(join(tmp, 'missing.json'), { fallback: true })).toEqual({ fallback: true });
  });

  it('readJsonOr returns fallback for malformed JSON', () => {
    const path = join(tmp, 'bad.json');
    writeFileSync(path, '{not valid}');
    expect(readJsonOr(path, [])).toEqual([]);
  });

  it('safeWrite writes to original path on success', () => {
    const path = join(tmp, 'out.json');
    const result = safeWrite(path, (p) => writeFileSync(p, '{"ok":1}'));
    expect(result.fellBack).toBe(false);
    expect(result.path).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('{"ok":1}');
  });

  it('safeWrite falls back to a timestamped sibling on EBUSY', () => {
    const path = join(tmp, 'locked.json');
    const result = safeWrite(path, (p) => {
      // Simulate Excel-style file-lock the first time only
      if (p === path) {
        const e = new Error('locked');
        e.code = 'EBUSY';
        throw e;
      }
      writeFileSync(p, '{"ok":1}');
    });
    expect(result.fellBack).toBe(true);
    expect(result.path).not.toBe(path);
    expect(existsSync(result.path)).toBe(true);
  });

  it('safeWrite re-throws non-lock errors', () => {
    expect(() =>
      safeWrite(join(tmp, 'x.json'), () => {
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
  });
});
