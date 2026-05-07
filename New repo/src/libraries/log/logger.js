// Pino-based structured logger. In dev (LOG_PRETTY=1 or non-production
// NODE_ENV) we pipe through pino-pretty for readability; in CI / prod the
// raw JSON stream is emitted so log aggregators (Datadog, Loki, etc.) can
// parse it.
import pino from 'pino';
import { config } from '../../configs/index.js';

const baseOptions = {
  level: config.logLevel,
  base: { service: 'be-lease-scraper' },
  timestamp: pino.stdTimeFunctions.isoTime,
};

export const logger = config.logPretty
  ? pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname,service',
          translateTime: 'HH:MM:ss.l',
        },
      },
    })
  : pino(baseOptions);

// Per-brand child logger so log lines automatically carry { brand: 'tesla' }.
export function brandLogger(brandId) {
  return logger.child({ brand: brandId });
}
