// HTTP fetch wrapper: timeout via AbortController, exponential-backoff retry
// via p-retry, and a global concurrency limit shared across all callers in a
// scrape run. Uses the platform `fetch` (Node 20+).
import pRetry, { AbortError } from 'p-retry';
import pLimit from 'p-limit';
import { config } from '../../configs/index.js';
import { logger } from '../log/logger.js';
import { FetchError } from '../error-handling/AppError.js';

const limit = pLimit(config.http.concurrency);

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'nl-BE,nl;q=0.9',
};

async function singleAttempt(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { ...DEFAULT_HEADERS, ...(init?.headers || {}) },
    });
    if (!res.ok) {
      // 4xx is permanent — don't keep retrying.
      const isClient = res.status >= 400 && res.status < 500 && res.status !== 429;
      const err = new FetchError(`HTTP ${res.status} for ${url}`, {
        code: 'HTTP_' + res.status,
        context: { url, status: res.status },
      });
      throw isClient ? new AbortError(err) : err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export function httpFetch(url, init = {}) {
  const timeoutMs = init.timeoutMs ?? config.http.timeoutMs;
  const retries = init.retries ?? config.http.maxRetries;
  return limit(() =>
    pRetry(() => singleAttempt(url, init, timeoutMs), {
      retries,
      minTimeout: 500,
      factor: 2,
      onFailedAttempt: (err) => {
        logger.warn({ url, attempt: err.attemptNumber, msg: err.message }, 'http retry');
      },
    }),
  );
}

export async function httpJson(url, init) {
  const res = await httpFetch(url, init);
  return res.json();
}

export async function httpText(url, init) {
  const res = await httpFetch(url, init);
  return res.text();
}
