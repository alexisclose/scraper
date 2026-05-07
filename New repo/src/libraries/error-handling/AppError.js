// Domain error class. Distinguishes "expected" failures (a brand site returns
// 503; a regex doesn't match because the page changed) from programmer errors
// (TypeError etc.). The CLI top-level catch only logs `AppError` instances at
// `warn` level; everything else is bubbled as a stack-trace at `error`.

export class AppError extends Error {
  constructor(message, { code, cause, context } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code || 'APP_ERROR';
    this.context = context;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class FetchError extends AppError {
  constructor(message, opts) {
    super(message, { ...opts, code: opts?.code || 'FETCH_ERROR' });
    this.name = 'FetchError';
  }
}

export class ParseError extends AppError {
  constructor(message, opts) {
    super(message, { ...opts, code: opts?.code || 'PARSE_ERROR' });
    this.name = 'ParseError';
  }
}

export class BrowserError extends AppError {
  constructor(message, opts) {
    super(message, { ...opts, code: opts?.code || 'BROWSER_ERROR' });
    this.name = 'BrowserError';
  }
}
