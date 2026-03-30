#!/usr/bin/env node
import { Command } from 'commander';
import { setupCommand } from './commands/setup';
import { syncCommand } from './commands/sync';
import { summaryCommand } from './commands/summary';
import { uncategorizedCommand } from './commands/uncategorized';
import { categorizeCommand } from './commands/categorize';
import { categoriesCommand } from './commands/categories';

const program = new Command();

program
  .name('ynab')
  .description('YNAB CLI — budget management from the terminal')
  .version('1.0.0');

// ── setup ─────────────────────────────────────────────────────────────────
program
  .command('setup')
  .description('Configure YNAB API token and default budget (interactive)')
  .option('-f, --force', 'overwrite existing configuration')
  .action(async (opts: { force?: boolean }) => {
    await setupCommand(opts);
  });

// ── sync ──────────────────────────────────────────────────────────────────
program
  .command('sync')
  .description('Sync categories from YNAB to local cache (~/.ynab-cli/categories.json)')
  .option('--json', 'output as JSON')
  .action(async (opts: { json?: boolean }) => {
    await syncCommand(opts);
  });

// ── summary ───────────────────────────────────────────────────────────────
program
  .command('summary')
  .description('Show a spending summary for a given day (default: today)')
  .option('-d, --date <YYYY-MM-DD>', 'date to summarize (default: today)')
  .option('--json', 'output as JSON')
  .action(async (opts: { date?: string; json?: boolean }) => {
    await summaryCommand(opts);
  });

// ── uncategorized ─────────────────────────────────────────────────────────
program
  .command('uncategorized')
  .alias('unc')
  .description('List transactions that have no category assigned')
  .option(
    '-n, --days <number>',
    'look back N days (default: 30)',
    (v) => parseInt(v, 10)
  )
  .option('-d, --date <YYYY-MM-DD>', 'look back since this date (overrides --days)')
  .option('--json', 'output as JSON')
  .action(async (opts: { days?: number; date?: string; json?: boolean }) => {
    await uncategorizedCommand(opts);
  });

// ── categorize ────────────────────────────────────────────────────────────
program
  .command('categorize <transactionId> <categoryIdOrName>')
  .alias('cat')
  .description(
    'Assign a category to a transaction.\n' +
      '  <categoryIdOrName> can be a YNAB category UUID or a category name (uses fuzzy match).'
  )
  .option('--json', 'output as JSON')
  .action(
    async (
      transactionId: string,
      categoryIdOrName: string,
      opts: { json?: boolean }
    ) => {
      await categorizeCommand(transactionId, categoryIdOrName, opts);
    }
  );

// ── categories ────────────────────────────────────────────────────────────
program
  .command('categories')
  .alias('cats')
  .description('List cached categories (run `ynab sync` to refresh)')
  .option('-s, --search <term>', 'filter by name or group name')
  .option('-g, --group <name>', 'filter by group name')
  .option('--show-hidden', 'include hidden categories')
  .option('--json', 'output as JSON')
  .action(
    (opts: { search?: string; group?: string; showHidden?: boolean; json?: boolean }) => {
      categoriesCommand(opts);
    }
  );

program.parse(process.argv);

// Show help if no command given
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
