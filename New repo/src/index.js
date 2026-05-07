#!/usr/bin/env node
// CLI entry. Wires yargs commands and installs a top-level error handler so
// uncaught failures terminate the process with a useful (but not stack-spammy)
// message.
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { logger } from './libraries/log/logger.js';
import { AppError } from './libraries/error-handling/AppError.js';
import { scrapeCommand } from './commands/scrape.js';
import { buildExcelCommand } from './commands/build-excel.js';

process.on('unhandledRejection', (err) => {
  if (err instanceof AppError) {
    logger.warn({ code: err.code, msg: err.message }, 'unhandled AppError');
  } else {
    logger.error({ err }, 'unhandledRejection');
  }
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException');
  process.exit(1);
});

await yargs(hideBin(process.argv))
  .scriptName('be-lease-scraper')
  .command(scrapeCommand)
  .command(buildExcelCommand)
  .demandCommand(1, 'Please specify a command (scrape | build-excel)')
  .strict()
  .help()
  .parseAsync();
