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
import { loadConfig, loadCategoryCache, saveCategoryCache } from './config';
import { formatAmount, daysAgoISO, todayISO, currentMonthISO, lastNMonths } from './format';
import type { Transaction, FlatCategory, BudgetStatus, CategoryCache, ScheduledTransaction } from './types';

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

/**
 * Load the category cache for the given budget. If it doesn't exist, fetch
 * from the YNAB API, persist it, and return it so callers never have to
 * manually run ynab_sync_categories before categorizing.
 */
async function getOrFetchCategories(client: YNABClient, budgetId: string): Promise<CategoryCache> {
  const cached = loadCategoryCache(budgetId);
  if (cached) return cached;

  const { groups, serverKnowledge } = await client.getCategories(budgetId);
  const cache = buildCache(budgetId, groups, serverKnowledge);
  saveCategoryCache(budgetId, cache);
  return cache;
}

function buildCache(budgetId: string, groups: CategoryCache['groups'], serverKnowledge: number): CategoryCache {
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
  return { budgetId, lastSynced: new Date().toISOString(), serverKnowledge, groups, flat };
}

function mergeGroups(existing: CategoryCache['groups'], delta: CategoryCache['groups']): CategoryCache['groups'] {
  const groupMap = new Map(existing.map((g) => [g.id, { ...g, categories: [...g.categories] }]));
  for (const dg of delta) {
    const ex = groupMap.get(dg.id);
    if (!ex) {
      groupMap.set(dg.id, dg);
    } else {
      const catMap = new Map(ex.categories.map((c) => [c.id, c]));
      for (const cat of dg.categories) catMap.set(cat.id, cat);
      groupMap.set(dg.id, { ...ex, ...dg, categories: [...catMap.values()] });
    }
  }
  return [...groupMap.values()];
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
  const cache = await getOrFetchCategories(client, budgetId);
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

async function handleListCategories(args: { search?: string; group?: string; include_hidden?: boolean }) {
  const { client, budgetId } = getClient();
  const cache = await getOrFetchCategories(client, budgetId);

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

  const [budgetMonth, cache] = await Promise.all([
    client.getBudgetMonth(budgetId, month),
    getOrFetchCategories(client, budgetId),
  ]);
  const groupNameById = new Map(cache.flat.map((c) => [c.id, c.groupName]));

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
      group_name: cat.category_group_name ?? groupNameById.get(cat.id) ?? '',
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
  const [budgetMonth, cache] = await Promise.all([
    client.getBudgetMonth(budgetId, month),
    getOrFetchCategories(client, budgetId),
  ]);
  const mRate = monthProgress();
  const groupNameById = new Map(cache.flat.map((c) => [c.id, c.groupName]));

  const groupMap = new Map<string, { activity: number; budgeted: number }>();
  for (const cat of budgetMonth.categories) {
    if (cat.deleted || cat.hidden) continue;
    const g = cat.category_group_name ?? groupNameById.get(cat.id) ?? 'Other';
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
  const [budgetMonth, cache] = await Promise.all([
    client.getBudgetMonth(budgetId, month),
    getOrFetchCategories(client, budgetId),
  ]);
  const groupNameById = new Map(cache.flat.map((c) => [c.id, c.groupName]));

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
      group_name: cat.category_group_name ?? groupNameById.get(cat.id) ?? '',
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
  const cache = await getOrFetchCategories(client, budgetId);
  const category = resolveCategory(args.category, cache.flat);
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
  const [monthData, cache] = await Promise.all([
    Promise.all(monthList.map((m) => client.getBudgetMonth(budgetId, m).catch(() => null))),
    getOrFetchCategories(client, budgetId),
  ]);
  const groupNameById = new Map(cache.flat.map((c) => [c.id, c.groupName]));

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
        catMap.set(cat.id, { name: cat.name, groupName: cat.category_group_name ?? groupNameById.get(cat.id) ?? '', currentBudget: 0, months: [{ month: m!.month, budgeted: cat.budgeted, activity: cat.activity }] });
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

async function handleListScheduled(args: { days_ahead?: number; include_skipped?: boolean }) {
  const { client, budgetId } = getClient();
  const all = await client.getScheduledTransactions(budgetId);

  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(today.getDate() + (args.days_ahead ?? 30));
  const cutoffISO = cutoff.toISOString().split('T')[0];

  let scheduled = all
    .filter((t): t is ScheduledTransaction & { date_next: string } =>
      !t.deleted && t.date_next <= cutoffISO
    )
    .sort((a, b) => a.date_next.localeCompare(b.date_next));

  const totalOutflow = scheduled
    .filter((t) => t.amount < 0 && !t.transfer_account_id)
    .reduce((s, t) => s + t.amount, 0);

  return {
    count: scheduled.length,
    total_outflow: totalOutflow,
    total_outflow_formatted: formatAmount(totalOutflow),
    scheduled: scheduled.map((t) => ({
      id: t.id,
      date_next: t.date_next,
      frequency: t.frequency,
      amount: t.amount,
      amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name,
      account_name: t.account_name,
      category_name: t.category_name,
      memo: t.memo,
      is_transfer: !!t.transfer_account_id,
    })),
  };
}

async function handleSetBudget(args: { category: string; amount: number; month?: string }) {
  const { client, budgetId } = getClient();
  const cache = await getOrFetchCategories(client, budgetId);
  const cat = resolveCategory(args.category, cache.flat);
  const month = args.month ?? currentMonthISO();
  const budgeted = Math.round(args.amount * 1000);

  const updated = await client.updateCategoryMonth(budgetId, month, cat.id, budgeted);

  return {
    ok: true,
    month,
    category_id: updated.id,
    category_name: updated.name,
    budgeted: updated.budgeted,
    budgeted_formatted: formatAmount(updated.budgeted),
    balance: updated.balance,
    balance_formatted: formatAmount(updated.balance),
  };
}

async function handleSearchTransactions(args: {
  payee_name?: string;
  payee_id?: string;
  category_name?: string;
  category_id?: string;
  days?: number;
  since_date?: string;
}) {
  const { client, budgetId } = getClient();
  const sinceDate = args.since_date ?? daysAgoISO(args.days ?? 90);

  let transactions: Transaction[];
  let resolvedLabel: string;

  if (args.payee_id || args.payee_name) {
    let payeeId = args.payee_id;
    if (!payeeId) {
      const payees = await client.getPayees(budgetId);
      const q = args.payee_name!.toLowerCase();
      const matches = payees.filter((p) => !p.deleted && p.name.toLowerCase().includes(q));
      if (matches.length === 0) throw new Error(`No payee found matching "${args.payee_name}".`);
      if (matches.length > 1) throw new Error(`Multiple payees match "${args.payee_name}": ${matches.map((p) => `${p.name} (${p.id})`).join(', ')}. Use payee_id.`);
      payeeId = matches[0].id;
      resolvedLabel = matches[0].name;
    } else {
      resolvedLabel = payeeId;
    }
    transactions = await client.getTransactionsByPayee(budgetId, payeeId, sinceDate);
  } else if (args.category_id || args.category_name) {
    let categoryId = args.category_id;
    if (!categoryId) {
      const cache = await getOrFetchCategories(client, budgetId);
      const cat = resolveCategory(args.category_name!, cache.flat);
      categoryId = cat.id;
      resolvedLabel = cat.name;
    } else {
      resolvedLabel = categoryId;
    }
    transactions = await client.getTransactionsByCategory(budgetId, categoryId, sinceDate);
  } else {
    throw new Error('Provide at least one of: payee_name, payee_id, category_name, category_id.');
  }

  const filtered = transactions.filter((t) => !t.deleted).sort((a, b) => b.date.localeCompare(a.date));
  const total = filtered.reduce((s, t) => s + t.amount, 0);

  return {
    since_date: sinceDate,
    resolved_as: resolvedLabel!,
    count: filtered.length,
    total: total,
    total_formatted: formatAmount(total),
    transactions: filtered.map((t) => ({
      id: t.id,
      date: t.date,
      amount: t.amount,
      amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name,
      account_name: t.account_name,
      category_name: t.category_name,
      memo: t.memo,
      approved: t.approved,
    })),
  };
}

async function handleListPayees(args: { search?: string }) {
  const { client, budgetId } = getClient();
  const all = await client.getPayees(budgetId);
  let payees = all.filter((p) => !p.deleted && !p.transfer_account_id);
  if (args.search) {
    const q = args.search.toLowerCase();
    payees = payees.filter((p) => p.name.toLowerCase().includes(q));
  }
  payees.sort((a, b) => a.name.localeCompare(b.name));
  return { count: payees.length, payees: payees.map((p) => ({ id: p.id, name: p.name })) };
}

async function handleRenamePayee(args: { payee_id: string; name: string }) {
  const { client, budgetId } = getClient();
  const updated = await client.updatePayee(budgetId, args.payee_id, args.name);
  return { ok: true, payee: { id: updated.id, name: updated.name } };
}

async function handleCreateTransaction(args: {
  account_id: string;
  amount: number;
  date?: string;
  payee_name?: string;
  category?: string;
  memo?: string;
  approved?: boolean;
}) {
  const { client, budgetId } = getClient();
  let category_id: string | undefined;
  if (args.category) {
    const cache = await getOrFetchCategories(client, budgetId);
    category_id = resolveCategory(args.category, cache.flat).id;
  }

  const created = await client.createTransaction(budgetId, {
    account_id: args.account_id,
    date: args.date ?? todayISO(),
    amount: Math.round(args.amount * 1000),
    payee_name: args.payee_name,
    category_id,
    memo: args.memo,
    cleared: 'cleared',
    approved: args.approved ?? false,
  });

  return {
    ok: true,
    transaction: {
      id: created.id,
      date: created.date,
      amount: created.amount,
      amount_formatted: formatAmount(created.amount),
      payee_name: created.payee_name,
      account_name: created.account_name,
      category_name: created.category_name,
      memo: created.memo,
      approved: created.approved,
    },
  };
}

async function handleDeleteTransaction(args: { transaction_id: string }) {
  const { client, budgetId } = getClient();
  const deleted = await client.deleteTransaction(budgetId, args.transaction_id);
  return {
    ok: true,
    transaction: {
      id: deleted.id,
      date: deleted.date,
      amount: deleted.amount,
      amount_formatted: formatAmount(deleted.amount),
      payee_name: deleted.payee_name,
      account_name: deleted.account_name,
    },
  };
}

async function handleImportTransactions() {
  const { client, budgetId } = getClient();
  const ids = await client.importTransactions(budgetId);
  return { ok: true, imported_count: ids.length, transaction_ids: ids };
}

async function handleSyncCategories() {
  const { client, budgetId } = getClient();
  const existing = loadCategoryCache(budgetId);

  const { groups: deltaGroups, serverKnowledge } = await client.getCategories(
    budgetId,
    existing?.serverKnowledge
  );

  const groups = existing ? mergeGroups(existing.groups, deltaGroups) : deltaGroups;
  const cache = buildCache(budgetId, groups, serverKnowledge);
  saveCategoryCache(budgetId, cache);

  const isDelta = existing !== null;
  return {
    ok: true,
    sync_type: isDelta ? 'delta' : 'full',
    changed_groups: deltaGroups.length,
    category_count: cache.flat.filter((c) => !c.deleted).length,
    group_count: groups.filter((g) => !g.deleted).length,
    last_synced: cache.lastSynced,
  };
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
    {
      name: 'ynab_list_scheduled',
      description: 'List upcoming scheduled and recurring transactions (bills, subscriptions, transfers). Useful for "what bills are due this month?" or "what recurring payments do I have coming up?"',
      inputSchema: {
        type: 'object',
        properties: {
          days_ahead: { type: 'number', description: 'How many days ahead to look (default: 30)' },
        },
      },
    },
    {
      name: 'ynab_set_budget',
      description: 'Update the budgeted amount for a category in a given month. Use this to adjust budget targets mid-month or to set next month\'s budget based on spending trends.',
      inputSchema: {
        type: 'object',
        properties: {
          category:  { type: 'string', description: 'Category UUID or name (fuzzy matched)' },
          amount:    { type: 'number', description: 'New budgeted amount in dollars (e.g. 150.00)' },
          month:     { type: 'string', description: 'Month in YYYY-MM-01 format (default: current month)' },
        },
        required: ['category', 'amount'],
      },
    },
    {
      name: 'ynab_search_transactions',
      description: 'Search transactions by payee or category. Useful for "show me all my Amazon purchases" or "what hit my Dining Out category last month?". Provide payee_name/payee_id OR category_name/category_id.',
      inputSchema: {
        type: 'object',
        properties: {
          payee_name:   { type: 'string', description: 'Payee name to search (partial match)' },
          payee_id:     { type: 'string', description: 'Exact payee UUID' },
          category_name: { type: 'string', description: 'Category name to search (fuzzy match)' },
          category_id:  { type: 'string', description: 'Exact category UUID' },
          days:         { type: 'number', description: 'Look back N days (default: 90)' },
          since_date:   { type: 'string', description: 'Look back since YYYY-MM-DD (overrides days)' },
        },
      },
    },
    {
      name: 'ynab_list_payees',
      description: 'List all payees (merchants, people, places you pay). Useful for finding payee IDs for ynab_search_transactions or ynab_rename_payee.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Filter by name (partial match)' },
        },
      },
    },
    {
      name: 'ynab_rename_payee',
      description: 'Rename a payee. Useful for cleaning up imported payee names (e.g. "AMZN*1234XYZ" → "Amazon").',
      inputSchema: {
        type: 'object',
        properties: {
          payee_id: { type: 'string', description: 'Payee UUID (use ynab_list_payees to find it)' },
          name:     { type: 'string', description: 'New payee name' },
        },
        required: ['payee_id', 'name'],
      },
    },
    {
      name: 'ynab_import_transactions',
      description: 'Trigger an import of transactions from all linked bank accounts. Returns the number of new transactions imported. Use when the user asks to sync or refresh their bank transactions.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ynab_create_transaction',
      description: 'Manually log a transaction (e.g. a cash purchase or manual entry). Amount is in dollars — use negative for outflow (spending) and positive for inflow (income).',
      inputSchema: {
        type: 'object',
        properties: {
          account_id:  { type: 'string', description: 'Account UUID to log the transaction in (use ynab_get_accounts to find IDs)' },
          amount:      { type: 'number', description: 'Amount in dollars. Negative for outflow (e.g. -12.50), positive for inflow.' },
          date:        { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
          payee_name:  { type: 'string', description: 'Payee name (creates payee if it does not exist)' },
          category:    { type: 'string', description: 'Category UUID or name (fuzzy matched)' },
          memo:        { type: 'string', description: 'Optional memo / note' },
          approved:    { type: 'boolean', description: 'Mark as approved immediately (default: false)' },
        },
        required: ['account_id', 'amount'],
      },
    },
    {
      name: 'ynab_delete_transaction',
      description: 'Permanently delete a transaction by ID. Use with caution — this cannot be undone.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', description: 'Transaction UUID to delete' },
        },
        required: ['transaction_id'],
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
        result = await handleListCategories(args as { search?: string; group?: string; include_hidden?: boolean });
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
      case 'ynab_list_scheduled':
        result = await handleListScheduled(args as { days_ahead?: number });
        break;
      case 'ynab_set_budget':
        result = await handleSetBudget(args as { category: string; amount: number; month?: string });
        break;
      case 'ynab_search_transactions':
        result = await handleSearchTransactions(args as { payee_name?: string; payee_id?: string; category_name?: string; category_id?: string; days?: number; since_date?: string });
        break;
      case 'ynab_list_payees':
        result = await handleListPayees(args as { search?: string });
        break;
      case 'ynab_rename_payee':
        result = await handleRenamePayee(args as { payee_id: string; name: string });
        break;
      case 'ynab_import_transactions':
        result = await handleImportTransactions();
        break;
      case 'ynab_create_transaction':
        result = await handleCreateTransaction(args as { account_id: string; amount: number; date?: string; payee_name?: string; category?: string; memo?: string; approved?: boolean });
        break;
      case 'ynab_delete_transaction':
        result = await handleDeleteTransaction(args as { transaction_id: string });
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
