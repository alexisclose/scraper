// Sticker-price scraper — orchestration.
//
// For each target page:
//   1. render + harvest (fetcher.js)
//   2. extract prices from DOM text snippets       → source: 'html'
//   3. download images, OCR them, extract prices    → source: 'image'
//   4. download videos, sample frames, OCR, extract → source: 'video'
// Every observation is validated against the StickerPrice schema at the
// boundary, mirroring how the brand adapters guard LeaseOffer output.
//
// This is intentionally NOT a LeaseOffer brand adapter: a sticker price is an
// advertised headline, not a resolved finance calculation. It lives alongside
// the brand adapters but is driven by its own command (commands/scrape-stickers).
import pLimit from 'p-limit';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { validateStickerPrice } from '../../libraries/schema/sticker-price.js';
import { extractPrices } from './parser.js';
import { harvestPage, downloadAssets, launchStickerContext } from './fetcher.js';
import { recognize, terminateOcr } from './ocr.js';
import { extractFrames, ffmpegAvailable } from './video.js';

const MAX_IMAGES = Number(process.env.STICKER_MAX_IMAGES || 40);
const MAX_VIDEOS = Number(process.env.STICKER_MAX_VIDEOS || 3);
const MIN_CONFIDENCE = Number(process.env.STICKER_MIN_OCR_CONFIDENCE || 30);

// Confirm a downloaded asset really is a video. We can't rely on the URL
// extension — CDNs like Adobe Scene7 serve MP4s from extension-less paths — so
// we trust the content-type and fall back to the extension only if it's absent.
function looksLikeVideo(url, contentType) {
  if (contentType && /^video\//i.test(contentType)) return true;
  if (contentType && contentType !== 'application/octet-stream') return false;
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url);
}

async function scrapeImages({ context, page, harvested, brand, runId, logger }) {
  const records = [];
  const imageUrls = harvested.images.map((i) => i.url).slice(0, MAX_IMAGES);
  if (!imageUrls.length) return records;

  const assets = await downloadAssets(context, imageUrls, { logger });
  const limit = pLimit(2); // OCR is CPU-heavy; keep it modest
  const metaByUrl = new Map(harvested.images.map((i) => [i.url, i]));

  await Promise.all(
    imageUrls.map((url) =>
      limit(async () => {
        const asset = assets.get(url);
        if (!asset) return;
        let ocr;
        try {
          ocr = await recognize(asset.buffer);
        } catch (e) {
          logger.debug({ url, err: e.message }, 'image OCR failed');
          return;
        }
        if (ocr.confidence != null && ocr.confidence < MIN_CONFIDENCE) return;
        const prices = extractPrices(ocr.text);
        if (!prices.length) return;
        const meta = metaByUrl.get(url) || {};
        records.push(
          validateStickerPrice({
            brand,
            pageUrl: page,
            pageTitle: harvested.pageTitle,
            source: 'image',
            assetUrl: url,
            assetType: asset.contentType,
            scrapedAt: runId,
            ocrText: ocr.text.slice(0, 2000),
            ocrConfidence: ocr.confidence,
            context: meta.alt || meta.context || null,
            prices,
          }),
        );
      }),
    ),
  );
  return records;
}

async function scrapeVideos({ context, page, harvested, brand, runId, logger }) {
  const records = [];
  // <video>/<source> URLs are videos by definition; we verify content-type
  // after download rather than guessing from the (often extension-less) URL.
  const videoUrls = harvested.videos
    .map((v) => v.url)
    .filter(Boolean)
    .slice(0, MAX_VIDEOS);
  if (!videoUrls.length) return records;
  if (!ffmpegAvailable()) {
    logger.warn(
      { count: videoUrls.length },
      'ffmpeg not found — skipping video OCR (set FFMPEG_PATH or install ffmpeg)',
    );
    return records;
  }

  const assets = await downloadAssets(context, videoUrls, { logger, concurrency: 2 });
  const ctxByUrl = new Map(harvested.videos.map((v) => [v.url, v]));
  const tmp = mkdtempSync(join(tmpdir(), 'sticker-vid-'));
  try {
    for (const url of videoUrls) {
      const asset = assets.get(url);
      if (!asset) continue;
      if (!looksLikeVideo(url, asset.contentType)) {
        logger.debug({ url, contentType: asset.contentType }, 'skipping non-video asset');
        continue;
      }
      const file = join(tmp, `v${records.length}${extname(new URL(url).pathname) || '.mp4'}`);
      writeFileSync(file, asset.buffer);
      let frames;
      try {
        frames = await extractFrames(file);
      } catch (e) {
        logger.debug({ url, err: e.message }, 'frame extraction failed');
        continue;
      }
      for (const frame of frames) {
        let ocr;
        try {
          ocr = await recognize(frame.buffer);
        } catch {
          continue;
        }
        if (ocr.confidence != null && ocr.confidence < MIN_CONFIDENCE) continue;
        const prices = extractPrices(ocr.text);
        if (!prices.length) continue;
        records.push(
          validateStickerPrice({
            brand,
            pageUrl: page,
            pageTitle: harvested.pageTitle,
            source: 'video',
            assetUrl: url,
            assetType: asset.contentType,
            scrapedAt: runId,
            ocrText: ocr.text.slice(0, 2000),
            ocrConfidence: ocr.confidence,
            frameTimestampSec: frame.timestampSec,
            context: (ctxByUrl.get(url) || {}).context || null,
            prices,
          }),
        );
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return records;
}

function scrapeHtml({ harvested, page, brand, runId }) {
  const records = [];
  for (const snip of harvested.snippets) {
    const prices = extractPrices(snip.text);
    if (!prices.length) continue;
    records.push(
      validateStickerPrice({
        brand,
        pageUrl: page,
        pageTitle: harvested.pageTitle,
        source: 'html',
        assetUrl: null,
        scrapedAt: runId,
        ocrText: null,
        context: snip.context || null,
        prices,
      }),
    );
  }
  return records;
}

/**
 * Run the sticker scraper over a list of target pages.
 * @param {object} args
 * @param {import('pino').Logger} args.logger
 * @param {string} args.runId  ISO timestamp
 * @param {Array<{url:string, brand?:string}>} args.targets
 * @param {object} [args.opts]  { images=true, videos=true }
 * @returns {Promise<Array>} validated StickerPrice records
 */
export async function runStickers({ logger, runId, targets, opts = {} }) {
  const { images = true, videos = true } = opts;
  const { context, cleanup } = await launchStickerContext();
  const all = [];
  try {
    for (const target of targets) {
      const page = target.url;
      const brand = target.brand || 'unknown';
      logger.info({ page, brand }, 'sticker page start');
      let harvested;
      try {
        harvested = await harvestPage(context, page, { logger });
      } catch (err) {
        logger.warn({ page, code: err.code, msg: err.message }, 'page harvest failed');
        continue;
      }

      const htmlRecords = scrapeHtml({ harvested, page, brand, runId });
      const imageRecords = images
        ? await scrapeImages({ context, page, harvested, brand, runId, logger })
        : [];
      const videoRecords = videos
        ? await scrapeVideos({ context, page, harvested, brand, runId, logger })
        : [];

      const pageRecords = [...htmlRecords, ...imageRecords, ...videoRecords];
      logger.info(
        {
          page,
          html: htmlRecords.length,
          image: imageRecords.length,
          video: videoRecords.length,
          prices: pageRecords.reduce((n, r) => n + r.prices.length, 0),
        },
        'sticker page done',
      );
      all.push(...pageRecords);
    }
    return all;
  } finally {
    await cleanup().catch(() => {});
    await terminateOcr();
  }
}
