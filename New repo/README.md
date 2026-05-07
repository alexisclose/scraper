# be-lease-scraper

Scrapes business finance/lease offers (Financiële Renting) from the Belgian
configurator websites of **BMW**, **Mercedes-Benz**, **Tesla** and
**Volkswagen** into a unified schema, then writes a single Excel workbook with
one sheet per brand.

Built as a CLI tool, not a server. Each brand is an independent **adapter**
under `src/domains/<brand>/` exposing `run(ctx)` → array of validated
`LeaseOffer` records. New brands are added by dropping in another folder.

## Quick start

```bash
nvm use            # Node 20+
npm install
cp .env.example .env

# scrape every brand and write data/raw/{brand}.json
npm run scrape:all

# build the consolidated workbook from the JSON snapshots
npm run build-excel

# or, single brand:
npm run scrape:tesla
```

## Architecture

```
src/
  index.js                       yargs CLI entry
  commands/                      `scrape` + `build-excel`
  configs/                       loaded once at startup, Zod-validated
    brands/{bmw,mercedes,tesla,vw}.json     URLs, product names, defaults
  libraries/                     cross-cutting modules
    currency/parse.js            parseEur / formatEur
    finance/{btw,irr}.js         BTW conversions + IRR solver
    schema/lease-offer.js        the canonical LeaseOffer Zod schema
    log/logger.js                pino + per-brand child logger
    error-handling/AppError.js   AppError, FetchError, ParseError, BrowserError
    io/{json-store,json-cache}.js
    http/fetch.js                fetch + timeout + retry + concurrency
    browser/{launch,chrome-detect}.js
  domains/
    shared/brand-adapter.js      typed contract + default Excel-row mapper
    bmw/                         Playwright + intercepted JSON
    mercedes/                    pure HTTP — VMOS catalogue + FCIS calc API
    tesla/                       CDP-attached real Chrome (Akamai)
    vw/                          pure HTTP, regex-parses the legal mention
```

### `LeaseOffer` schema

Every brand adapter MUST return objects that satisfy
`libraries/schema/lease-offer.js`. The adapter calls `validateOffer()` itself
at the boundary so a regression in the upstream HTML/JSON never silently
produces garbage downstream. The Excel writer is driven off the same shape.

### Logging

Pino, structured. `LOG_PRETTY=1` (default in development) pipes through
`pino-pretty` for readable colourised output; in `NODE_ENV=production` the
raw JSON stream is emitted so log aggregators (Datadog, Loki, etc.) can
parse it.

### Error handling

Domain errors extend `AppError` and carry a `code` (e.g. `BMW_NO_CALC`,
`TESLA_NO_TRIMS`). The CLI top-level catches `AppError` at `warn`; everything
else bubbles as `error`. A failed brand never blocks other brands in
`scrape --brand=all`.

### Concurrency

A single `p-limit(HTTP_CONCURRENCY)` is shared across HTTP callers. Brand
adapters that need stricter limits (BMW caps at 4 to avoid rate-limiting)
take a `min()` against the global cap.

## Per-brand notes

### Tesla

Tesla's design page is behind aggressive Akamai bot detection. Headless
browsers — even patchright + persistent profile — get a 403. Strategy:

1. `libraries/browser/launch.js` auto-spawns the user's real installed
   Chrome (or Edge / Brave / Chromium — `chrome-detect.js` finds the first
   one available on Windows / macOS / Linux) with
   `--remote-debugging-port=9223` and a dedicated profile under
   `.browser-profiles/tesla/`.
2. patchright connects via CDP and drives the page.
3. Cookies + Akamai trust accumulate in the profile across runs, so steady
   state is fully unattended.

If you have Chrome already running with a different profile that's fine —
the dedicated profile is independent.

### Mercedes-Benz

Pure HTTP — no browser at all. Two endpoints:

- **VMOS** (`api.oneweb.mercedes-benz.com/vmos-api/...`) returns the
  catalogue with 4-digit `bm4` per variant.
- **FCIS** calc API needs a 7-digit `baumuster`. We append a per-series
  suffix from `domains/mercedes/data/known-suffixes.json`; unknown series
  fall back to `"111"`.

A two-step "init then real calc" dance with a forced
`firstPayment = 20% × carPriceNet` and `duration = 60` mirrors what the
configurator does when you pick "Zakelijk → Financiële Renting".

### BMW

Each model URL on `configure.bmw.be` triggers a POST to
`/operations/default-calculation` whose JSON body contains both the PRIVATE
("BMW Select") and BUSINESS ("Financial Renting") offers. We just intercept
the response and pick the BUSINESS one — defaults are already 60 mo / 20%.

### Volkswagen

Plain HTTP. The `legal-mention-monthly` modal in the static HTML carries the
term, mileage, downpayment, residual %, and bonus-malus. A small candidate
slug list (`domains/vw/data/candidate-slugs.json`) is HEAD-probed at startup
and cached for 24 h to avoid re-checking 22 URLs per run; pass `VW_NO_CACHE=1`
to bypass.

## Configuration

All configuration is environment-driven and validated by Zod at startup.

| Var                  | Default       | Purpose                                 |
| -------------------- | ------------- | --------------------------------------- |
| `LOG_LEVEL`          | `info`        | pino level                              |
| `LOG_PRETTY`         | dev: `1`      | pretty-print logs                       |
| `HTTP_TIMEOUT_MS`    | `20000`       | per-request abort timeout               |
| `HTTP_MAX_RETRIES`   | `3`           | exponential-backoff retries on 5xx/timeout |
| `HTTP_CONCURRENCY`   | `8`           | global parallel-request cap             |
| `TESLA_CDP_PORT`     | `9223`        | port for the auto-spawned Chrome        |
| `TESLA_CHROME`       | _auto_        | override the detected Chrome path       |
| `VW_NO_CACHE`        | `0`           | skip the slug-discovery cache           |
| `DATA_DIR`           | `./data`      | output root                             |

## Development

```bash
npm test                 # jest, ESM mode
npm run lint             # eslint
npm run lint:fix
npm run format           # prettier --write
npm run format:check
```

A pre-commit hook (Husky + lint-staged) runs ESLint and Prettier on staged
files. CI mirrors the same: `format:check`, `lint`, `test` on every push and
pull request (`.github/workflows/ci.yml`).

## Adding a new brand

1. `mkdir src/domains/<id>` with `index.js`, `fetcher.js`, `parser.js`.
2. Add `src/configs/brands/<id>.json` matching `brandConfigSchema`.
3. Add `<id>` to the enum in `libraries/schema/lease-offer.js`.
4. Register the adapter in `commands/scrape.js` and `commands/build-excel.js`.
5. Add a parser test under `test/domains/<id>-parser.test.js`.

## License

Internal / unlicensed.
