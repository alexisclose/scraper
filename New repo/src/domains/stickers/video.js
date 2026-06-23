// Video frame sampling via ffmpeg (best-effort, optional).
//
// Prices in marketing videos appear for a second or two, usually on the closing
// "card". We can't OCR a video directly, so we extract still frames at a fixed
// cadence and OCR each one like an image. One frame per ~1.5s catches the
// price card without exploding the OCR count.
//
// ffmpeg resolution order: FFMPEG_PATH env → the `ffmpeg-static` package (a
// per-platform static binary pulled in as a dependency) → a bare `ffmpeg` on
// PATH. If none works, video scraping is skipped with a warning and the rest
// of the run continues. To use a system ffmpeg instead: set FFMPEG_PATH, e.g.
// `winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg`.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';

let cachedAvailable = null;

// Cheap one-shot probe: does `ffmpeg -version` run? Cached for the process.
export function ffmpegAvailable() {
  if (cachedAvailable !== null) return cachedAvailable;
  try {
    const r = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    cachedAvailable = r.status === 0;
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

/**
 * Extract frames from a video file at a fixed rate.
 * @param {string} videoPath  path to the downloaded video on disk
 * @param {object} [opts]
 * @param {number} [opts.fps=0.66]  frames per second to sample (~1 every 1.5s)
 * @param {number} [opts.maxFrames=20]  cap so a long film can't blow up OCR
 * @returns {Promise<Array<{buffer:Buffer, timestampSec:number}>>}
 */
export async function extractFrames(videoPath, { fps = 0.66, maxFrames = 20 } = {}) {
  if (!ffmpegAvailable()) return [];
  const dir = mkdtempSync(join(tmpdir(), 'sticker-frames-'));
  try {
    await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        videoPath,
        '-vf',
        `fps=${fps}`,
        '-frames:v',
        String(maxFrames),
        '-q:v',
        '2',
        join(dir, 'frame-%03d.jpg'),
      ];
      const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`)),
      );
    });

    return readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f, i) => ({
        buffer: readFileSync(join(dir, f)),
        timestampSec: Math.round(((i + 1) / fps) * 10) / 10,
      }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
