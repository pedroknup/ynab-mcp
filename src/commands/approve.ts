import { YNABClient } from '../api';
import { loadConfig } from '../config';
import { formatAmount, formatDate, daysAgoISO } from '../format';
import type { Transaction } from '../types';
import chalk from 'chalk';
import { table } from 'table';

interface UnapprovedOptions {
  days?: number;
  date?: string;
  json?: boolean;
}

interface ApproveOptions {
  json?: boolean;
}

interface ApproveAllOptions {
  days?: number;
  date?: string;
  json?: boolean;
  dryRun?: boolean;
}

function isUnapproved(t: Transaction): boolean {
  return !t.deleted && !t.approved;
}

// ── list unapproved ───────────────────────────────────────────────────────────

export async function unapprovedCommand(opts: UnapprovedOptions): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);
  const sinceDate = opts.date ?? daysAgoISO(opts.days ?? 30);

  if (!opts.json) console.log(chalk.gray(`Fetching unapproved transactions since ${sinceDate}...`));

  const transactions = await client.getTransactions(config.budgetId, sinceDate, 'unapproved');
  const unapproved = transactions.filter(isUnapproved).sort((a, b) => b.date.localeCompare(a.date));

  if (opts.json) {
    console.log(
      JSON.stringify(
        unapproved.map((t) => ({
          id: t.id,
          date: t.date,
          amount: t.amount,
          amount_formatted: formatAmount(t.amount),
          payee_name: t.payee_name,
          account_name: t.account_name,
          category_name: t.category_name,
          memo: t.memo,
          cleared: t.cleared,
          approved: t.approved,
        })),
        null,
        2
      )
    );
    return;
  }

  if (unapproved.length === 0) {
    console.log(chalk.green('No unapproved transactions found.'));
    return;
  }

  const rows = unapproved.map((t) => [
    chalk.cyan(t.id),
    formatDate(t.date),
    t.amount < 0 ? chalk.red(formatAmount(t.amount)) : chalk.green(formatAmount(t.amount)),
    t.payee_name ?? chalk.gray('—'),
    t.category_name ? chalk.white(t.category_name) : chalk.yellow('(uncategorized)'),
    t.account_name,
  ]);

  console.log(
    table(
      [
        [
          chalk.bold('Transaction ID'),
          chalk.bold('Date'),
          chalk.bold('Amount'),
          chalk.bold('Payee'),
          chalk.bold('Category'),
          chalk.bold('Account'),
        ],
        ...rows,
      ],
      {
        columns: {
          0: { width: 36 },
          1: { width: 10 },
          2: { width: 12, alignment: 'right' },
          3: { width: 26, truncate: 26 },
          4: { width: 24, truncate: 24 },
          5: { width: 20, truncate: 20 },
        },
      }
    )
  );

  const uncatCount = unapproved.filter((t) => !t.category_id && !t.transfer_account_id).length;
  console.log(chalk.yellow(`${unapproved.length} unapproved transaction(s) since ${formatDate(sinceDate)}`));
  if (uncatCount > 0) {
    console.log(chalk.yellow(`  ${uncatCount} of those are also uncategorized — use \`ynab categorize --approve\` to handle both at once`));
  }
  console.log(chalk.gray(`  Use: ynab approve <id>  or  ynab approve-all  to approve`));
}

// ── approve single ────────────────────────────────────────────────────────────

export async function approveCommand(transactionId: string, opts: ApproveOptions): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);

  if (!opts.json) console.log(chalk.gray(`Approving transaction ${transactionId}...`));

  let updated;
  try {
    updated = await client.updateTransaction(config.budgetId, transactionId, { approved: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Failed to approve transaction: ${msg}`));
    process.exit(1);
  }

  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        transaction: {
          id: updated.id,
          date: updated.date,
          amount: updated.amount,
          amount_formatted: formatAmount(updated.amount),
          payee_name: updated.payee_name,
          category_name: updated.category_name,
          approved: updated.approved,
        },
      })
    );
    return;
  }

  console.log(chalk.green('Transaction approved!'));
  console.log(`  Date:     ${formatDate(updated.date)}`);
  console.log(`  Amount:   ${formatAmount(updated.amount)}`);
  console.log(`  Payee:    ${updated.payee_name ?? '—'}`);
  console.log(`  Category: ${updated.category_name ?? chalk.yellow('(uncategorized)')}`);
  console.log();
}

// ── approve all ───────────────────────────────────────────────────────────────

export async function approveAllCommand(opts: ApproveAllOptions): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);
  const sinceDate = opts.date ?? daysAgoISO(opts.days ?? 30);

  if (!opts.json) console.log(chalk.gray(`Fetching unapproved transactions since ${sinceDate}...`));

  const transactions = await client.getTransactions(config.budgetId, sinceDate, 'unapproved');
  const unapproved = transactions.filter(isUnapproved);

  if (unapproved.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, approved_count: 0 }));
    } else {
      console.log(chalk.green('No unapproved transactions to approve.'));
    }
    return;
  }

  if (opts.dryRun) {
    console.log(chalk.yellow(`Dry run — would approve ${unapproved.length} transaction(s):`));
    for (const t of unapproved) {
      console.log(`  ${formatDate(t.date)}  ${formatAmount(t.amount).padStart(10)}  ${t.payee_name ?? '—'}`);
    }
    return;
  }

  if (!opts.json) {
    console.log(chalk.gray(`Approving ${unapproved.length} transaction(s)...`));
  }

  // Approve in parallel (YNAB rate limit: 200/hr — safe for typical use)
  const results = await Promise.allSettled(
    unapproved.map((t) =>
      client.updateTransaction(config.budgetId, t.id, { approved: true })
    )
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed    = results.filter((r) => r.status === 'rejected').length;

  if (opts.json) {
    console.log(JSON.stringify({ ok: failed === 0, approved_count: succeeded, failed_count: failed }));
    return;
  }

  console.log(chalk.green(`\nApproved ${succeeded} transaction(s).`));
  if (failed > 0) console.log(chalk.red(`  ${failed} failed — check your connection and try again.`));
  console.log();
}
