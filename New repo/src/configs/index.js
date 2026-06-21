// Loads and validates runtime config from process.env. Brand-specific config
// (URLs, endpoints, product names) lives under ./brands/*.json so adding a new
// brand never requires editing this file.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, brandConfigSchema } from './config.schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function bool(v) {
  if (v === undefined || v === '') return undefined;
  return v === '1' || v === 'true' || v === 'yes';
}

function buildConfig() {
  const env = process.env;
  const dataDir = resolve(env.DATA_DIR || './data');
  const raw = {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    logPretty: bool(env.LOG_PRETTY) ?? env.NODE_ENV !== 'production',
    http: {
      timeoutMs: env.HTTP_TIMEOUT_MS,
      maxRetries: env.HTTP_MAX_RETRIES,
      concurrency: env.HTTP_CONCURRENCY,
    },
    tesla: {
      cdpPort: env.TESLA_CDP_PORT,
      chromeExecutable: env.TESLA_CHROME || undefined,
    },
    vw: {
      noCache: bool(env.VW_NO_CACHE) ?? false,
    },
    audi: {
      noCache: bool(env.AUDI_NO_CACHE) ?? false,
      headful: bool(env.AUDI_HEADFUL) ?? false,
      concurrency: env.AUDI_CONCURRENCY,
    },
    paths: {
      dataDir,
      rawDir: join(dataDir, 'raw'),
      reportsDir: join(dataDir, 'reports'),
      browserProfilesDir: join(dataDir, '..', '.browser-profiles'),
    },
  };

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('Invalid runtime config:', parsed.error.format());
    process.exit(1);
  }
  return parsed.data;
}

export const config = buildConfig();

const brandFiles = ['bmw', 'mercedes', 'tesla', 'vw', 'audi'];
export const brandConfigs = Object.fromEntries(
  brandFiles.map((id) => {
    const json = JSON.parse(readFileSync(join(__dirname, 'brands', `${id}.json`), 'utf8'));
    const parsed = brandConfigSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Invalid brand config (${id}): ${parsed.error.message}`);
    }
    return [id, parsed.data];
  }),
);
