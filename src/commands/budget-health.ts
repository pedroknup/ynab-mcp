import { YNABClient } from '../api';
import { loadConfig } from '../config';
import { formatAmount } from '../format';
import type { BudgetStatus, CategoryHealth } from '../types';
import chalk from 'chalk';

interface BudgetHealthOptions {
  month?: string;
  status?: string;
  json?: boolean;
}

/** Returns YYYY-MM-01 for the current month */
function currentMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** 0–1 fraction of how far through the current month we are */
function monthProgress(): number {
  const now = new Date();
  const day = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (day - 1) / daysInMonth;
}

function computeStatus(
  budgeted: number,
  activity: number,
  balance: number,
  spendRate: number,
  mRate: number
): BudgetStatus {
  if (budgeted === 0) return 'unbudgeted';
  if (balance < 0) return 'overspent';
  if (spendRate > mRate + 0.15) return 'warning';
  if (spendRate < mRate - 0.15) return 'ahead';
  return 'on_track';
}

const STATUS_COLOR: Record<BudgetStatus, (s: string) => string> = {
  overspent:  chalk.red,
  warning:    chalk.yellow,
  on_track:   chalk.green,
  ahead:      chalk.cyan,
  unbudgeted: chalk.gray,
};

const STATUS_ICON: Record<BudgetStatus, string> = {
  overspent:  '✗',
  warning:    '⚠',
  on_track:   '✓',
  ahead:      '↓',
  unbudgeted: '—',
};

export async function budgetHealthCommand(opts: BudgetHealthOptions): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);
  const month = opts.month ?? currentMonthISO();
  const mRate = monthProgress();

  if (!opts.json) console.log(chalk.gray(`Fetching budget health for ${month}...`));

  const budgetMonth = await client.getBudgetMonth(config.budgetId, month);

  const results: CategoryHealth[] = [];

  for (const cat of budgetMonth.categories) {
    if (cat.deleted || cat.hidden) continue;
    if (cat.budgeted === 0 && cat.activity === 0) continue;

    const spent = Math.abs(cat.activity);
    const spendRate = cat.budgeted > 0 ? spent / cat.budgeted : 0;

    const status = computeStatus(cat.budgeted, cat.activity, cat.balance, spendRate, mRate);

    // Skip "unbudgeted with no activity" noise; already filtered above
    if (status === 'unbudgeted' && cat.activity === 0) continue;

    const entry: CategoryHealth = {
      category_id: cat.id,
      category_name: cat.name,
      group_name: cat.category_group_name ?? '',
      budgeted: cat.budgeted,
      activity: cat.activity,
      balance: cat.balance,
      spend_rate: Math.round(spendRate * 1000) / 1000,
      month_rate: Math.round(mRate * 1000) / 1000,
      status,
    };
    if (cat.balance < 0) entry.over_by = Math.abs(cat.balance);

    results.push(entry);
  }

  // Filter by status if requested
  const filtered = opts.status
    ? results.filter((r) => r.status === opts.status)
    : results;

  // Sort: overspent first, then warning, then on_track, ahead, unbudgeted
  const ORDER: BudgetStatus[] = ['overspent', 'warning', 'on_track', 'ahead', 'unbudgeted'];
  filtered.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          month,
          month_progress_pct: Math.round(mRate * 100),
          age_of_money: budgetMonth.age_of_money,
          to_be_budgeted: budgetMonth.to_be_budgeted,
          to_be_budgeted_formatted: formatAmount(budgetMonth.to_be_budgeted),
          categories: filtered,
        },
        null,
        2
      )
    );
    return;
  }

  const mPct = Math.round(mRate * 100);
  console.log();
  console.log(chalk.bold.cyan(`  Budget Health — ${month}  (${mPct}% through month)`));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  const tbd = budgetMonth.to_be_budgeted;
  if (tbd > 0) {
    console.log(`  ${chalk.yellow('⚡ To Be Budgeted:')} ${chalk.yellow(formatAmount(tbd))} — assign this money!`);
  }
  if (budgetMonth.age_of_money) {
    console.log(`  ${chalk.gray('Age of Money:')} ${budgetMonth.age_of_money} days`);
  }
  console.log();

  if (filtered.length === 0) {
    console.log(chalk.green('  All categories are healthy!'));
  } else {
    for (const r of filtered) {
      const color = STATUS_COLOR[r.status];
      const icon  = STATUS_ICON[r.status];
      const spentPct = Math.round(r.spend_rate * 100);
      const label = `${r.group_name} › ${r.category_name}`.padEnd(42);
      const bar = `${spentPct}% spent`.padStart(9);
      const bal = formatAmount(r.balance).padStart(10);
      const extra = r.status === 'overspent'
        ? chalk.red(` OVER by ${formatAmount(r.over_by ?? 0)}`)
        : '';
      console.log(`  ${color(icon)}  ${label} ${bar}  ${color(bal)}${extra}`);
    }
  }

  const counts = results.reduce<Partial<Record<BudgetStatus, number>>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log();
  console.log(
    chalk.gray(
      `  ${chalk.red(counts.overspent ?? 0)} overspent  ·  ` +
      `${chalk.yellow(counts.warning ?? 0)} warning  ·  ` +
      `${chalk.green(counts.on_track ?? 0)} on track  ·  ` +
      `${chalk.cyan(counts.ahead ?? 0)} ahead`
    )
  );
  console.log();
}
