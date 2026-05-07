// Tiny on-disk JSON cache with optional TTL and a per-namespace bypass flag.
// Used by the VW scraper to avoid re-probing 22 candidate URLs on every run.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './json-store.js';

export class JsonCache {
  constructor({ dir, ttlMs = null, bypass = false }) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.bypass = bypass;
  }

  pathFor(key) {
    return join(this.dir, `${key}.json`);
  }

  get(key) {
    if (this.bypass) return null;
    const p = this.pathFor(key);
    if (!existsSync(p)) return null;
    try {
      const { savedAt, value } = JSON.parse(readFileSync(p, 'utf8'));
      if (this.ttlMs && Date.now() - new Date(savedAt).getTime() > this.ttlMs) return null;
      return value;
    } catch {
      return null;
    }
  }

  set(key, value) {
    writeJson(this.pathFor(key), { savedAt: new Date().toISOString(), value });
    return value;
  }

  async wrap(key, producer) {
    const cached = this.get(key);
    if (cached !== null) return cached;
    const fresh = await producer();
    this.set(key, fresh);
    return fresh;
  }
}
