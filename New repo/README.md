# be-lease-scraper

Scrapes business finance/lease offers (Financiële Renting) from the Belgian
configurator websites of **BMW**, **Mercedes-Benz**, **Tesla**,
**Volkswagen** and **Audi** into a unified schema, then writes a single Excel
workbook with one sheet per brand.

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

### Audi

Audi (D'Ieteren) finance offers live on the CCF form
`formsccf.audi.be/ccf/nl/finance/formulastep?code=<code>`. The `code` is a
server-side saved quote that is **minted on demand** from the model
configurator on `www.audi.be` (model → _Configuratie bekijken_ → _Bereken uw
maandprijs_), and individual codes expire.

The adapter (`domains/audi/`) takes inputs from
`domains/audi/data/candidate-codes.json` (the **full Belgian line-up**, ~17
models):

- **`models`** — configurator `pr=` URLs. A real browser (shared launcher,
  like Tesla) drives the configurator, dismisses the **Ensighten cookie wall**
  (`#ensAcceptAll` in the `#privacy-shadow` shadow root — its overlay otherwise
  intercepts every click), clicks _Bereken uw maandprijs_, follows the redirect
  to `formsccf`, and reads the freshly minted form. Immune to code expiry — add
  models by loading a model's `/configurator/?#summary`, letting it resolve a
  `pr`, and copying the URL.
- **`codes`** — already-minted codes tried over plain proxy-aware HTTP
  (`fetchByCode`). Expired codes 302 to `/ccf/nl/Base/Oops` and are skipped with
  a logged reason.

Models are scraped by a **pool of parallel browsers** (`AUDI_CONCURRENCY`,
default 3). Each worker owns its own Chrome on a dedicated CDP port + ephemeral
profile and recycles it every few models — the detached spawn-cdp Chrome leaks
memory and crashes after a handful of heavy configurator pages, so isolation +
recycling + a one-shot retry keep a full sweep reliable (~8–9 min for the whole
range vs ~50 min serial). A transient model failure is retried once.

**What is scrapeable:**

- **Model + total vehicle price** (gross _incl. BTW_ + net _excl. BTW_, both
  explicitly labelled) come straight from the server-rendered form HTML.
- **Monthly payment** (net + gross) comes from the `POST /ccf/FinanceApi/Calculate`
  JSON response (`PriceVatExcluded` / `PriceVatIncluded`), which the browser
  fetcher captures after selecting _Professionelen → Financiële Renting_. The
  finance calculator is reCAPTCHA-gated, but a **configurator-originated session
  (real browser, persistent profile, Belgian IP) passes the score with no human
  in the loop** — a cold/direct hit to `formsccf` does *not* (it returns
  `FinanceApi/Oops?error=Recaptcha`). We never defeat the reCAPTCHA; we just
  arrive through the legitimate flow. The direct-HTTP `codes` path can't run JS,
  so it yields price-only rows (deduped away when a configurator row exists).
- **Product = Financiële Renting.** The form defaults to *Verhuur lange termijn*
  (Long Term Rental); the fetcher selects the **Financiële Renting** card
  (family with `financing-type = FinancialRenting`) by real mouse-clicking the
  visible card and verifying the radio flips.
- **Down payment = 20%.** Financiële Renting defaults the down payment ("Eerste
  verhoogde huur") to **25% of the catalogue (excl. BTW)**; the fetcher types
  **20% of the net price** into that field and lets the form recalculate, so the
  monthly is always the form's own figure (never computed by us). The % is
  `defaults.firstPaymentPct` in `audi.json`.
- **Term / annual mileage / down / residual** come from the `Calculate` *request*
  body the fetcher captures. Because the down ("Eerste verhoogde huur") and the
  residual ("Aankoopoptie") both default to 25% and are indistinguishable by
  value, the fetcher also reads a `componentId → meaning` map off the form so
  `mapBounds` can label them correctly. `contractMileage`, `interestEffective`
  and `sumOfAllPayments` are then derived (the residual makes the implied rate
  solvable).

Every captured `FinanceApi` response is dumped to `data/cache/audi/` for
calibration. `extractFromFinanceApi` parses the `Calculate` shape precisely with
a sanity-checked heuristic fallback. Pass `AUDI_CONCURRENCY=N` to tune parallel
browsers (lower it if the machine is memory-constrained), `AUDI_HEADFUL=1` to
watch the browser, `AUDI_NO_CACHE=1` to bypass caching. `audi-capture.mjs` (repo
root) captures a live form standalone.

## Sticker-price scraper (`scrape-stickers`)

A second, **brand-agnostic** scraper for the _advertised_ "sticker" prices on
marketing / offer pages — the headline "vanaf € 39.990 / € 475 per maand /
voordeel tot € 5.000" figures. Unlike the brand adapters above (which resolve a
full finance calculation into a `LeaseOffer`), this one captures **observations**
of advertised amounts and, crucially, can read prices that are **baked into
images and video banners** rather than the DOM.

```bash
npm run scrape:stickers                       # uses src/domains/stickers/data/targets.json
node src/index.js scrape-stickers --url https://www.bmw.be/nl/Shop-Online/bmw-offers/2026.html --brand bmw
node src/index.js scrape-stickers --no-videos # text + images only (no ffmpeg needed)
```

Output: `data/raw/stickers.json` — a flat array of `StickerPrice` records
(`libraries/schema/sticker-price.js`), each tagging where the price came from
(`source: 'html' | 'image' | 'video'`), the asset URL, the OCR text +
confidence, and the parsed `prices[]` (`amount`, `kind`, `unit`).

### How prices-in-pictures-and-videos are read — the recommended approach

The pipeline (`domains/stickers/`) is three tiers, cheapest first:

1. **DOM text** (`source: 'html'`) — render the SPA with Playwright, autoscroll
   to trigger lazy-loading, and harvest every visible text node containing a
   euro sign. High precision, ~free. On the BMW 2026 example page _all_ the real
   prices live here as text overlays, so this tier alone returns them.
2. **Images** (`source: 'image'`) — collect every painted image (`currentSrc`,
   largest `srcset` candidate, CSS `background-image`, `og:image`), download the
   **original full-resolution** asset through the browser's session, and OCR it
   with **tesseract.js** (local WASM, langs `nld+fra+eng`). Page-segmentation
   mode 11 ("sparse text") is set because a price floats on a banner rather than
   sitting in a paragraph.
3. **Videos** (`source: 'video'`) — you can't OCR an MP4 directly, so we sample
   one frame every ~1.5 s with **ffmpeg** and OCR each frame like an image. The
   price "card" usually sits in the closing seconds. ffmpeg is an external
   binary (not bundled): if it's missing, video scraping is skipped with a
   warning and the run continues. Install: `winget install Gyan.FFmpeg` /
   `brew install ffmpeg` / `apt install ffmpeg`, or set `FFMPEG_PATH`.

The price extractor (`domains/stickers/parser.js`) is a pure, unit-tested
function that requires a euro indicator next to a number (so model years and
"0% APR" aren't mistaken for prices), tolerates the OCR quirks that show up on
stylised type (`€`→`£`, `/maand`→`Imaand`, stray spaces in thousands groups),
and classifies each amount (`monthly` / `cash` / `discount` / `deposit`) by the
**nearest** keyword so one banner's "Voordeel tot" can't mislabel its catalogue
price.

### Accuracy note & upgrade path

Local OCR reads clean, high-contrast banner text well (~90 %+ confidence in
testing) but **digit accuracy drops on low-contrast prices over busy photos** —
the inherent hard case. The OCR backend is deliberately isolated behind
`recognize(buffer) -> { text, confidence }` in `domains/stickers/ocr.js`: for
production-grade accuracy on hard creatives, swap that one module for a cloud
OCR (Google Cloud Vision, AWS Textract, or Azure AI Vision) — they materially
outperform tesseract on marketing type — and nothing else in the pipeline
changes. The schema even keeps `ocrConfidence` so you can route low-confidence
records to a manual-review queue or a second OCR pass.

### Adding pages

Edit `src/domains/stickers/data/targets.json` (`{ "brand", "url" }` entries),
or pass `--url` (repeatable) on the CLI. Tunables: `STICKER_MAX_IMAGES` (40),
`STICKER_MAX_VIDEOS` (3), `STICKER_MIN_OCR_CONFIDENCE` (30), `OCR_LANGS`,
`OCR_CACHE_DIR`, `FFMPEG_PATH`.

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
