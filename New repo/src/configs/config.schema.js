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

  tesla: z.object({
    cdpPort: intFromEnv(9223),
    chromeExecutable: z.string().optional(),
  }),

  vw: z.object({
    noCache: z.boolean().default(false),
  }),

  audi: z.object({
    noCache: z.boolean().default(false),
    // When true, drive the configurator with a visible browser (useful for
    // debugging the cookie/consent + "Bereken uw maandprijs" click locally).
    headful: z.boolean().default(false),
  }),

  paths: z.object({
    dataDir: z.string().default('./data'),
    rawDir: z.string(),
    reportsDir: z.string(),
    browserProfilesDir: z.string(),
  }),
});

export const brandConfigSchema = z.object({
  id: z.enum(['bmw', 'mercedes', 'tesla', 'vw', 'audi']),
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
