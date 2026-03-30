import { YNABClient } from '../api';
import { loadConfig } from '../config';
import { formatAmount, formatDate, todayISO } from '../format';
import type { DaySummary, Transaction, CategorySpend, AccountSpend } from '../types';
import chalk from 'chalk';

interface SummaryOptions {
  date?: string;
  json?: boolean;
}

function buildSummary(transactions: Transaction[], date: string): DaySummary {
  const dayTxns = transactions.filter((t) => t.date === date && !t.deleted);

  let totalInflow = 0;
  let totalOutflow = 0;
  let uncategorizedCount = 0;

  const categoryMap = new Map<string, CategorySpend>();
  const accountMap = new Map<string, AccountSpend>();

  for (const t of dayTxns) {
    if (t.amount > 0) {
      totalInflow += t.amount;
    } else {
      totalOutflow += t.amount;
    }

    // Count uncategorized (no category_id, excluding transfers)
    if (!t.category_id && !t.transfer_account_id) {
      uncategorizedCount++;
    }

    // Category aggregation
    const catKey = t.category_id ?? '__none__';
    const catName = t.category_name ?? '(Uncategorized)';
    const existing = categoryMap.get(catKey);
    if (existing) {
      existing.total += t.amount;
      existing.count++;
    } else {
      categoryMap.set(catKey, {
        categoryId: t.category_id,
        categoryName: catName,
        total: t.amount,
        count: 1,
      });
    }

    // Account aggregation
    const accExisting = accountMap.get(t.account_id);
    if (accExisting) {
      accExisting.total += t.amount;
      accExisting.count++;
    } else {
      accountMap.set(t.account_id, {
        accountId: t.account_id,
        accountName: t.account_name,
        total: t.amount,
        count: 1,
      });
    }
  }

  // Top outflows (biggest expenses)
  const topOutflows = [...dayTxns]
    .filter((t) => t.amount < 0)
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 5);

  const byCategory = [...categoryMap.values()].sort((a, b) => a.total - b.total);
  const byAccount = [...accountMap.values()].sort((a, b) => a.total - b.total);

  return {
    date,
    totalInflow,
    totalOutflow,
    net: totalInflow + totalOutflow,
    transactionCount: dayTxns.length,
    uncategorizedCount,
    topOutflows,
    byCategory,
    byAccount,
  };
}

export async function summaryCommand(opts: SummaryOptions): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);
  const date = opts.date ?? todayISO();

  if (!opts.json) console.log(chalk.gray(`Fetching transactions for ${date}...`));

  const transactions = await client.getTransactions(config.budgetId, date);
  const summary = buildSummary(transactions, date);

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // ── Human-readable output ──────────────────────────────────────────────
  console.log();
  console.log(
    chalk.bold.cyan(`  Day Summary — ${formatDate(date)}  (${config.budgetName})`)
  );
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  console.log(
    `  ${chalk.green('Inflow:  ')} ${chalk.green(formatAmount(summary.totalInflow))}`
  );
  console.log(
    `  ${chalk.red('Outflow: ')} ${chalk.red(formatAmount(summary.totalOutflow))}`
  );
  const netColor = summary.net >= 0 ? chalk.green : chalk.red;
  console.log(`  ${chalk.bold('Net:     ')} ${netColor(formatAmount(summary.net))}`);
  console.log(
    `  Transactions: ${summary.transactionCount}  |  Uncategorized: ${
      summary.uncategorizedCount > 0
        ? chalk.yellow(summary.uncategorizedCount)
        : chalk.green(summary.uncategorizedCount)
    }`
  );

  if (summary.topOutflows.length > 0) {
    console.log();
    console.log(chalk.bold('  Top Expenses:'));
    for (const t of summary.topOutflows) {
      const cat = t.category_name ? chalk.gray(` [${t.category_name}]`) : chalk.yellow(' [uncategorized]');
      const payee = t.payee_name ?? t.account_name;
      console.log(
        `    ${chalk.red(formatAmount(t.amount).padStart(10))}  ${payee.padEnd(30)}${cat}`
      );
    }
  }

  if (summary.byCategory.length > 0) {
    console.log();
    console.log(chalk.bold('  Spending by Category:'));
    const outflowCats = summary.byCategory.filter((c) => c.total < 0);
    for (const c of outflowCats) {
      console.log(
        `    ${chalk.red(formatAmount(c.total).padStart(10))}  ${c.categoryName} (${c.count} txn${c.count !== 1 ? 's' : ''})`
      );
    }
  }

  if (summary.transactionCount === 0) {
    console.log(chalk.gray('\n  No transactions found for this date.'));
  }

  console.log();
}
