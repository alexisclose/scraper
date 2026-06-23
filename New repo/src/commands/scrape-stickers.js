// `scrape-stickers` command — OCR-based scraper for advertised "sticker"
// prices on marketing/offer pages, where the headline figures are baked into
// hero images and video banners rather than the DOM.
//
// Output: data/raw/stickers.json (or --out), a flat array of StickerPrice
// observations. Reads its page list from src/domains/stickers/data/targets.json
// unless --url is given.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../configs/index.js';
import { writeJson } from '../libraries/io/json-store.js';
import { brandLogger, logger } from '../libraries/log/logger.js';
import { runStickers } from '../domains/stickers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGETS_PATH = join(__dirname, '..', 'domains', 'stickers', 'data', 'targets.json');

export const scrapeStickersCommand = {
  command: 'scrape-stickers',
  describe: 'Scrape advertised sticker prices (incl. prices inside images/videos via OCR)',
  builder: (yargs) =>
    yargs
      .option('url', {
        type: 'array',
        describe: 'One or more page URLs to scrape (overrides the targets file)',
      })
      .option('brand', {
        type: 'string',
        describe: 'Brand label applied to --url targets',
        default: 'unknown',
      })
      .option('images', {
        type: 'boolean',
        describe: 'OCR images for prices (use --no-images to skip)',
        default: true,
      })
      .option('videos', {
        type: 'boolean',
        describe: 'OCR video frames for prices (use --no-videos to skip)',
        default: true,
      })
      .option('out', { type: 'string', describe: 'Output file path' }),
  handler: async (argv) => {
    const runId = new Date().toISOString();
    const log = brandLogger('stickers');

    const targets = argv.url
      ? argv.url.map((url) => ({ url, brand: argv.brand }))
      : JSON.parse(readFileSync(TARGETS_PATH, 'utf8'));

    const outPath = argv.out || join(config.paths.rawDir, 'stickers.json');
    const t0 = Date.now();
    try {
      const records = await runStickers({
        logger: log,
        runId,
        targets,
        opts: { images: argv.images, videos: argv.videos },
      });
      writeJson(outPath, records);
      const priceCount = records.reduce((n, r) => n + r.prices.length, 0);
      log.info(
        { records: records.length, prices: priceCount, ms: Date.now() - t0, path: outPath },
        'sticker scrape done',
      );
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'sticker scrape failed');
      process.exit(1);
    }
  },
};
