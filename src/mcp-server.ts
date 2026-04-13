#!/usr/bin/env node
/**
 * YNAB MCP Server
 * Exposes YNAB operations as MCP tools for Claude Code.
 *
 * Transport: stdio (no stdout logging — all output goes through MCP protocol).
 * Register in ~/.claude/claude.json or project .mcp.json.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { YNABClient } from './api';
import { loadConfig, loadCategoryCache } from './config';
import { formatAmount, daysAgoISO, todayISO, currentMonthISO, lastNMonths } from './format';
import type { Transaction, FlatCategory } from './types';

// ── helpers ──────────────────────────────────────────────────────────────────

function getClient(): { client: YNABClient; budgetId: string; budgetName: string } {
  const config = loadConfig();
  return {
    client: new YNABClient(config.token),
    budgetId: config.budgetId,
    budgetName: config.budgetName,
  };
}

function isUncategorized(t: Transaction): boolean {
  return !t.deleted && !t.transfer_account_id && !t.category_id;
}

function resolveCategory(input: string, flat: FlatCategory[]): FlatCategory {
  const byId = flat.find((c) => c.id === input && !c.deleted);
  if (byId) return byId;

  const byExactName = flat.filter(
    (c) => !c.deleted && c.name.toLowerCase() === input.toLowerCase()
  );
  if (byExactName.length === 1) return byExactName[0];
  if (byExactName.length > 1) {
    throw new Error(
      `Multiple categories match "${input}": ${byExactName.map((c) => `${c.id} (${c.groupName} > ${c.name})`).join(', ')}. Use the category ID.`
    );
  }

  const fuzzy = flat.filter(
    (c) => !c.deleted && c.name.toLowerCase().includes(input.toLowerCase())
  );
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(
      `Multiple categories partially match "${input}": ${fuzzy.map((c) => `${c.id} (${c.groupName} > ${c.name})`).join(', ')}. Use the category ID or a more specific name.`
    );
  }

  throw new Error(
    `No category found matching "${input}". Use ynab_list_categories to browse available categories.`
  );
}

// ── tool handlers ─────────────────────────────────────────────────────────────

async function handleGetSummary(args: { date?: string }) {
  const { client, budgetId, budgetName } = getClient();
  const date = args.date ?? todayISO();

  const transactions = await client.getTransactions(budgetId, date);
  const dayTxns = transactions.filter((t) => t.date === date && !t.deleted);

  let totalInflow = 0;
  let totalOutflow = 0;
  let uncategorizedCount = 0;
  const categoryMap = new Map<string, { name: string; total: number; count: number }>();
  const accountMap = new Map<string, { name: string; total: number; count: number }>();

  for (const t of dayTxns) {
    if (t.amount > 0) totalInflow += t.amount;
    else totalOutflow += t.amount;
    if (!t.category_id && !t.transfer_account_id) uncategorizedCount++;

    const catKey = t.category_id ?? '__none__';
    const existing = categoryMap.get(catKey);
    if (existing) { existing.total += t.amount; existing.count++; }
    else categoryMap.set(catKey, { name: t.category_name ?? '(Uncategorized)', total: t.amount, count: 1 });

    const accExisting = accountMap.get(t.account_id);
    if (accExisting) { accExisting.total += t.amount; accExisting.count++; }
    else accountMap.set(t.account_id, { name: t.account_name, total: t.amount, count: 1 });
  }

  const topOutflows = [...dayTxns]
    .filter((t) => t.amount < 0)
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      date: t.date,
      amount: t.amount,
      amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name,
      account_name: t.account_name,
      category_name: t.category_name,
      memo: t.memo,
    }));

  return {
    budget_name: budgetName,
    date,
    total_inflow: totalInflow,
    total_inflow_formatted: formatAmount(totalInflow),
    total_outflow: totalOutflow,
    total_outflow_formatted: formatAmount(totalOutflow),
    net: totalInflow + totalOutflow,
    net_formatted: formatAmount(totalInflow + totalOutflow),
    transaction_count: dayTxns.length,
    uncategorized_count: uncategorizedCount,
    top_outflows: topOutflows,
    by_category: [...categoryMap.entries()].map(([id, v]) => ({
      category_id: id === '__none__' ? null : id,
      category_name: v.name,
      total: v.total,
      total_formatted: formatAmount(v.total),
      count: v.count,
    })).sort((a, b) => a.total - b.total),
    by_account: [...accountMap.entries()].map(([id, v]) => ({
      account_id: id,
      account_name: v.name,
      total: v.total,
      total_formatted: formatAmount(v.total),
      count: v.count,
    })),
  };
}

async function handleListUncategorized(args: { days?: number; since_date?: string }) {
  const { client, budgetId } = getClient();
  const sinceDate = args.since_date ?? daysAgoISO(args.days ?? 30);

  const transactions = await client.getTransactions(budgetId, sinceDate, 'uncategorized');
  const uncategorized = transactions
    .filter(isUncategorized)
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    since_date: sinceDate,
    count: uncategorized.length,
    transactions: uncategorized.map((t) => ({
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
  };
}

async function handleCategorize(args: { transaction_id: string; category: string }) {
  const { client, budgetId } = getClient();
  const cache = loadCategoryCache();

  if (!cache) {
    throw new Error('No category cache. Run `ynab sync` in the terminal first.');
  }

  const category = resolveCategory(args.category, cache.flat);

  const updated = await client.updateTransaction(budgetId, args.transaction_id, {
    category_id: category.id,
  });

  return {
    ok: true,
    transaction: {
      id: updated.id,
      date: updated.date,
      amount: updated.amount,
      amount_formatted: formatAmount(updated.amount),
      payee_name: updated.payee_name,
      category_id: updated.category_id,
      category_name: updated.category_name,
      account_name: updated.account_name,
    },
  };
}

function handleListCategories(args: { search?: string; group?: string; include_hidden?: boolean }) {
  const cache = loadCategoryCache();
  if (!cache) {
    throw new Error('No category cache. Run `ynab sync` in the terminal first.');
  }

  let results = cache.flat.filter((c) => !c.deleted);
  if (!args.include_hidden) results = results.filter((c) => !c.hidden);
  if (args.search) {
    const q = args.search.toLowerCase();
    results = results.filter(
      (c) => c.name.toLowerCase().includes(q) || c.groupName.toLowerCase().includes(q)
    );
  }
  if (args.group) {
    const g = args.group.toLowerCase();
    results = results.filter((c) => c.groupName.toLowerCase().includes(g));
  }

  return {
    last_synced: cache.lastSynced,
    count: results.length,
    categories: results.map((c) => ({
      id: c.id,
      name: c.name,
      group_name: c.groupName,
      group_id: c.groupId,
      hidden: c.hidden,
    })),
  };
}

// ── month helpers ─────────────────────────────────────────────────────────────

function monthProgress(): number {
  const now = new Date();
  return (now.getDate() - 1) / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

type BudgetStatus = 'overspent' | 'warning' | 'on_track' | 'ahead' | 'unbudgeted';

function computeStatus(budgeted: number, balance: number, spendRate: number, mRate: number): BudgetStatus {
  if (budgeted === 0) return 'unbudgeted';
  if (balance < 0) return 'overspent';
  if (spendRate > mRate + 0.15) return 'warning';
  if (spendRate < mRate - 0.15) return 'ahead';
  return 'on_track';
}

// ── new tool handlers ─────────────────────────────────────────────────────────

async function handleBudgetHealth(args: { month?: string; status_filter?: string }) {
  const { client, budgetId } = getClient();
  const month = args.month ?? currentMonthISO();
  const mRate = monthProgress();

  const budgetMonth = await client.getBudgetMonth(budgetId, month);

  const categories = [];
  for (const cat of budgetMonth.categories) {
    if (cat.deleted || cat.hidden) continue;
    if (cat.budgeted === 0 && cat.activity === 0) continue;

    const spent = Math.abs(cat.activity);
    const spendRate = cat.budgeted > 0 ? spent / cat.budgeted : 0;
    const status = computeStatus(cat.budgeted, cat.balance, spendRate, mRate);
    if (status === 'unbudgeted' && cat.activity === 0) continue;

    if (args.status_filter && status !== args.status_filter) continue;

    categories.push({
      category_id: cat.id,
      category_name: cat.name,
      group_name: cat.category_group_name ?? '',
      budgeted: cat.budgeted,
      budgeted_formatted: formatAmount(cat.budgeted),
      activity: cat.activity,
      activity_formatted: formatAmount(cat.activity),
      balance: cat.balance,
      balance_formatted: formatAmount(cat.balance),
      spend_rate_pct: Math.round(spendRate * 100),
      month_rate_pct: Math.round(mRate * 100),
      status,
      over_by: cat.balance < 0 ? Math.abs(cat.balance) : undefined,
      over_by_formatted: cat.balance < 0 ? formatAmount(Math.abs(cat.balance)) : undefined,
    });
  }

  const ORDER: BudgetStatus[] = ['overspent', 'warning', 'on_track', 'ahead', 'unbudgeted'];
  categories.sort((a, b) => ORDER.indexOf(a.status as BudgetStatus) - ORDER.indexOf(b.status as BudgetStatus));

  const counts = categories.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    month,
    month_progress_pct: Math.round(mRate * 100),
    age_of_money: budgetMonth.age_of_money,
    to_be_budgeted: budgetMonth.to_be_budgeted,
    to_be_budgeted_formatted: formatAmount(budgetMonth.to_be_budgeted),
    summary: counts,
    categories,
  };
}

async function handleMonthlySummary(args: { month?: string }) {
  const { client, budgetId, budgetName } = getClient();
  const month = args.month ?? currentMonthISO();
  const budgetMonth = await client.getBudgetMonth(budgetId, month);
  const mRate = monthProgress();

  const groupMap = new Map<string, { activity: number; budgeted: number }>();
  for (const cat of budgetMonth.categories) {
    if (cat.deleted || cat.hidden) continue;
    const g = cat.category_group_name ?? 'Other';
    const ex = groupMap.get(g);
    if (ex) { ex.activity += cat.activity; ex.budgeted += cat.budgeted; }
    else groupMap.set(g, { activity: cat.activity, budgeted: cat.budgeted });
  }

  const topGroups = [...groupMap.entries()]
    .filter(([, v]) => v.activity < 0)
    .sort(([, a], [, b]) => a.activity - b.activity)
    .slice(0, 5)
    .map(([name, v]) => ({
      group: name,
      activity: v.activity,
      activity_formatted: formatAmount(v.activity),
      budgeted: v.budgeted,
      budgeted_formatted: formatAmount(v.budgeted),
      pct_used: v.budgeted > 0 ? Math.round((Math.abs(v.activity) / v.budgeted) * 100) : null,
    }));

  const savingsRate = budgetMonth.income > 0
    ? Math.round(((budgetMonth.income + budgetMonth.activity) / budgetMonth.income) * 100)
    : null;

  return {
    budget_name: budgetName,
    month,
    month_progress_pct: Math.round(mRate * 100),
    income: budgetMonth.income,
    income_formatted: formatAmount(budgetMonth.income),
    spending: budgetMonth.activity,
    spending_formatted: formatAmount(budgetMonth.activity),
    net: budgetMonth.income + budgetMonth.activity,
    net_formatted: formatAmount(budgetMonth.income + budgetMonth.activity),
    to_be_budgeted: budgetMonth.to_be_budgeted,
    to_be_budgeted_formatted: formatAmount(budgetMonth.to_be_budgeted),
    savings_rate_pct: savingsRate,
    age_of_money: budgetMonth.age_of_money,
    top_spending_groups: topGroups,
  };
}

async function handleGoalProgress(args: { month?: string }) {
  const { client, budgetId } = getClient();
  const month = args.month ?? currentMonthISO();
  const budgetMonth = await client.getBudgetMonth(budgetId, month);

  const goals = [];
  for (const cat of budgetMonth.categories) {
    if (cat.deleted || !cat.goal_type) continue;
    const raw = cat as unknown as Record<string, unknown>;
    const pct = (raw['goal_percentage_complete'] as number) ?? 0;
    const targetDate = (raw['goal_target_date'] as string | null) ?? null;

    let onTrack = pct >= 100;
    if (!onTrack && targetDate) {
      const now = new Date();
      const target = new Date(targetDate);
      const monthsLeft = Math.max(0, (target.getFullYear() - now.getFullYear()) * 12 + target.getMonth() - now.getMonth());
      const start = new Date(month);
      const totalMonths = Math.max(1, (target.getFullYear() - start.getFullYear()) * 12 + target.getMonth() - start.getMonth());
      const expectedPct = Math.round(((totalMonths - monthsLeft) / totalMonths) * 100);
      onTrack = pct >= expectedPct - 5;
    } else if (!onTrack) {
      onTrack = pct >= 95;
    }

    goals.push({
      category_id: cat.id,
      category_name: cat.name,
      group_name: cat.category_group_name ?? '',
      goal_type: cat.goal_type,
      goal_target: cat.goal_target,
      goal_target_formatted: cat.goal_target ? formatAmount(cat.goal_target) : null,
      goal_percentage_complete: pct,
      goal_target_date: targetDate,
      balance: cat.balance,
      balance_formatted: formatAmount(cat.balance),
      on_track: onTrack,
    });
  }

  goals.sort((a, b) => a.goal_percentage_complete - b.goal_percentage_complete);

  return {
    month,
    total_goals: goals.length,
    complete: goals.filter((g) => g.goal_percentage_complete >= 100).length,
    on_track: goals.filter((g) => g.on_track && g.goal_percentage_complete < 100).length,
    behind: goals.filter((g) => !g.on_track && g.goal_percentage_complete < 100).length,
    goals,
  };
}

async function handleGetAccounts() {
  const { client, budgetId } = getClient();
  const all = await client.getAccounts(budgetId);
  const accounts = all.filter((a) => !a.deleted && !a.closed);

  const isLiability = (type: string) =>
    ['creditCard','lineOfCredit','mortgage','autoLoan','studentLoan',
     'personalLoan','medicalDebt','otherDebt','otherLiability'].includes(type);

  const totalAssets      = accounts.filter((a) => !isLiability(a.type)).reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = accounts.filter((a) =>  isLiability(a.type)).reduce((s, a) => s + a.balance, 0);

  return {
    net_worth: totalAssets + totalLiabilities,
    net_worth_formatted: formatAmount(totalAssets + totalLiabilities),
    total_assets: totalAssets,
    total_assets_formatted: formatAmount(totalAssets),
    total_liabilities: totalLiabilities,
    total_liabilities_formatted: formatAmount(totalLiabilities),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      on_budget: a.on_budget,
      balance: a.balance,
      balance_formatted: formatAmount(a.balance),
      cleared_balance: a.cleared_balance,
      uncleared_balance: a.uncleared_balance,
      is_liability: isLiability(a.type),
    })),
  };
}

async function handleListUnapproved(args: { days?: number; since_date?: string }) {
  const { client, budgetId } = getClient();
  const sinceDate = args.since_date ?? daysAgoISO(args.days ?? 30);

  const transactions = await client.getTransactions(budgetId, sinceDate, 'unapproved');
  const unapproved = transactions
    .filter((t) => !t.deleted && !t.approved)
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    since_date: sinceDate,
    count: unapproved.length,
    uncategorized_count: unapproved.filter((t) => !t.category_id && !t.transfer_account_id).length,
    transactions: unapproved.map((t) => ({
      id: t.id,
      date: t.date,
      amount: t.amount,
      amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name,
      account_name: t.account_name,
      category_id: t.category_id,
      category_name: t.category_name,
      memo: t.memo,
      cleared: t.cleared,
    })),
  };
}

async function handleApprove(args: { transaction_id: string }) {
  const { client, budgetId } = getClient();
  const updated = await client.updateTransaction(budgetId, args.transaction_id, { approved: true });
  return {
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
  };
}

async function handleApproveAll(args: { days?: number; since_date?: string }) {
  const { client, budgetId } = getClient();
  const sinceDate = args.since_date ?? daysAgoISO(args.days ?? 30);

  const transactions = await client.getTransactions(budgetId, sinceDate, 'unapproved');
  const unapproved = transactions.filter((t) => !t.deleted && !t.approved);

  if (unapproved.length === 0) return { ok: true, approved_count: 0, failed_count: 0 };

  const results = await Promise.allSettled(
    unapproved.map((t) => client.updateTransaction(budgetId, t.id, { approved: true }))
  );

  return {
    ok: results.every((r) => r.status === 'fulfilled'),
    approved_count: results.filter((r) => r.status === 'fulfilled').length,
    failed_count: results.filter((r) => r.status === 'rejected').length,
  };
}

async function handleCategorizAndApprove(args: { transaction_id: string; category: string }) {
  const { client, budgetId } = getClient();
  const cache = loadCategoryCache();
  if (!cache) throw new Error('No category cache. Run `ynab sync` in the terminal first.');

  const { resolveCategory: resolve } = await import('./commands/categorize').then(() => ({
    resolveCategory: (input: string) => {
      const flat = cache.flat;
      const byId = flat.find((c) => c.id === input && !c.deleted);
      if (byId) return byId;
      const byName = flat.filter((c) => !c.deleted && c.name.toLowerCase() === input.toLowerCase());
      if (byName.length === 1) return byName[0];
      if (byName.length > 1) throw new Error(`Multiple categories match "${input}". Use the category ID.`);
      const fuzzy = flat.filter((c) => !c.deleted && c.name.toLowerCase().includes(input.toLowerCase()));
      if (fuzzy.length === 1) return fuzzy[0];
      if (fuzzy.length > 1) throw new Error(`Multiple categories partially match "${input}". Use the category ID.`);
      throw new Error(`No category found matching "${input}".`);
    },
  }));

  const category = resolve(args.category);
  const updated = await client.updateTransaction(budgetId, args.transaction_id, {
    category_id: category.id,
    approved: true,
  });

  return {
    ok: true,
    transaction: {
      id: updated.id,
      date: updated.date,
      amount: updated.amount,
      amount_formatted: formatAmount(updated.amount),
      payee_name: updated.payee_name,
      category_id: updated.category_id,
      category_name: updated.category_name,
      approved: updated.approved,
    },
  };
}

async function handleSpendingTrends(args: { months?: number; group?: string; flag_only?: boolean }) {
  const { client, budgetId } = getClient();
  const n = Math.min(args.months ?? 3, 12);

  const monthList = [currentMonthISO(), ...lastNMonths(n)];
  const monthData = await Promise.all(
    monthList.map((m) => client.getBudgetMonth(budgetId, m).catch(() => null))
  );

  const currentMonthBudget = monthData[0];
  const pastMonths = monthData.slice(1).filter(Boolean);

  if (pastMonths.length === 0) throw new Error('Not enough historical data yet.');

  type CatEntry = { name: string; groupName: string; currentBudget: number; months: { month: string; budgeted: number; activity: number }[] };
  const catMap = new Map<string, CatEntry>();

  for (const m of pastMonths) {
    for (const cat of m!.categories) {
      if (cat.deleted || cat.hidden) continue;
      if (cat.budgeted === 0 && cat.activity === 0) continue;
      const existing = catMap.get(cat.id);
      if (existing) {
        existing.months.push({ month: m!.month, budgeted: cat.budgeted, activity: cat.activity });
      } else {
        catMap.set(cat.id, { name: cat.name, groupName: cat.category_group_name ?? '', currentBudget: 0, months: [{ month: m!.month, budgeted: cat.budgeted, activity: cat.activity }] });
      }
    }
  }
  if (currentMonthBudget) {
    for (const cat of currentMonthBudget.categories) {
      const e = catMap.get(cat.id);
      if (e) e.currentBudget = cat.budgeted;
    }
  }

  let entries = [...catMap.entries()];
  if (args.group) {
    const g = args.group.toLowerCase();
    entries = entries.filter(([, v]) => v.groupName.toLowerCase().includes(g));
  }

  type Consistency = 'always_over' | 'often_over' | 'on_target' | 'often_under' | 'always_under';
  type TrendDir    = 'increasing' | 'stable' | 'decreasing' | 'insufficient_data';

  const computeTrend = (spending: number[]): TrendDir => {
    if (spending.length < 2) return 'insufficient_data';
    const mid = Math.floor(spending.length / 2);
    const first  = spending.slice(0, mid).reduce((s, v) => s + v, 0) / mid;
    const second = spending.slice(mid).reduce((s, v) => s + v, 0) / (spending.length - mid);
    const change = (second - first) / (first || 1);
    if (change > 0.10) return 'increasing';
    if (change < -0.10) return 'decreasing';
    return 'stable';
  };

  const computeConsistency = (over: number, under: number, total: number): Consistency => {
    if (over / total >= 1)   return 'always_over';
    if (over / total >= 0.6) return 'often_over';
    if (under / total >= 1)   return 'always_under';
    if (under / total >= 0.6) return 'often_under';
    return 'on_target';
  };

  const roundUp = (n: number) => Math.ceil(n / 5000) * 5000;
  const suggestBudget = (avg: number, c: Consistency) =>
    c === 'always_over' || c === 'often_over' ? roundUp(avg * 1.1) : roundUp(avg * 1.05);

  const results = [];
  for (const [id, data] of entries) {
    if (!data.months.length) continue;
    const sorted  = [...data.months].sort((a, b) => a.month.localeCompare(b.month));
    const spending = sorted.map((m) => Math.abs(m.activity));
    const avg     = spending.reduce((s, v) => s + v, 0) / spending.length;
    const over    = sorted.filter((m) => Math.abs(m.activity) > m.budgeted && m.budgeted > 0).length;
    const under   = sorted.filter((m) => Math.abs(m.activity) < m.budgeted * 0.85 && m.budgeted > 0).length;
    const consistency = computeConsistency(over, under, sorted.length);
    const trend       = computeTrend(spending);
    const suggested   = suggestBudget(avg, consistency);
    const delta       = suggested - data.currentBudget;

    results.push({
      category_id: id,
      category_name: data.name,
      group_name: data.groupName,
      current_budget: data.currentBudget,
      current_budget_formatted: formatAmount(data.currentBudget),
      avg_spending: Math.round(avg),
      avg_spending_formatted: formatAmount(Math.round(avg)),
      suggested_budget: suggested,
      suggested_budget_formatted: formatAmount(suggested),
      budget_delta: delta,
      budget_delta_formatted: (delta >= 0 ? '+' : '') + formatAmount(delta),
      trend,
      consistency,
      over_budget_months: over,
      under_budget_months: under,
      total_months: sorted.length,
      monthly_data: sorted,
    });
  }

  const ORDER: Consistency[] = ['always_over','often_over','on_target','often_under','always_under'];
  results.sort((a, b) => ORDER.indexOf(a.consistency as Consistency) - ORDER.indexOf(b.consistency as Consistency));

  const flagged = results.filter((r) => r.consistency !== 'on_target' || r.trend === 'increasing');
  const display = args.flag_only ? flagged : results;

  return {
    months_analyzed: pastMonths.length,
    period_start: pastMonths[pastMonths.length - 1]!.month,
    period_end: pastMonths[0]!.month,
    total_categories: results.length,
    flagged_count: flagged.length,
    over_budget_categories: flagged.filter((r) => r.consistency === 'always_over' || r.consistency === 'often_over').length,
    under_budget_categories: flagged.filter((r) => r.consistency === 'always_under' || r.consistency === 'often_under').length,
    categories: display,
  };
}

async function handleListApproved(args: {
  days?: number;
  since_date?: string;
  account_id?: string;
  category_id?: string;
}) {
  const { client, budgetId } = getClient();
  const sinceDate = args.since_date ?? daysAgoISO(args.days ?? 30);

  // The YNAB API has no "approved" type filter — fetch all transactions and filter client-side.
  const transactions = await client.getTransactions(budgetId, sinceDate);
  let approved = transactions.filter((t) => !t.deleted && t.approved);

  if (args.account_id) {
    approved = approved.filter((t) => t.account_id === args.account_id);
  }
  if (args.category_id) {
    approved = approved.filter((t) => t.category_id === args.category_id);
  }

  approved.sort((a, b) => b.date.localeCompare(a.date));

  return {
    since_date: sinceDate,
    count: approved.length,
    transactions: approved.map((t) => ({
      id: t.id,
      date: t.date,
      amount: t.amount,
      amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name,
      account_id: t.account_id,
      account_name: t.account_name,
      category_id: t.category_id,
      category_name: t.category_name,
      memo: t.memo,
      cleared: t.cleared,
      approved: t.approved,
    })),
  };
}

async function handleSyncCategories() {
  const { client, budgetId } = getClient();
  const { saveCategoryCache } = await import('./config');
  const groups = await client.getCategories(budgetId);

  const flat = groups.flatMap((group) =>
    group.categories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      groupName: group.name,
      groupId: group.id,
      hidden: cat.hidden,
      deleted: cat.deleted,
    }))
  );

  saveCategoryCache({ lastSynced: new Date().toISOString(), groups, flat });
  return { ok: true, category_count: flat.length, group_count: groups.length, last_synced: new Date().toISOString() };
}

// ── server setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'ynab', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ynab_get_summary',
      description: 'Get a spending summary for a given day. Shows inflows, outflows, top expenses, breakdown by category and account.',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
        },
      },
    },
    {
      name: 'ynab_list_uncategorized',
      description: 'List transactions that have no category assigned. Returns transaction IDs needed for ynab_categorize.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Look back N days (default: 30)' },
          since_date: { type: 'string', description: 'Look back since YYYY-MM-DD (overrides days)' },
        },
      },
    },
    {
      name: 'ynab_categorize',
      description: 'Assign a category to a transaction. Use ynab_list_categories to find category IDs or names.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', description: 'Transaction ID from ynab_list_uncategorized' },
          category: { type: 'string', description: 'Category UUID or name (fuzzy matched). Use UUID to avoid ambiguity.' },
        },
        required: ['transaction_id', 'category'],
      },
    },
    {
      name: 'ynab_list_categories',
      description: 'List available YNAB categories from local cache. Use search/group to filter. Run ynab_sync_categories to refresh.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Filter by name or group name (partial match)' },
          group: { type: 'string', description: 'Filter by group name (partial match)' },
          include_hidden: { type: 'boolean', description: 'Include hidden categories (default: false)' },
        },
      },
    },
    {
      name: 'ynab_sync_categories',
      description: 'Refresh the local category cache from YNAB. Run this if categories seem outdated.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ynab_list_unapproved',
      description: 'List transactions that have not been approved yet. Use for evening wrap-up to review and approve pending transactions.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Look back N days (default: 30)' },
          since_date: { type: 'string', description: 'Look back since YYYY-MM-DD (overrides days)' },
        },
      },
    },
    {
      name: 'ynab_list_approved',
      description: 'List approved transactions in a date range. Useful for reviewing what has already been confirmed, auditing spending history, or searching past activity. The YNAB API has no native "approved" filter — this fetches all transactions and filters client-side.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Look back N days (default: 30)' },
          since_date: { type: 'string', description: 'Look back since YYYY-MM-DD (overrides days)' },
          account_id: { type: 'string', description: 'Optional: filter by account UUID' },
          category_id: { type: 'string', description: 'Optional: filter by category UUID' },
        },
      },
    },
    {
      name: 'ynab_approve',
      description: 'Approve a single transaction by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', description: 'Transaction ID to approve' },
        },
        required: ['transaction_id'],
      },
    },
    {
      name: 'ynab_approve_all',
      description: 'Approve all unapproved transactions in a date range. Good for end-of-day wrap-up once you have reviewed them.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Look back N days (default: 30)' },
          since_date: { type: 'string', description: 'Look back since YYYY-MM-DD (overrides days)' },
        },
      },
    },
    {
      name: 'ynab_categorize_and_approve',
      description: 'Categorize a transaction AND approve it in a single API call. The most efficient tool for the evening wrap-up — handles both steps at once.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', description: 'Transaction ID' },
          category: { type: 'string', description: 'Category UUID or name (fuzzy matched)' },
        },
        required: ['transaction_id', 'category'],
      },
    },
    {
      name: 'ynab_budget_health',
      description:
        'Check budget health for the current month. Returns each category with status: overspent, warning, on_track, or ahead — compared against how far through the month we are. Perfect for morning briefings and end-of-day wrap-ups.',
      inputSchema: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'Month in YYYY-MM-01 format (default: current month)' },
          status_filter: {
            type: 'string',
            description: 'Filter to a specific status: overspent | warning | on_track | ahead',
          },
        },
      },
    },
    {
      name: 'ynab_monthly_summary',
      description:
        'Get monthly income, spending, savings rate, age of money, to-be-budgeted amount, and top spending groups. Good for both morning briefing (month context) and end-of-day wrap-up.',
      inputSchema: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'Month in YYYY-MM-01 format (default: current month)' },
        },
      },
    },
    {
      name: 'ynab_goal_progress',
      description:
        'Get progress on all savings and spending goals. Returns percentage complete, whether each goal is on track, and the target date if set.',
      inputSchema: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'Month context in YYYY-MM-01 format (default: current month)' },
        },
      },
    },
    {
      name: 'ynab_get_accounts',
      description:
        'Get all account balances and net worth (assets minus liabilities). Useful for morning briefing net worth snapshot.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ynab_spending_trends',
      description:
        'Analyse spending patterns across the last N months per category. Returns avg spending, consistency (always_over / often_over / on_target / often_under / always_under), trend direction (increasing/stable/decreasing), and a suggested budget adjustment. This is the tool to use when the user asks "what do you think about my budget?", "are my targets realistic?", or "where should I adjust my budget?".',
      inputSchema: {
        type: 'object',
        properties: {
          months:    { type: 'number',  description: 'Number of past months to analyse (default: 3, max: 12)' },
          group:     { type: 'string',  description: 'Filter by category group name (partial match)' },
          flag_only: { type: 'boolean', description: 'Return only categories with actionable insights (over/under budget or increasing trend)' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case 'ynab_list_unapproved':
        result = await handleListUnapproved(args as { days?: number; since_date?: string });
        break;
      case 'ynab_list_approved':
        result = await handleListApproved(args as { days?: number; since_date?: string; account_id?: string; category_id?: string });
        break;
      case 'ynab_approve':
        result = await handleApprove(args as { transaction_id: string });
        break;
      case 'ynab_approve_all':
        result = await handleApproveAll(args as { days?: number; since_date?: string });
        break;
      case 'ynab_categorize_and_approve':
        result = await handleCategorizAndApprove(args as { transaction_id: string; category: string });
        break;
      case 'ynab_get_summary':
        result = await handleGetSummary(args as { date?: string });
        break;
      case 'ynab_list_uncategorized':
        result = await handleListUncategorized(args as { days?: number; since_date?: string });
        break;
      case 'ynab_categorize':
        result = await handleCategorize(args as { transaction_id: string; category: string });
        break;
      case 'ynab_list_categories':
        result = handleListCategories(args as { search?: string; group?: string; include_hidden?: boolean });
        break;
      case 'ynab_sync_categories':
        result = await handleSyncCategories();
        break;
      case 'ynab_budget_health':
        result = await handleBudgetHealth(args as { month?: string; status_filter?: string });
        break;
      case 'ynab_monthly_summary':
        result = await handleMonthlySummary(args as { month?: string });
        break;
      case 'ynab_goal_progress':
        result = await handleGoalProgress(args as { month?: string });
        break;
      case 'ynab_get_accounts':
        result = await handleGetAccounts();
        break;
      case 'ynab_spending_trends':
        result = await handleSpendingTrends(args as { months?: number; group?: string; flag_only?: boolean });
        break;
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

// Start
const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  process.stderr.write(`MCP server failed to start: ${err}\n`);
  process.exit(1);
});
