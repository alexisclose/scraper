// Discover which VW model URLs are real and download each page. Pure I/O — no
// parsing. Each offer page covers a single trim; its sibling trims are reachable
// only via the "Andere aanbiedingen" (related offers) links, so we crawl those
// links breadth-first from a seed list to find every model, not just the seeds.
// The resulting slug list is cached on disk to spare the crawl on every run.
import pLimit from 'p-limit';
import { httpText } from '../../libraries/http/fetch.js';
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

// Matches /app/offers/nl/professional/<slug> links (singular "professional" —
// the plural "professionals" list page won't match because of the trailing /).
const RELATED_LINK_RE = /\/app\/offers\/nl\/professional\/([a-z0-9][a-z0-9-]*)/gi;

export async function discoverModelUrls(brandConfig, { logger }) {
  const cache = new JsonCache({
    dir: join(config.paths.dataDir, 'cache', 'vw'),
    bypass: config.vw.noCache,
    ttlMs: 24 * 60 * 60 * 1000, // 1 day
  });
  return cache.wrap('model-urls', async () => {
    logger.info({ seed: candidateSlugs.length }, 'crawling VW offer pages');
    const limit = pLimit(config.http.concurrency);
    const seen = new Set();
    const valid = new Map(); // slug -> url, only for pages that fetched OK
    let frontier = [...new Set(candidateSlugs)];

    while (frontier.length) {
      const batch = frontier.filter((s) => !seen.has(s));
      batch.forEach((s) => seen.add(s));
      const discovered = await Promise.all(
        batch.map((slug) =>
          limit(async () => {
            const url = brandConfig.endpoints.modelPattern.replace('{slug}', slug);
            try {
              const html = await httpText(url);
              valid.set(slug, url);
              const links = new Set();
              const re = new RegExp(RELATED_LINK_RE.source, 'gi');
              let m;
              while ((m = re.exec(html))) links.add(m[1]);
              return [...links];
            } catch {
              return [];
            }
          }),
        ),
      );
      frontier = [...new Set(discovered.flat())].filter((s) => !seen.has(s));
    }

    logger.info({ discovered: valid.size }, 'VW models discovered via crawl');
    return [...valid.entries()]
      .map(([slug, url]) => ({ slug, url }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  });
}

export function downloadModelHtml(url) {
  return httpText(url);
}
