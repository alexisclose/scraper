// Discover which VW model URLs are real (HTTP 200 on HEAD) and download each
// page. Pure I/O — no parsing. The slug list is cached on disk to spare 22
// HEAD requests on every run.
import pLimit from 'p-limit';
import { httpFetch, httpText } from '../../libraries/http/fetch.js';
import { config } from '../../configs/index.js';
import { JsonCache } from '../../libraries/io/json-cache.js';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const candidateSlugs = JSON.parse(
  readFileSync(join(__dirname, 'data', 'candidate-slugs.json'), 'utf8'),
);

export async function discoverModelUrls(brandConfig, { logger }) {
  const cache = new JsonCache({
    dir: join(config.paths.dataDir, 'cache', 'vw'),
    bypass: config.vw.noCache,
    ttlMs: 24 * 60 * 60 * 1000, // 1 day
  });
  return cache.wrap('model-urls', async () => {
    logger.info({ count: candidateSlugs.length }, 'probing VW slugs');
    const limit = pLimit(config.http.concurrency);
    const checks = candidateSlugs.map((slug) => {
      const url = brandConfig.endpoints.modelPattern.replace('{slug}', slug);
      return limit(async () => {
        try {
          const res = await httpFetch(url, { method: 'HEAD' });
          return res.ok ? { slug, url } : null;
        } catch {
          return null;
        }
      });
    });
    const results = await Promise.all(checks);
    return results.filter(Boolean).sort((a, b) => a.slug.localeCompare(b.slug));
  });
}

export function downloadModelHtml(url) {
  return httpText(url);
}
