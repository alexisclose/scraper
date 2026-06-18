// OCR engine wrapper over tesseract.js.
//
// Why tesseract.js and not a cloud OCR (Google Vision / AWS Textract / Azure)?
//   - Zero credentials, zero per-call cost, no data leaving the machine — this
//     repo already runs unattended on a schedule, and a free local engine
//     keeps it that way.
//   - Pure WASM: no native build step, works on the Windows dev box and Linux
//     CI identically (the rest of the toolchain is deliberately native-dep-free).
//
// The trade-off is accuracy on stylised marketing type. We mitigate that in
// fetcher.js by OCR'ing the *original* downloaded asset (full resolution) and
// by classifying with a forgiving regex (parser.js). If you later need higher
// accuracy on hard creatives, swap THIS module for a cloud backend — the rest
// of the pipeline only depends on `recognize(buffer) -> { text, confidence }`.
//
// Language pack: nld+fra+eng (Belgium is bilingual; eng catches "from"/"now").
// On first run tesseract.js downloads the traineddata to OCR_CACHE_DIR and
// reuses it thereafter, so only the first invocation needs network.
import { mkdirSync } from 'node:fs';
import { config } from '../../configs/index.js';
import { logger } from '../../libraries/log/logger.js';

const LANGS = process.env.OCR_LANGS || 'nld+fra+eng';
const CACHE_DIR = process.env.OCR_CACHE_DIR || `${config.paths.dataDir}/.ocr-cache`;

let workerPromise = null;

// Lazily import tesseract.js so the module graph (and `build-excel`, tests,
// etc.) doesn't pay the cost unless OCR is actually used.
async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    let createWorker;
    try {
      ({ createWorker } = await import('tesseract.js'));
    } catch (e) {
      throw new Error(
        'tesseract.js is not installed. Run `npm install tesseract.js` in "New repo/". ' +
          `Original error: ${e.message}`,
      );
    }
    logger.info({ langs: LANGS, cacheDir: CACHE_DIR }, 'initialising OCR worker');
    const worker = await createWorker(LANGS, 1, {
      cachePath: CACHE_DIR,
      logger: () => {}, // tesseract is very chatty; route nothing to stdout
    });
    // PSM 11 = "sparse text": find as much text as possible regardless of
    // layout. Marketing banners scatter a price across a photo rather than
    // laying it out as a paragraph, and the default PSM (3, single column)
    // misses those — sparse mode roughly doubles the price hit-rate here.
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    return worker;
  })();
  return workerPromise;
}

/**
 * OCR a single image buffer.
 * @param {Buffer} buffer  raw image bytes (png/jpg/webp — tesseract sniffs)
 * @returns {Promise<{text:string, confidence:number}>}
 */
export async function recognize(buffer) {
  const worker = await getWorker();
  const {
    data: { text, confidence },
  } = await worker.recognize(buffer);
  return { text: text || '', confidence: typeof confidence === 'number' ? confidence : null };
}

export async function terminateOcr() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {
    /* best-effort */
  } finally {
    workerPromise = null;
  }
}
