import { YNABClient } from '../api';
import { loadConfig } from '../config';
import { formatAmount } from '../format';
import chalk from 'chalk';

interface MonthlySummaryOptions {
  month?: string;
  json?: boolean;
}

function currentMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function monthProgress(): { day: number; daysInMonth: number; pct: number } {
  const now = new Date();
  const day = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return { day, daysInMonth, pct: Math.round(((day - 1) / daysInMonth) * 100) };
}

export async function monthlySummaryCommand(opts: MonthlySummaryOptions): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);
  const month = opts.month ?? currentMonthISO();

  if (!opts.json) console.log(chalk.gray(`Fetching monthly summary for ${month}...`));

  const budgetMonth = await client.getBudgetMonth(config.budgetId, month);

  // Roll up category spending by group
  const groupMap = new Map<string, { name: string; activity: number; budgeted: number }>();
  for (const cat of budgetMonth.categories) {
    if (cat.deleted || cat.hidden) continue;
    const groupName = cat.category_group_name ?? 'Other';
    const existing = groupMap.get(groupName);
    if (existing) {
      existing.activity += cat.activity;
      existing.budgeted += cat.budgeted;
    } else {
      groupMap.set(groupName, { name: groupName, activity: cat.activity, budgeted: cat.budgeted });
    }
  }

  const topGroups = [...groupMap.values()]
    .filter((g) => g.activity < 0)
    .sort((a, b) => a.activity - b.activity)
    .slice(0, 5);

  const savingsRate =
    budgetMonth.income > 0
      ? Math.round(((budgetMonth.income + budgetMonth.activity) / budgetMonth.income) * 100)
      : null;

  const result = {
    month,
    income: budgetMonth.income,
    income_formatted: formatAmount(budgetMonth.income),
    spending: budgetMonth.activity,
    spending_formatted: formatAmount(budgetMonth.activity),
    budgeted: budgetMonth.budgeted,
    budgeted_formatted: formatAmount(budgetMonth.budgeted),
    to_be_budgeted: budgetMonth.to_be_budgeted,
    to_be_budgeted_formatted: formatAmount(budgetMonth.to_be_budgeted),
    net: budgetMonth.income + budgetMonth.activity,
    net_formatted: formatAmount(budgetMonth.income + budgetMonth.activity),
    savings_rate_pct: savingsRate,
    age_of_money: budgetMonth.age_of_money,
    top_spending_groups: topGroups.map((g) => ({
      group: g.name,
      activity: g.activity,
      activity_formatted: formatAmount(g.activity),
      budgeted: g.budgeted,
      budgeted_formatted: formatAmount(g.budgeted),
      pct_used: g.budgeted > 0 ? Math.round((Math.abs(g.activity) / g.budgeted) * 100) : null,
    })),
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { day, daysInMonth, pct: mPct } = monthProgress();

  console.log();
  console.log(chalk.bold.cyan(`  Monthly Summary — ${month}  (day ${day}/${daysInMonth}, ${mPct}% through)`));
  console.log(chalk.gray('  ' + '─'.repeat(52)));

  console.log(`  ${chalk.green('Income:    ')} ${chalk.green(formatAmount(budgetMonth.income))}`);
  console.log(`  ${chalk.red('Spending:  ')} ${chalk.red(formatAmount(budgetMonth.activity))}`);

  const netColor = result.net >= 0 ? chalk.green : chalk.red;
  console.log(`  ${chalk.bold('Net:       ')} ${netColor(formatAmount(result.net))}`);

  if (savingsRate !== null) {
    const rateColor = savingsRate >= 20 ? chalk.green : savingsRate >= 0 ? chalk.yellow : chalk.red;
    console.log(`  Savings rate: ${rateColor(`${savingsRate}%`)}`);
  }

  if (budgetMonth.to_be_budgeted > 0) {
    console.log(`  ${chalk.yellow('⚡ Unallocated:')} ${formatAmount(budgetMonth.to_be_budgeted)}`);
  }

  if (budgetMonth.age_of_money) {
    console.log(`  Age of money: ${budgetMonth.age_of_money} days`);
  }

  if (topGroups.length > 0) {
    console.log();
    console.log(chalk.bold('  Top Spending Groups:'));
    for (const g of topGroups) {
      const pctUsed = g.budgeted > 0 ? Math.round((Math.abs(g.activity) / g.budgeted) * 100) : null;
      const pctStr = pctUsed !== null ? chalk.gray(` (${pctUsed}% of budget)`) : '';
      console.log(
        `    ${chalk.red(formatAmount(g.activity).padStart(10))}  ${g.name}${pctStr}`
      );
    }
  }

  console.log();
}
