#!/usr/bin/env node
import { Command } from 'commander';
import { setupCommand } from './commands/setup';
import { syncCommand } from './commands/sync';
import { summaryCommand } from './commands/summary';
import { uncategorizedCommand } from './commands/uncategorized';
import { categorizeCommand } from './commands/categorize';
import { categoriesCommand } from './commands/categories';
import { unapprovedCommand, approveCommand, approveAllCommand } from './commands/approve';
import { budgetHealthCommand } from './commands/budget-health';
import { monthlySummaryCommand } from './commands/monthly-summary';
import { goalsCommand } from './commands/goals';
import { accountsCommand } from './commands/accounts';
import { trendsCommand } from './commands/trends';

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
  .option('-a, --approve', 'also mark the transaction as approved')
  .option('--json', 'output as JSON')
  .action(
    async (
      transactionId: string,
      categoryIdOrName: string,
      opts: { json?: boolean; approve?: boolean }
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

// ── unapproved ────────────────────────────────────────────────────────────
program
  .command('unapproved')
  .alias('unapp')
  .description('List transactions that have not been approved yet')
  .option('-n, --days <number>', 'look back N days (default: 30)', (v) => parseInt(v, 10))
  .option('-d, --date <YYYY-MM-DD>', 'look back since this date (overrides --days)')
  .option('--json', 'output as JSON')
  .action(async (opts: { days?: number; date?: string; json?: boolean }) => {
    await unapprovedCommand(opts);
  });

// ── approve ───────────────────────────────────────────────────────────────
program
  .command('approve <transactionId>')
  .description('Approve a single transaction by ID')
  .option('--json', 'output as JSON')
  .action(async (transactionId: string, opts: { json?: boolean }) => {
    await approveCommand(transactionId, opts);
  });

// ── approve-all ───────────────────────────────────────────────────────────
program
  .command('approve-all')
  .description('Approve all unapproved transactions in a date range')
  .option('-n, --days <number>', 'look back N days (default: 30)', (v) => parseInt(v, 10))
  .option('-d, --date <YYYY-MM-DD>', 'look back since this date (overrides --days)')
  .option('--dry-run', 'preview what would be approved without making changes')
  .option('--json', 'output as JSON')
  .action(async (opts: { days?: number; date?: string; dryRun?: boolean; json?: boolean }) => {
    await approveAllCommand(opts);
  });

// ── budget-health ──────────────────────────────────────────────────────────
program
  .command('budget-health')
  .alias('health')
  .description('Show budget health for the current month — which categories are overspent, on track, or ahead')
  .option('-m, --month <YYYY-MM-01>', 'month to check (default: current month)')
  .option('-s, --status <status>', 'filter by status: overspent | warning | on_track | ahead')
  .option('--json', 'output as JSON')
  .action(async (opts: { month?: string; status?: string; json?: boolean }) => {
    await budgetHealthCommand(opts);
  });

// ── monthly-summary ────────────────────────────────────────────────────────
program
  .command('monthly-summary')
  .alias('month')
  .description('Show income, spending, savings rate, and top groups for the month')
  .option('-m, --month <YYYY-MM-01>', 'month to summarize (default: current month)')
  .option('--json', 'output as JSON')
  .action(async (opts: { month?: string; json?: boolean }) => {
    await monthlySummaryCommand(opts);
  });

// ── goals ──────────────────────────────────────────────────────────────────
program
  .command('goals')
  .description('Show savings goal progress')
  .option('-m, --month <YYYY-MM-01>', 'month context (default: current month)')
  .option('--json', 'output as JSON')
  .action(async (opts: { month?: string; json?: boolean }) => {
    await goalsCommand(opts);
  });

// ── accounts ───────────────────────────────────────────────────────────────
program
  .command('accounts')
  .description('Show account balances and net worth')
  .option('--on-budget', 'show only on-budget accounts')
  .option('--json', 'output as JSON')
  .action(async (opts: { onBudget?: boolean; json?: boolean }) => {
    await accountsCommand(opts);
  });

// ── trends ─────────────────────────────────────────────────────────────────
program
  .command('trends')
  .description('Analyse spending trends across the last N months — shows consistency, trajectory, and suggested budget adjustments')
  .option('-m, --months <number>', 'number of past months to analyse (default: 3, max: 12)', (v) => parseInt(v, 10))
  .option('-g, --group <name>', 'filter by category group name')
  .option('-f, --flag-only', 'show only categories with actionable insights')
  .option('--json', 'output as JSON')
  .action(async (opts: { months?: number; group?: string; flagOnly?: boolean; json?: boolean }) => {
    await trendsCommand(opts);
  });

program.parse(process.argv);

// Show help if no command given
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
