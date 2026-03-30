import { YNABClient } from '../api';
import { loadConfig } from '../config';
import { formatAmount } from '../format';
import type { GoalProgress } from '../types';
import chalk from 'chalk';

interface GoalsOptions {
  month?: string;
  json?: boolean;
}

function currentMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

const GOAL_TYPE_LABEL: Record<string, string> = {
  TB:   'Target Balance',
  TBD:  'Target Balance by Date',
  MF:   'Monthly Funding',
  NEED: 'Plan Your Spending',
  DEBT: 'Debt Payoff',
};

export async function goalsCommand(opts: GoalsOptions): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);
  const month = opts.month ?? currentMonthISO();

  if (!opts.json) console.log(chalk.gray('Fetching goal progress...'));

  const budgetMonth = await client.getBudgetMonth(config.budgetId, month);

  const goals: GoalProgress[] = [];

  for (const cat of budgetMonth.categories) {
    if (cat.deleted || !cat.goal_type) continue;

    const pct = (cat as unknown as Record<string, unknown>)['goal_percentage_complete'] as number ?? 0;
    const targetDate = (cat as unknown as Record<string, unknown>)['goal_target_date'] as string | null ?? null;

    // Determine if on track: for dated goals check months remaining vs pct
    let onTrack = pct >= 100;
    if (!onTrack && targetDate) {
      const monthsLeft = Math.max(
        0,
        (new Date(targetDate).getFullYear() - new Date().getFullYear()) * 12 +
          new Date(targetDate).getMonth() - new Date().getMonth()
      );
      const totalMonths = Math.max(
        1,
        (new Date(targetDate).getFullYear() - new Date(month).getFullYear()) * 12 +
          new Date(targetDate).getMonth() - new Date(month).getMonth()
      );
      const expectedPct = Math.round(((totalMonths - monthsLeft) / totalMonths) * 100);
      onTrack = pct >= expectedPct - 5;
    } else if (!onTrack) {
      onTrack = pct >= 95; // within 5% = on track for undated goals
    }

    goals.push({
      category_id: cat.id,
      category_name: cat.name,
      group_name: cat.category_group_name ?? '',
      goal_type: cat.goal_type as GoalProgress['goal_type'],
      goal_target: cat.goal_target ?? 0,
      goal_percentage_complete: pct,
      goal_target_date: targetDate,
      balance: cat.balance,
      on_track: onTrack,
    });
  }

  goals.sort((a, b) => a.goal_percentage_complete - b.goal_percentage_complete);

  if (opts.json) {
    console.log(JSON.stringify({ month, goals }, null, 2));
    return;
  }

  console.log();
  console.log(chalk.bold.cyan(`  Goal Progress — ${month}`));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  if (goals.length === 0) {
    console.log(chalk.gray('  No goals found. Set goals in YNAB to track them here.'));
    console.log();
    return;
  }

  for (const g of goals) {
    const pct = Math.min(g.goal_percentage_complete, 100);
    const barWidth = 20;
    const filled = Math.round((pct / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const color = pct >= 100 ? chalk.green : g.on_track ? chalk.cyan : chalk.yellow;
    const trackLabel = pct >= 100 ? chalk.green('✓ done') : g.on_track ? chalk.cyan('on track') : chalk.yellow('behind');
    const dateStr = g.goal_target_date ? chalk.gray(` → ${g.goal_target_date}`) : '';
    const typeStr = chalk.gray(GOAL_TYPE_LABEL[g.goal_type] ?? g.goal_type);

    console.log(`  ${color(bar)} ${String(pct).padStart(3)}%  ${g.category_name}  ${trackLabel}`);
    console.log(
      `         ${typeStr}  target: ${formatAmount(g.goal_target)}  balance: ${formatAmount(g.balance)}${dateStr}`
    );
    console.log();
  }

  const done    = goals.filter((g) => g.goal_percentage_complete >= 100).length;
  const onTrack = goals.filter((g) => g.on_track && g.goal_percentage_complete < 100).length;
  const behind  = goals.filter((g) => !g.on_track && g.goal_percentage_complete < 100).length;
  console.log(chalk.gray(`  ${done} complete  ·  ${onTrack} on track  ·  ${behind} behind`));
  console.log();
}
