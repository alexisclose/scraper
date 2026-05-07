// Atomic-ish JSON read/write with an EBUSY/EPERM-aware fallback (Excel-style
// — when the user has the previous output file open in another app).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, extname, join, basename } from 'node:path';

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readJsonOr(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return readJson(path);
  } catch {
    return fallback;
  }
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  return path;
}

// Wraps a write that might race against the OS holding an exclusive lock on
// the target (e.g. Excel keeps the .xlsx open while the user views it).
// On EBUSY/EPERM, write to a timestamped sibling instead and return the new
// path so the caller can tell the user what happened.
export function safeWrite(path, writeFn) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFn(path);
    return { path, fellBack: false };
  } catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = extname(path);
    const base = basename(path, ext);
    const fallback = join(dirname(path), `${base}-${ts}${ext}`);
    writeFn(fallback);
    return { path: fallback, fellBack: true, originalPath: path };
  }
}
