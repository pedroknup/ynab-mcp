import { YNABClient } from '../api';
import { loadConfig } from '../config';
import { formatAmount, formatDate, daysAgoISO, todayISO } from '../format';
import type { Transaction } from '../types';
import chalk from 'chalk';
import { table } from 'table';

interface UncategorizedOptions {
  days?: number;
  date?: string;
  json?: boolean;
}

function isUncategorized(t: Transaction): boolean {
  // Exclude deleted, transfers, and already-categorized
  return (
    !t.deleted &&
    !t.transfer_account_id &&
    !t.category_id
  );
}

export async function uncategorizedCommand(opts: UncategorizedOptions): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);

  let sinceDate: string;
  if (opts.date) {
    sinceDate = opts.date;
  } else {
    sinceDate = daysAgoISO(opts.days ?? 30);
  }

  if (!opts.json) {
    console.log(chalk.gray(`Fetching uncategorized transactions since ${sinceDate}...`));
  }

  const transactions = await client.getTransactions(config.budgetId, sinceDate, 'uncategorized');
  const uncategorized = transactions.filter(isUncategorized);

  if (opts.json) {
    console.log(
      JSON.stringify(
        uncategorized.map((t) => ({
          id: t.id,
          date: t.date,
          amount: t.amount,
          amount_formatted: formatAmount(t.amount),
          payee_name: t.payee_name,
          account_name: t.account_name,
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

  if (uncategorized.length === 0) {
    console.log(chalk.green('No uncategorized transactions found.'));
    return;
  }

  // Sort: newest first
  uncategorized.sort((a, b) => b.date.localeCompare(a.date));

  const rows = uncategorized.map((t) => [
    chalk.cyan(t.id),
    formatDate(t.date),
    t.amount < 0 ? chalk.red(formatAmount(t.amount)) : chalk.green(formatAmount(t.amount)),
    t.payee_name ?? chalk.gray('—'),
    t.account_name,
    t.memo ? chalk.gray(t.memo.slice(0, 30)) : '',
  ]);

  console.log(
    table(
      [
        [
          chalk.bold('Transaction ID'),
          chalk.bold('Date'),
          chalk.bold('Amount'),
          chalk.bold('Payee'),
          chalk.bold('Account'),
          chalk.bold('Memo'),
        ],
        ...rows,
      ],
      {
        columns: {
          0: { width: 36 },
          1: { width: 10 },
          2: { width: 12, alignment: 'right' },
          3: { width: 26, truncate: 26 },
          4: { width: 20, truncate: 20 },
          5: { width: 30, truncate: 30 },
        },
      }
    )
  );

  console.log(
    chalk.yellow(`${uncategorized.length} uncategorized transaction(s) since ${formatDate(sinceDate)}`)
  );
  console.log(
    chalk.gray(
      `Use: ynab categorize <transaction-id> <category-id>  to assign a category`
    )
  );
}
