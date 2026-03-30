import { YNABClient } from '../api';
import { loadConfig } from '../config';
import { formatAmount, currentMonthISO, lastNMonths } from '../format';
import chalk from 'chalk';

interface TrendsOptions {
  months?: number;
  group?: string;
  flagOnly?: boolean; // only show categories with actionable insights
  json?: boolean;
}

type Consistency = 'always_over' | 'often_over' | 'on_target' | 'often_under' | 'always_under';
type Trend       = 'increasing' | 'stable' | 'decreasing' | 'insufficient_data';

interface CategoryTrend {
  category_id: string;
  category_name: string;
  group_name: string;
  current_budget: number;
  current_budget_formatted: string;
  avg_spending: number;
  avg_spending_formatted: string;
  suggested_budget: number;
  suggested_budget_formatted: string;
  budget_delta: number;        // suggested - current (positive = need more, negative = can reduce)
  budget_delta_formatted: string;
  trend: Trend;
  consistency: Consistency;
  over_budget_months: number;
  under_budget_months: number;
  total_months: number;
  monthly_data: { month: string; budgeted: number; activity: number; over_budget: boolean }[];
  insight: string;
}

function computeTrend(spending: number[]): Trend {
  if (spending.length < 2) return 'insufficient_data';
  // Compare first half vs second half average
  const mid = Math.floor(spending.length / 2);
  const firstHalf  = spending.slice(0, mid).reduce((s, v) => s + v, 0) / mid;
  const secondHalf = spending.slice(mid).reduce((s, v) => s + v, 0) / (spending.length - mid);
  const change = (secondHalf - firstHalf) / (firstHalf || 1);
  if (change > 0.10) return 'increasing';
  if (change < -0.10) return 'decreasing';
  return 'stable';
}

function computeConsistency(overCount: number, underCount: number, total: number): Consistency {
  const overRate = overCount / total;
  if (overRate >= 1)   return 'always_over';
  if (overRate >= 0.6) return 'often_over';
  if (underCount / total >= 1)   return 'always_under';
  if (underCount / total >= 0.6) return 'often_under';
  return 'on_target';
}

function suggestedBudget(avg: number, consistency: Consistency): number {
  // Round up to nearest $5 (500 milliunits)
  const roundUp = (n: number) => Math.ceil(n / 5000) * 5000;
  if (consistency === 'always_over' || consistency === 'often_over') {
    return roundUp(avg * 1.1); // add 10% buffer
  }
  if (consistency === 'always_under' || consistency === 'often_under') {
    return roundUp(avg * 1.05); // tighter — just a 5% buffer
  }
  return roundUp(avg * 1.05);
}

function buildInsight(cat: Omit<CategoryTrend, 'insight'>): string {
  const parts: string[] = [];

  if (cat.consistency === 'always_over') {
    parts.push(`Overspent every month — budget of ${cat.current_budget_formatted} is too low.`);
  } else if (cat.consistency === 'often_over') {
    parts.push(`Over budget ${cat.over_budget_months}/${cat.total_months} months.`);
  } else if (cat.consistency === 'always_under') {
    parts.push(`Under budget every month — you have room to reduce the target.`);
  } else if (cat.consistency === 'often_under') {
    parts.push(`Under budget ${cat.under_budget_months}/${cat.total_months} months.`);
  } else {
    parts.push(`Spending is consistent with your budget.`);
  }

  if (cat.trend === 'increasing') parts.push('Spending is trending upward.');
  if (cat.trend === 'decreasing') parts.push('Spending is trending downward — good progress.');

  const delta = cat.budget_delta;
  if (Math.abs(delta) >= 5000) {
    if (delta > 0) {
      parts.push(`Suggest raising budget by ${formatAmount(delta)} to match real spending.`);
    } else {
      parts.push(`Suggest freeing up ${formatAmount(Math.abs(delta))} — you consistently spend less.`);
    }
  }

  return parts.join(' ');
}

