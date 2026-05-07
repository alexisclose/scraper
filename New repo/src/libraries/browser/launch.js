// Browser launcher with three strategies, used by the Tesla scraper to defeat
// Akamai (and available for any future brand that needs JS-rendered HTML):
//
//   1. cdp-attach     — reuse a Chrome we (or the user) already started with
//                       --remote-debugging-port. Fastest and most stealthy.
//   2. spawn-cdp      — auto-launch the user's installed Chrome with a
//                       dedicated profile and CDP, then attach. Default.
//   3. patchright     — fallback to patchright headful with stealth. Lowest
//                       success rate against Akamai.
import net from 'node:net';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { config } from '../../configs/index.js';
import { findChromeExecutable } from './chrome-detect.js';
import { logger } from '../log/logger.js';
import { BrowserError } from '../error-handling/AppError.js';

function isPortOpen(port, { host = '127.0.0.1', timeout = 800 } = {}) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* */
      }
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
    sock.connect(port, host);
  });
}

async function ensureChromeWithCDP({ port, profileDir, executable, startUrl }) {
  if (await isPortOpen(port)) {
    logger.debug({ port }, 'reusing existing CDP port');
    return;
  }
  if (!executable) {
    throw new BrowserError('No Chromium-family browser found in standard paths', {
      code: 'CHROME_NOT_FOUND',
    });
  }
  mkdirSync(profileDir, { recursive: true });
  logger.info({ port, executable }, 'launching Chrome with CDP');
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--lang=nl-BE',
      ...(startUrl ? [startUrl] : []),
    ],
    { detached: true, stdio: 'ignore', windowsHide: false },
  );
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    if (await isPortOpen(port)) {
      // Give Chrome a moment to render past Akamai before the caller attaches
      await new Promise((r) => setTimeout(r, 6000));
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new BrowserError(`Chrome spawned but CDP port ${port} never opened`, {
    code: 'CDP_TIMEOUT',
  });
}

// Returns { browser, context, cleanup }. Caller is responsible for `cleanup`.
export async function launchBrowser({
  strategy = 'spawn-cdp',
  port = config.tesla.cdpPort,
  profileDir = join(config.paths.browserProfilesDir, 'default'),
  executable = findChromeExecutable(config.tesla.chromeExecutable),
  startUrl = null,
} = {}) {
  if (strategy === 'cdp-attach' || strategy === 'spawn-cdp') {
    if (strategy === 'spawn-cdp') {
      await ensureChromeWithCDP({ port, profileDir, executable, startUrl });
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 6000 });
    const context = browser.contexts()[0] || (await browser.newContext());
    return {
      browser,
      context,
      cleanup: async () => {
        // Don't close the browser — the user (or next run) keeps the session.
      },
    };
  }
  if (strategy === 'patchright') {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      channel: 'chrome',
      locale: 'nl-BE',
      viewport: { width: 1500, height: 900 },
    });
    return {
      browser: null,
      context,
      cleanup: () => context.close(),
    };
  }
  throw new BrowserError(`Unknown launch strategy: ${strategy}`);
}
