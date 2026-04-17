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
import { loadConfig } from './config';
import * as h from './handlers';

function getClient(): { client: YNABClient; budgetId: string; budgetName: string } {
  const config = loadConfig();
  return {
    client: new YNABClient(config.token),
    budgetId: config.budgetId,
    budgetName: config.budgetName,
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
      description: 'Assign a category to a transaction. Optionally set a memo/note at the same time. Use ynab_list_categories to find category IDs or names.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', description: 'Transaction ID' },
          category: { type: 'string', description: 'Category UUID or name (fuzzy matched). Use UUID to avoid ambiguity.' },
          memo: { type: 'string', description: 'Optional memo/note to set on the transaction' },
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
      description: 'List approved transactions in a date range. Use this to find, look up, or locate a specific transaction that has already been approved — e.g. to recategorize it, check an amount, or get its ID. Also useful for auditing spending history.',
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
      description: 'Categorize a transaction AND approve it in a single API call. Optionally set a memo/note at the same time. The most efficient tool for the evening wrap-up — handles both steps at once.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', description: 'Transaction ID' },
          category: { type: 'string', description: 'Category UUID or name (fuzzy matched)' },
          memo: { type: 'string', description: 'Optional memo/note to set on the transaction' },
        },
        required: ['transaction_id', 'category'],
      },
    },
    {
      name: 'ynab_update_transaction',
      description: 'Update a transaction\'s memo, category, or approval status. Use this to add or change a memo/note on any transaction (approved or not), fix a category, or approve it. At least one of memo, category, or approved must be provided.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', description: 'Transaction ID to update' },
          memo: { type: 'string', description: 'New memo/note text. Pass an empty string to clear it.' },
          category: { type: 'string', description: 'Category UUID or name (fuzzy matched) to reassign' },
          approved: { type: 'boolean', description: 'Set to true to approve the transaction' },
        },
        required: ['transaction_id'],
      },
    },
    {
      name: 'ynab_budget_health',
      description: 'Check budget health for the current month. Returns each category with status: overspent, warning, on_track, or ahead — compared against how far through the month we are.',
      inputSchema: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'Month in YYYY-MM-01 format (default: current month)' },
          status_filter: { type: 'string', description: 'Filter to a specific status: overspent | warning | on_track | ahead' },
        },
      },
    },
    {
      name: 'ynab_monthly_summary',
      description: 'Get monthly income, spending, savings rate, age of money, to-be-budgeted amount, and top spending groups.',
      inputSchema: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'Month in YYYY-MM-01 format (default: current month)' },
        },
      },
    },
    {
      name: 'ynab_goal_progress',
      description: 'Get progress on all savings and spending goals. Returns percentage complete, whether each goal is on track, and the target date if set.',
      inputSchema: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'Month context in YYYY-MM-01 format (default: current month)' },
        },
      },
    },
    {
      name: 'ynab_get_accounts',
      description: 'Get all account balances and net worth (assets minus liabilities).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ynab_spending_trends',
      description: 'Analyse spending patterns across the last N months per category. Returns avg spending, consistency, trend direction, and suggested budget adjustments.',
      inputSchema: {
        type: 'object',
        properties: {
          months:    { type: 'number',  description: 'Number of past months to analyse (default: 3, max: 12)' },
          group:     { type: 'string',  description: 'Filter by category group name (partial match)' },
          flag_only: { type: 'boolean', description: 'Return only categories with actionable insights' },
        },
      },
    },
    {
      name: 'ynab_list_scheduled',
      description: 'List upcoming scheduled and recurring transactions (bills, subscriptions, transfers).',
      inputSchema: {
        type: 'object',
        properties: {
          days_ahead: { type: 'number', description: 'How many days ahead to look (default: 30)' },
        },
      },
    },
    {
      name: 'ynab_set_budget',
      description: "Update the budgeted amount for a category in a given month.",
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Category UUID or name (fuzzy matched)' },
          amount:   { type: 'number', description: 'New budgeted amount in dollars (e.g. 150.00)' },
          month:    { type: 'string', description: 'Month in YYYY-MM-01 format (default: current month)' },
        },
        required: ['category', 'amount'],
      },
    },
    {
      name: 'ynab_search_transactions',
      description: 'Search all transactions (approved and unapproved) by payee name or category. Use this to find a specific transaction when you know who it was paid to or what category it is in. Returns transaction IDs needed for recategorizing or approving.',
      inputSchema: {
        type: 'object',
        properties: {
          payee_name:    { type: 'string', description: 'Payee name to search (partial match)' },
          payee_id:      { type: 'string', description: 'Exact payee UUID' },
          category_name: { type: 'string', description: 'Category name to search (fuzzy match)' },
          category_id:   { type: 'string', description: 'Exact category UUID' },
          days:          { type: 'number', description: 'Look back N days (default: 90)' },
          since_date:    { type: 'string', description: 'Look back since YYYY-MM-DD (overrides days)' },
        },
      },
    },
    {
      name: 'ynab_list_payees',
      description: 'List all payees. Useful for finding payee IDs for ynab_search_transactions or ynab_rename_payee.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Filter by name (partial match)' },
        },
      },
    },
    {
      name: 'ynab_rename_payee',
      description: 'Rename a payee. Useful for cleaning up imported payee names.',
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
      description: 'Trigger an import of transactions from all linked bank accounts.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ynab_create_transaction',
      description: 'Manually log a transaction. Amount in dollars — negative for outflow, positive for inflow.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string', description: 'Account UUID (use ynab_get_accounts to find IDs)' },
          amount:     { type: 'number', description: 'Amount in dollars. Negative for outflow, positive for inflow.' },
          date:       { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
          payee_name: { type: 'string', description: 'Payee name (creates payee if it does not exist)' },
          category:   { type: 'string', description: 'Category UUID or name (fuzzy matched)' },
          memo:       { type: 'string', description: 'Optional memo / note' },
          approved:   { type: 'boolean', description: 'Mark as approved immediately (default: false)' },
        },
        required: ['account_id', 'amount'],
      },
    },
    {
      name: 'ynab_delete_transaction',
      description: 'Permanently delete a transaction by ID. Cannot be undone.',
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
    const { client, budgetId, budgetName } = getClient();
    let result: unknown;

    switch (name) {
      case 'ynab_get_summary':            result = await h.handleGetSummary(client, budgetId, budgetName, args as { date?: string }); break;
      case 'ynab_list_uncategorized':     result = await h.handleListUncategorized(client, budgetId, budgetName, args as { days?: number; since_date?: string }); break;
      case 'ynab_list_unapproved':        result = await h.handleListUnapproved(client, budgetId, budgetName, args as { days?: number; since_date?: string }); break;
      case 'ynab_list_approved':          result = await h.handleListApproved(client, budgetId, budgetName, args as { days?: number; since_date?: string; account_id?: string; category_id?: string }); break;
      case 'ynab_approve':                result = await h.handleApprove(client, budgetId, budgetName, args as { transaction_id: string }); break;
      case 'ynab_approve_all':            result = await h.handleApproveAll(client, budgetId, budgetName, args as { days?: number; since_date?: string }); break;
      case 'ynab_categorize':             result = await h.handleCategorize(client, budgetId, budgetName, args as { transaction_id: string; category: string; memo?: string }); break;
      case 'ynab_categorize_and_approve': result = await h.handleCategorizeAndApprove(client, budgetId, budgetName, args as { transaction_id: string; category: string; memo?: string }); break;
      case 'ynab_update_transaction':     result = await h.handleUpdateTransaction(client, budgetId, budgetName, args as { transaction_id: string; memo?: string; category?: string; approved?: boolean }); break;
      case 'ynab_list_categories':        result = await h.handleListCategories(client, budgetId, budgetName, args as { search?: string; group?: string; include_hidden?: boolean }); break;
      case 'ynab_sync_categories':        result = await h.handleSyncCategories(client, budgetId, budgetName, {} as Record<string, never>); break;
      case 'ynab_budget_health':          result = await h.handleBudgetHealth(client, budgetId, budgetName, args as { month?: string; status_filter?: string }); break;
      case 'ynab_monthly_summary':        result = await h.handleMonthlySummary(client, budgetId, budgetName, args as { month?: string }); break;
      case 'ynab_goal_progress':          result = await h.handleGoalProgress(client, budgetId, budgetName, args as { month?: string }); break;
      case 'ynab_get_accounts':           result = await h.handleGetAccounts(client, budgetId, budgetName, {} as Record<string, never>); break;
      case 'ynab_spending_trends':        result = await h.handleSpendingTrends(client, budgetId, budgetName, args as { months?: number; group?: string; flag_only?: boolean }); break;
      case 'ynab_list_scheduled':         result = await h.handleListScheduled(client, budgetId, budgetName, args as { days_ahead?: number }); break;
      case 'ynab_set_budget':             result = await h.handleSetBudget(client, budgetId, budgetName, args as { category: string; amount: number; month?: string }); break;
      case 'ynab_search_transactions':    result = await h.handleSearchTransactions(client, budgetId, budgetName, args as { payee_name?: string; payee_id?: string; category_name?: string; category_id?: string; days?: number; since_date?: string }); break;
      case 'ynab_list_payees':            result = await h.handleListPayees(client, budgetId, budgetName, args as { search?: string }); break;
      case 'ynab_rename_payee':           result = await h.handleRenamePayee(client, budgetId, budgetName, args as { payee_id: string; name: string }); break;
      case 'ynab_import_transactions':    result = await h.handleImportTransactions(client, budgetId, budgetName, {} as Record<string, never>); break;
      case 'ynab_create_transaction':     result = await h.handleCreateTransaction(client, budgetId, budgetName, args as { account_id: string; amount: number; date?: string; payee_name?: string; category?: string; memo?: string; approved?: boolean }); break;
      case 'ynab_delete_transaction':     result = await h.handleDeleteTransaction(client, budgetId, budgetName, args as { transaction_id: string }); break;
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
