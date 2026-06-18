// Page I/O for the sticker-price scraper.
//
// Marketing/offer pages are JS-rendered SPAs with lazy-loaded, srcset-switched
// imagery and autoplay <video> banners — exactly the content that carries the
// "vanaf € 39.990 / € 399 per maand" creatives. So we render with a real
// browser engine, scroll to force lazy assets in, then harvest:
//   - visible DOM text snippets that contain a euro sign (the easy wins)
//   - every image URL actually painted (currentSrc, srcset, CSS backgrounds)
//   - every <video> source + its poster image
// and download the binary assets through the browser's own request context so
// they inherit cookies / referer and don't 403.
/* global window, document, location, getComputedStyle, NodeFilter */
import { chromium } from 'patchright';
import pLimit from 'p-limit';
import { BrowserError } from '../../libraries/error-handling/AppError.js';

// Reused from the BMW fetcher: many Belgian car sites bury the consent button
// in a shadow DOM, which blocks lazy-loading until dismissed.
const COOKIE_BANNER_DROPPER = `
  for (const el of document.querySelectorAll("*")) {
    if (el.shadowRoot) {
      const btn = el.shadowRoot.querySelector("button, [role=button]");
      if (btn && /accept|aanvaard|akkoord|toestaan|allow|tout accepter/i.test(btn.innerText || "")) {
        btn.click();
        break;
      }
    }
  }
`;

// In-page harvester. Serialised and run inside the browser by page.evaluate,
// so it may only reference browser globals (no imports / closures).
function harvest() {
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return null;
    }
  };
  const isHttp = (u) => u && /^https?:\/\//.test(u);

  // A short locating hint for an element: its alt/aria-label, or the nearest
  // heading/section text above it.
  const hint = (el) => {
    const own =
      (el.getAttribute && (el.getAttribute('alt') || el.getAttribute('aria-label'))) || '';
    if (own.trim()) return own.trim().slice(0, 120);
    let n = el;
    for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
      const h = n.querySelector && n.querySelector('h1,h2,h3,[role=heading]');
      if (h && h.innerText && h.innerText.trim()) return h.innerText.trim().slice(0, 120);
    }
    return '';
  };

  // Largest candidate from a srcset string.
  const fromSrcset = (ss) => {
    if (!ss) return null;
    let best = null;
    let bestW = -1;
    for (const part of ss.split(',')) {
      const [u, d] = part.trim().split(/\s+/);
      const w = d && d.endsWith('w') ? parseInt(d, 10) : 1;
      if (u && w > bestW) {
        bestW = w;
        best = u;
      }
    }
    return best;
  };

  const images = new Map();
  const addImg = (u, meta) => {
    const a = abs(u);
    if (isHttp(a) && !a.startsWith('data:') && !images.has(a)) {
      images.set(a, { url: a, ...meta });
    }
  };

  for (const img of document.querySelectorAll('img')) {
    // Skip obvious icons/logos that can't hold a price.
    if (img.naturalWidth && img.naturalWidth < 200) continue;
    addImg(img.currentSrc || img.src || fromSrcset(img.getAttribute('srcset')), {
      alt: img.alt || '',
      context: hint(img),
      w: img.naturalWidth || null,
      h: img.naturalHeight || null,
    });
  }
  for (const s of document.querySelectorAll('picture source[srcset]')) {
    addImg(fromSrcset(s.getAttribute('srcset')), { alt: '', context: hint(s), w: null, h: null });
  }
  // CSS background images (heroes are often these).
  for (const el of document.querySelectorAll('section,div,header,a,span')) {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\((['"]?)(.*?)\1\)/);
    if (m && m[2]) {
      const r = el.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 120)
        addImg(m[2], { alt: '', context: hint(el), w: null, h: null });
    }
  }
  for (const meta of document.querySelectorAll('meta[property="og:image"],meta[name="og:image"]')) {
    addImg(meta.getAttribute('content'), { alt: 'og:image', context: '', w: null, h: null });
  }

  const videos = [];
  const seenV = new Set();
  for (const v of document.querySelectorAll('video')) {
    const srcEl = v.querySelector('source');
    const src = v.currentSrc || v.src || (srcEl && srcEl.src);
    const a = abs(src);
    if (isHttp(a) && !seenV.has(a)) {
      seenV.add(a);
      videos.push({ url: a, poster: abs(v.poster), context: hint(v) });
    }
  }

  // DOM text snippets containing a euro sign — cheap, high-precision prices.
  const snippets = [];
  const seenT = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = (node.nodeValue || '').trim();
    if (t.length < 2 || t.length > 200) continue;
    if (!/€|\bEUR\b/i.test(t)) continue;
    const key = t.toLowerCase();
    if (seenT.has(key)) continue;
    seenT.add(key);
    const parent = node.parentElement;
    snippets.push({ text: t, context: parent ? hint(parent) : '' });
  }

  return {
    pageTitle: document.title || null,
    images: [...images.values()],
    videos,
    snippets,
  };
}

export async function launchStickerContext() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'nl-BE',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 1000 },
  });
  return { context, cleanup: () => browser.close() };
}

// Scroll the page in steps so IntersectionObserver-driven lazy loaders fire.
async function autoScroll(page, { steps = 12, pause = 350 } = {}) {
  for (let i = 0; i < steps; i += 1) {
    await page.evaluate((y) => window.scrollTo(0, y), (i + 1) * 900);
    await page.waitForTimeout(pause);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(pause);
}

/**
 * Render a page and harvest its assets + euro-bearing text.
 * @returns {Promise<{pageTitle, images, videos, snippets}>}
 */
export async function harvestPage(context, url, { logger, timeoutMs = 45000 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.evaluate(COOKIE_BANNER_DROPPER).catch(() => {});
    await page.waitForTimeout(800);
    await autoScroll(page);
    const harvested = await page.evaluate(harvest);
    logger.info(
      {
        url,
        images: harvested.images.length,
        videos: harvested.videos.length,
        snippets: harvested.snippets.length,
      },
      'page harvested',
    );
    return harvested;
  } catch (err) {
    throw new BrowserError(`Failed to harvest ${url}`, {
      code: 'STICKER_HARVEST_FAIL',
      cause: err,
      context: { url, msg: err.message },
    });
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Download binary assets through the browser request context (inherits session).
 * Returns a map url -> { buffer, contentType } for successful fetches only.
 */
export async function downloadAssets(context, urls, { logger, concurrency = 6 } = {}) {
  const limit = pLimit(concurrency);
  const out = new Map();
  await Promise.all(
    [...new Set(urls)].map((u) =>
      limit(async () => {
        try {
          const resp = await context.request.get(u, { timeout: 30000 });
          if (!resp.ok()) {
            logger.debug({ u, status: resp.status() }, 'asset fetch non-200');
            return;
          }
          const buffer = await resp.body();
          out.set(u, { buffer, contentType: resp.headers()['content-type'] || null });
        } catch (e) {
          logger.debug({ u, err: e.message }, 'asset fetch failed');
        }
      }),
    ),
  );
  return out;
}
