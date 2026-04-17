import { YNABClient } from './api';
import { loadCategoryCache, saveCategoryCache } from './config';
import { formatAmount, daysAgoISO, todayISO, currentMonthISO, lastNMonths } from './format';
import { resolveCategory, getOrFetchCategories, buildCache, mergeGroups } from './categories';
import { isUncategorized, monthProgress, computeStatus } from './budget';
import type { Transaction, BudgetStatus, ScheduledTransaction } from './types';

// ── daily summary ─────────────────────────────────────────────────────────────

export async function handleGetSummary(
  client: YNABClient,
  budgetId: string,
  budgetName: string,
  args: { date?: string }
) {
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
      id: t.id, date: t.date, amount: t.amount,
      amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name, account_name: t.account_name,
      category_name: t.category_name, memo: t.memo,
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

// ── transactions ──────────────────────────────────────────────────────────────

export async function handleListUncategorized(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { days?: number; since_date?: string }
) {
  const sinceDate = args.since_date ?? daysAgoISO(args.days ?? 30);
  const transactions = await client.getTransactions(budgetId, sinceDate, 'uncategorized');
  const uncategorized = transactions.filter(isUncategorized).sort((a, b) => b.date.localeCompare(a.date));

  return {
    since_date: sinceDate,
    count: uncategorized.length,
    transactions: uncategorized.map((t) => ({
      id: t.id, date: t.date, amount: t.amount,
      amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name, account_name: t.account_name,
      memo: t.memo, cleared: t.cleared, approved: t.approved,
    })),
  };
}

export async function handleListUnapproved(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { days?: number; since_date?: string }
) {
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
      id: t.id, date: t.date, amount: t.amount,
      amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name, account_name: t.account_name,
      category_id: t.category_id, category_name: t.category_name,
      memo: t.memo, cleared: t.cleared,
    })),
  };
}

export async function handleListApproved(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { days?: number; since_date?: string; account_id?: string; category_id?: string }
) {
  const sinceDate = args.since_date ?? daysAgoISO(args.days ?? 30);
  const transactions = await client.getTransactions(budgetId, sinceDate);
  let approved = transactions.filter((t) => !t.deleted && t.approved);
  if (args.account_id) approved = approved.filter((t) => t.account_id === args.account_id);
  if (args.category_id) approved = approved.filter((t) => t.category_id === args.category_id);
  approved.sort((a, b) => b.date.localeCompare(a.date));

  return {
    since_date: sinceDate,
    count: approved.length,
    transactions: approved.map((t) => ({
      id: t.id, date: t.date, amount: t.amount,
      amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name, account_id: t.account_id, account_name: t.account_name,
      category_id: t.category_id, category_name: t.category_name,
      memo: t.memo, cleared: t.cleared, approved: t.approved,
    })),
  };
}

export async function handleSearchTransactions(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: {
    payee_name?: string; payee_id?: string;
    category_name?: string; category_id?: string;
    days?: number; since_date?: string;
  }
) {
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
      if (matches.length > 1) throw new Error(
        `Multiple payees match "${args.payee_name}": ${matches.map((p) => `${p.name} (${p.id})`).join(', ')}. Use payee_id.`
      );
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
    total,
    total_formatted: formatAmount(total),
    transactions: filtered.map((t) => ({
      id: t.id, date: t.date, amount: t.amount,
      amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name, account_name: t.account_name,
      category_name: t.category_name, memo: t.memo, approved: t.approved,
    })),
  };
}

// ── approve ───────────────────────────────────────────────────────────────────

export async function handleApprove(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { transaction_id: string }
) {
  const updated = await client.updateTransaction(budgetId, args.transaction_id, { approved: true });
  return {
    ok: true,
    transaction: {
      id: updated.id, date: updated.date, amount: updated.amount,
      amount_formatted: formatAmount(updated.amount),
      payee_name: updated.payee_name, category_name: updated.category_name,
      approved: updated.approved,
    },
  };
}

