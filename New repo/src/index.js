#!/usr/bin/env node
// CLI entry. Wires yargs commands and installs a top-level error handler so
// uncaught failures terminate the process with a useful (but not stack-spammy)
// message.
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { logger } from './libraries/log/logger.js';
import { AppError } from './libraries/error-handling/AppError.js';
import { scrapeCommand } from './commands/scrape.js';
import { scrapeStickersCommand } from './commands/scrape-stickers.js';
import { buildExcelCommand } from './commands/build-excel.js';

// Playwright/patchright surface CDP failures for targets that die while they are
// still being attached — e.g. `Network.setCacheDisabled: Internal server error,
// session closed` when a popup (or the whole detached spawn-cdp Chrome) goes away
// mid-initialisation. Those rejections belong to work we have already abandoned
// and carry no listener of their own, so they arrive here. Exiting on them is how
// one Audi lane recycling its browser took down an entire `scrape:all` run: the
// process died while BMW was mid-sweep. They are logged and swallowed; every
// other unhandled rejection stays fatal.
const BROWSER_TEARDOWN_RX =
  /session closed|target (?:page|browser|context)?\s*(?:closed|crashed)|protocol error|connection closed|browser has been closed|websocket|net::ERR_ABORTED|Execution context was destroyed/i;

process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (BROWSER_TEARDOWN_RX.test(msg)) {
    logger.warn({ msg: msg.split('\n')[0] }, 'ignored browser-teardown rejection (run continues)');
    return;
  }
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
  .command(scrapeStickersCommand)
  .command(buildExcelCommand)
  .demandCommand(1, 'Please specify a command (scrape | scrape-stickers | build-excel)')
  .strict()
  .help()
  .parseAsync();