export async function trendsCommand(opts: TrendsOptions): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);
  const n = Math.min(opts.months ?? 3, 12);

  const monthList = [currentMonthISO(), ...lastNMonths(n)];
  // fetch all months in parallel
  if (!opts.json) console.log(chalk.gray(`Fetching ${monthList.length} months of data...`));

  const monthData = await Promise.all(
    monthList.map((m) => client.getBudgetMonth(config.budgetId, m).catch(() => null))
  );

  // Only use complete (non-null) past months for trend analysis; current month is index 0
  const currentMonthBudget = monthData[0];
  const pastMonths = monthData.slice(1).filter((m) => m !== null);

  if (pastMonths.length === 0) {
    console.error(chalk.red('Not enough historical data yet. Wait until you have at least one full past month.'));
    process.exit(1);
  }

  // Build a map of category ID → data across past months
  const catMap = new Map<string, {
    name: string;
    groupName: string;
    currentBudget: number;
    months: { month: string; budgeted: number; activity: number }[];
  }>();

  for (const m of pastMonths) {
    for (const cat of m!.categories) {
      if (cat.deleted || cat.hidden) continue;
      if (cat.budgeted === 0 && cat.activity === 0) continue;

      const existing = catMap.get(cat.id);
      if (existing) {
        existing.months.push({ month: m!.month, budgeted: cat.budgeted, activity: cat.activity });
      } else {
        catMap.set(cat.id, {
          name: cat.name,
          groupName: cat.category_group_name ?? '',
          currentBudget: 0, // will fill from current month
          months: [{ month: m!.month, budgeted: cat.budgeted, activity: cat.activity }],
        });
      }
    }
  }

  // Overlay current month budgets
  if (currentMonthBudget) {
    for (const cat of currentMonthBudget.categories) {
      const existing = catMap.get(cat.id);
      if (existing) existing.currentBudget = cat.budgeted;
    }
  }

  // Filter by group if requested
  let entries = [...catMap.entries()];
  if (opts.group) {
    const g = opts.group.toLowerCase();
    entries = entries.filter(([, v]) => v.groupName.toLowerCase().includes(g));
  }

  const results: CategoryTrend[] = [];

  for (const [id, data] of entries) {
    if (data.months.length === 0) continue;

    // Sort months oldest → newest for trend calculation
    const sorted = [...data.months].sort((a, b) => a.month.localeCompare(b.month));
    const spending = sorted.map((m) => Math.abs(m.activity));
    const avgSpending = spending.reduce((s, v) => s + v, 0) / spending.length;

    const overMonths  = sorted.filter((m) => Math.abs(m.activity) > m.budgeted && m.budgeted > 0).length;
    const underMonths = sorted.filter((m) => Math.abs(m.activity) < m.budgeted * 0.85 && m.budgeted > 0).length;

    const consistency = computeConsistency(overMonths, underMonths, sorted.length);
    const trend       = computeTrend(spending);
    const suggested   = suggestedBudget(avgSpending, consistency);
    const delta       = suggested - data.currentBudget;

    const partial: Omit<CategoryTrend, 'insight'> = {
      category_id: id,
      category_name: data.name,
      group_name: data.groupName,
      current_budget: data.currentBudget,
      current_budget_formatted: formatAmount(data.currentBudget),
      avg_spending: Math.round(avgSpending),
      avg_spending_formatted: formatAmount(Math.round(avgSpending)),
      suggested_budget: suggested,
      suggested_budget_formatted: formatAmount(suggested),
      budget_delta: delta,
      budget_delta_formatted: (delta >= 0 ? '+' : '') + formatAmount(delta),
      trend,
      consistency,
      over_budget_months: overMonths,
      under_budget_months: underMonths,
      total_months: sorted.length,
      monthly_data: sorted.map((m) => ({
        month: m.month,
        budgeted: m.budgeted,
        activity: m.activity,
        over_budget: Math.abs(m.activity) > m.budgeted && m.budgeted > 0,
      })),
    };

    results.push({ ...partial, insight: buildInsight(partial) });
  }

  // Sort: most actionable first (over > under > on_target)
  const ORDER: Consistency[] = ['always_over', 'often_over', 'on_target', 'often_under', 'always_under'];
  results.sort((a, b) => ORDER.indexOf(a.consistency) - ORDER.indexOf(b.consistency));

  const flagged = results.filter(
    (r) => r.consistency !== 'on_target' || r.trend === 'increasing'
  );
  const display = opts.flagOnly ? flagged : results;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          months_analyzed: pastMonths.length,
          period_start: pastMonths[pastMonths.length - 1]!.month,
          period_end: pastMonths[0]!.month,
          total_categories: results.length,
          flagged_categories: flagged.length,
          categories: display,
        },
        null,
        2
      )
    );
    return;
  }

  // ── human output ──────────────────────────────────────────────────────────
  console.log();
  console.log(
    chalk.bold.cyan(
      `  Spending Trends — last ${pastMonths.length} month${pastMonths.length !== 1 ? 's' : ''}`
    )
  );
  console.log(chalk.gray('  ' + '─'.repeat(64)));
  console.log();

  if (display.length === 0) {
    console.log(chalk.green('  All categories are on target. Nothing to flag.'));
    console.log();
    return;
  }

  const CONS_COLOR: Record<Consistency, (s: string) => string> = {
    always_over:  chalk.red,
    often_over:   chalk.yellow,
    on_target:    chalk.green,
    often_under:  chalk.cyan,
    always_under: chalk.blue,
  };
  const CONS_LABEL: Record<Consistency, string> = {
    always_over:  'always over',
    often_over:   'often over',
    on_target:    'on target',
    often_under:  'often under',
    always_under: 'always under',
  };
  const TREND_ICON: Record<Trend, string> = {
    increasing:        '↑',
    stable:            '→',
    decreasing:        '↓',
    insufficient_data: '?',
  };

  for (const r of display) {
    const color   = CONS_COLOR[r.consistency];
    const label   = CONS_LABEL[r.consistency];
    const tIcon   = TREND_ICON[r.trend];
    const tColor  = r.trend === 'increasing' ? chalk.red : r.trend === 'decreasing' ? chalk.green : chalk.gray;

    console.log(
      `  ${color('■')} ${chalk.bold(r.category_name)}  ${chalk.gray(r.group_name)}`
    );
    console.log(
      `    Budget: ${formatAmount(r.current_budget).padEnd(10)}  ` +
      `Avg spent: ${r.avg_spending_formatted.padEnd(10)}  ` +
      `${color(label)}  ${tColor(tIcon + ' ' + r.trend)}`
    );

    if (Math.abs(r.budget_delta) >= 5000) {
      const deltaLabel = r.budget_delta > 0 ? chalk.yellow('raise to') : chalk.cyan('reduce to');
      console.log(`    Suggested: ${deltaLabel} ${r.suggested_budget_formatted} (${r.budget_delta_formatted}/mo)`);
    }

    // Sparkline of monthly spending
    const maxSpend = Math.max(...r.monthly_data.map((m) => Math.abs(m.activity)));
    const spark = r.monthly_data
      .map((m) => {
        const ratio = maxSpend > 0 ? Math.abs(m.activity) / maxSpend : 0;
        const bars = ['▁','▂','▃','▄','▅','▆','▇','█'];
        const bar = bars[Math.min(Math.floor(ratio * 8), 7)];
        return m.over_budget ? chalk.red(bar) : chalk.green(bar);
      })
      .join('');
    console.log(`    ${spark}  ${chalk.gray('(oldest → newest)')}`);
    console.log(`    ${chalk.gray(r.insight)}`);
    console.log();
  }

  const overCount  = flagged.filter((r) => r.consistency === 'always_over' || r.consistency === 'often_over').length;
  const underCount = flagged.filter((r) => r.consistency === 'always_under' || r.consistency === 'often_under').length;
  console.log(
    chalk.gray(
      `  ${chalk.red(overCount)} over budget  ·  ` +
      `${chalk.cyan(underCount)} under budget  ·  ` +
      `${chalk.green(results.length - flagged.length)} on target`
    )
  );
  console.log();
}