export async function handleApproveAll(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { days?: number; since_date?: string }
) {
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

// ── categorize ────────────────────────────────────────────────────────────────

export async function handleCategorize(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { transaction_id: string; category: string; memo?: string }
) {
  const cache = await getOrFetchCategories(client, budgetId);
  const category = resolveCategory(args.category, cache.flat);
  const patch: { category_id: string; memo?: string } = { category_id: category.id };
  if (args.memo !== undefined) patch.memo = args.memo;
  const updated = await client.updateTransaction(budgetId, args.transaction_id, patch);

  return {
    ok: true,
    transaction: {
      id: updated.id, date: updated.date, amount: updated.amount,
      amount_formatted: formatAmount(updated.amount),
      payee_name: updated.payee_name, category_id: updated.category_id,
      category_name: updated.category_name, account_name: updated.account_name,
      memo: updated.memo,
    },
  };
}

export async function handleCategorizeAndApprove(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { transaction_id: string; category: string; memo?: string }
) {
  const cache = await getOrFetchCategories(client, budgetId);
  const category = resolveCategory(args.category, cache.flat);
  const patch: { category_id: string; approved: boolean; memo?: string } = {
    category_id: category.id,
    approved: true,
  };
  if (args.memo !== undefined) patch.memo = args.memo;
  const updated = await client.updateTransaction(budgetId, args.transaction_id, patch);

  return {
    ok: true,
    transaction: {
      id: updated.id, date: updated.date, amount: updated.amount,
      amount_formatted: formatAmount(updated.amount),
      payee_name: updated.payee_name, category_id: updated.category_id,
      category_name: updated.category_name, approved: updated.approved,
      memo: updated.memo,
    },
  };
}

export async function handleUpdateTransaction(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { transaction_id: string; memo?: string; category?: string; approved?: boolean }
) {
  const patch: { memo?: string; category_id?: string; approved?: boolean } = {};
  if (args.memo !== undefined) patch.memo = args.memo;
  if (args.approved !== undefined) patch.approved = args.approved;
  if (args.category) {
    const cache = await getOrFetchCategories(client, budgetId);
    const category = resolveCategory(args.category, cache.flat);
    patch.category_id = category.id;
  }
  const updated = await client.updateTransaction(budgetId, args.transaction_id, patch);

  return {
    ok: true,
    transaction: {
      id: updated.id, date: updated.date, amount: updated.amount,
      amount_formatted: formatAmount(updated.amount),
      payee_name: updated.payee_name, category_id: updated.category_id,
      category_name: updated.category_name, account_name: updated.account_name,
      memo: updated.memo, approved: updated.approved,
    },
  };
}

// ── categories ────────────────────────────────────────────────────────────────

export async function handleListCategories(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { search?: string; group?: string; include_hidden?: boolean }
) {
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
      id: c.id, name: c.name, group_name: c.groupName, group_id: c.groupId, hidden: c.hidden,
    })),
  };
}

export async function handleSyncCategories(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  _args: Record<string, never>
) {
  const existing = loadCategoryCache(budgetId);
  const { groups: deltaGroups, serverKnowledge } = await client.getCategories(
    budgetId,
    existing?.serverKnowledge
  );

  const groups = existing ? mergeGroups(existing.groups, deltaGroups) : deltaGroups;
  const cache = buildCache(budgetId, groups, serverKnowledge);
  saveCategoryCache(budgetId, cache);

  return {
    ok: true,
    sync_type: existing !== null ? 'delta' : 'full',
    changed_groups: deltaGroups.length,
    category_count: cache.flat.filter((c) => !c.deleted).length,
    group_count: groups.filter((g) => !g.deleted).length,
    last_synced: cache.lastSynced,
  };
}

// ── budget analysis ───────────────────────────────────────────────────────────

