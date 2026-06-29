// Zod schema for environment-driven runtime config. Anything the scraper
// reads from process.env passes through here so we fail fast on bad input.
import { z } from 'zod';

const intFromEnv = (def) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => parseInt(String(v), 10))
    .default(def);

export const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  logPretty: z.boolean().default(true),

  http: z.object({
    timeoutMs: intFromEnv(20000),
    maxRetries: intFromEnv(3),
    concurrency: intFromEnv(8),
  }),

  bmw: z.object({
    // Browsers run in parallel across BMW's model sweep, capped lower than HTTP
    // because BMW's public site rate-limits. The all-brand two-lane runner
    // overrides this down further while Audi runs concurrently (see scrape.js).
    concurrency: intFromEnv(4),
  }),

  tesla: z.object({
    cdpPort: intFromEnv(9223),
    chromeExecutable: z.string().optional(),
  }),

  vw: z.object({
    noCache: z.boolean().default(false),
    // The knobs below drive the configurator-based `vw-finance` adapter (the
    // plain `vw` adapter is pure HTTP and ignores them).
    // When true, drive the configurator with a visible browser (debugging the
    // cookie wall + "Bereken mijn maandprijs" click locally).
    headful: z.boolean().default(false),
    // Number of browsers run in parallel across the trim sweep.
    concurrency: intFromEnv(3),
    // oneapi.volkswagen.com x-api-key used to resolve each trim's default
    // modelId (E-code). It's the public key the configurator JS itself sends;
    // override via VW_ONEAPI_KEY if VW rotates it.
    oneapiKey: z.string().default('Ox5AegtsLDecFmKHxYdf599VKBCpHsX4'),
    // VW_LIMIT: cap the number of models scraped (0 = all). Diagnostic knob for
    // fast iteration — scrape the first N discovered models instead of all ~45.
    limit: intFromEnv(0),
  }),

  audi: z.object({
    noCache: z.boolean().default(false),
    // When true, drive the configurator with a visible browser (useful for
    // debugging the cookie/consent + "Bereken uw maandprijs" click locally).
    headful: z.boolean().default(false),
    // Number of browsers run in parallel across the model sweep.
    concurrency: intFromEnv(3),
  }),

  paths: z.object({
    dataDir: z.string().default('./data'),
    rawDir: z.string(),
    reportsDir: z.string(),
    browserProfilesDir: z.string(),
  }),
});

export const brandConfigSchema = z.object({
  id: z.enum(['bmw', 'mercedes', 'tesla', 'vw', 'vw-finance', 'audi']),
  displayName: z.string(),
  productName: z.string(),
  productId: z.string(),
  endpoints: z.record(z.string()),
  labels: z.record(z.string()).optional(),
  defaults: z
    .object({
      durationMonths: z.number().optional(),
      annualMileage: z.number().optional(),
      firstPaymentPct: z.number().optional(),
      vatRate: z.number().default(0.21),
    })
    .partial(),
});
