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
import { formatAmount, daysAgoISO, todayISO } from './format';
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: unknown;

    switch (name) {
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