export async function handleBudgetHealth(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { month?: string; status_filter?: string }
) {
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

export async function handleMonthlySummary(
  client: YNABClient,
  budgetId: string,
  budgetName: string,
  args: { month?: string }
) {
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

export async function handleGoalProgress(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { month?: string }
) {
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

export async function handleSpendingTrends(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { months?: number; group?: string; flag_only?: boolean }
) {
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
        catMap.set(cat.id, {
          name: cat.name,
          groupName: cat.category_group_name ?? groupNameById.get(cat.id) ?? '',
          currentBudget: 0,
          months: [{ month: m!.month, budgeted: cat.budgeted, activity: cat.activity }],
        });
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
  type TrendDir = 'increasing' | 'stable' | 'decreasing' | 'insufficient_data';

  const computeTrend = (spending: number[]): TrendDir => {
    if (spending.length < 2) return 'insufficient_data';
    const mid = Math.floor(spending.length / 2);
    const first = spending.slice(0, mid).reduce((s, v) => s + v, 0) / mid;
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

  const roundUp = (x: number) => Math.ceil(x / 5000) * 5000;
  const suggestBudget = (avg: number, c: Consistency) =>
    c === 'always_over' || c === 'often_over' ? roundUp(avg * 1.1) : roundUp(avg * 1.05);

  const results = [];
  for (const [id, data] of entries) {
    if (!data.months.length) continue;
    const sorted = [...data.months].sort((a, b) => a.month.localeCompare(b.month));
    const spending = sorted.map((m) => Math.abs(m.activity));
    const avg = spending.reduce((s, v) => s + v, 0) / spending.length;
    const over = sorted.filter((m) => Math.abs(m.activity) > m.budgeted && m.budgeted > 0).length;
    const under = sorted.filter((m) => Math.abs(m.activity) < m.budgeted * 0.85 && m.budgeted > 0).length;
    const consistency = computeConsistency(over, under, sorted.length);
    const trend = computeTrend(spending);
    const suggested = suggestBudget(avg, consistency);
    const delta = suggested - data.currentBudget;

    results.push({
      category_id: id, category_name: data.name, group_name: data.groupName,
      current_budget: data.currentBudget,
      current_budget_formatted: formatAmount(data.currentBudget),
      avg_spending: Math.round(avg),
      avg_spending_formatted: formatAmount(Math.round(avg)),
      suggested_budget: suggested,
      suggested_budget_formatted: formatAmount(suggested),
      budget_delta: delta,
      budget_delta_formatted: (delta >= 0 ? '+' : '') + formatAmount(delta),
      trend, consistency,
      over_budget_months: over, under_budget_months: under,
      total_months: sorted.length, monthly_data: sorted,
    });
  }

  const ORDER: Consistency[] = ['always_over', 'often_over', 'on_target', 'often_under', 'always_under'];
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

export async function handleSetBudget(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { category: string; amount: number; month?: string }
) {
  const cache = await getOrFetchCategories(client, budgetId);
  const cat = resolveCategory(args.category, cache.flat);
  const month = args.month ?? currentMonthISO();
  const budgeted = Math.round(args.amount * 1000);

  const updated = await client.updateCategoryMonth(budgetId, month, cat.id, budgeted);

  return {
    ok: true, month,
    category_id: updated.id, category_name: updated.name,
    budgeted: updated.budgeted, budgeted_formatted: formatAmount(updated.budgeted),
    balance: updated.balance, balance_formatted: formatAmount(updated.balance),
  };
}

// ── accounts ──────────────────────────────────────────────────────────────────

export async function handleGetAccounts(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  _args: Record<string, never>
) {
  const all = await client.getAccounts(budgetId);
  const accounts = all.filter((a) => !a.deleted && !a.closed);

  const isLiability = (type: string) =>
    ['creditCard', 'lineOfCredit', 'mortgage', 'autoLoan', 'studentLoan',
     'personalLoan', 'medicalDebt', 'otherDebt', 'otherLiability'].includes(type);

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
      id: a.id, name: a.name, type: a.type, on_budget: a.on_budget,
      balance: a.balance, balance_formatted: formatAmount(a.balance),
      cleared_balance: a.cleared_balance, uncleared_balance: a.uncleared_balance,
      is_liability: isLiability(a.type),
    })),
  };
}

// ── scheduled ─────────────────────────────────────────────────────────────────

export async function handleListScheduled(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { days_ahead?: number }
) {
  const all = await client.getScheduledTransactions(budgetId);

  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(today.getDate() + (args.days_ahead ?? 30));
  const cutoffISO = cutoff.toISOString().split('T')[0];

  const scheduled = all
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
      id: t.id, date_next: t.date_next, frequency: t.frequency,
      amount: t.amount, amount_formatted: formatAmount(t.amount),
      payee_name: t.payee_name, account_name: t.account_name,
      category_name: t.category_name, memo: t.memo,
      is_transfer: !!t.transfer_account_id,
    })),
  };
}

// ── payees ────────────────────────────────────────────────────────────────────

export async function handleListPayees(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { search?: string }
) {
  const all = await client.getPayees(budgetId);
  let payees = all.filter((p) => !p.deleted && !p.transfer_account_id);
  if (args.search) {
    const q = args.search.toLowerCase();
    payees = payees.filter((p) => p.name.toLowerCase().includes(q));
  }
  payees.sort((a, b) => a.name.localeCompare(b.name));
  return { count: payees.length, payees: payees.map((p) => ({ id: p.id, name: p.name })) };
}

export async function handleRenamePayee(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { payee_id: string; name: string }
) {
  const updated = await client.updatePayee(budgetId, args.payee_id, args.name);
  return { ok: true, payee: { id: updated.id, name: updated.name } };
}

// ── create / delete ───────────────────────────────────────────────────────────

export async function handleCreateTransaction(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { account_id: string; amount: number; date?: string; payee_name?: string; category?: string; memo?: string; approved?: boolean }
) {
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
      id: created.id, date: created.date, amount: created.amount,
      amount_formatted: formatAmount(created.amount),
      payee_name: created.payee_name, account_name: created.account_name,
      category_name: created.category_name, memo: created.memo, approved: created.approved,
    },
  };
}

export async function handleDeleteTransaction(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  args: { transaction_id: string }
) {
  const deleted = await client.deleteTransaction(budgetId, args.transaction_id);
  return {
    ok: true,
    transaction: {
      id: deleted.id, date: deleted.date, amount: deleted.amount,
      amount_formatted: formatAmount(deleted.amount),
      payee_name: deleted.payee_name, account_name: deleted.account_name,
    },
  };
}

export async function handleImportTransactions(
  client: YNABClient,
  budgetId: string,
  _budgetName: string,
  _args: Record<string, never>
) {
  const ids = await client.importTransactions(budgetId);
  return { ok: true, imported_count: ids.length, transaction_ids: ids };
}
