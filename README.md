# ynab-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [YNAB](https://www.ynab.com) — lets Claude (and any MCP-compatible client) read and manage your budget.

## What it does

Exposes 15 tools covering the full daily YNAB workflow:

| Tool | Description |
|---|---|
| `ynab_get_summary` | Daily spending summary — inflows, outflows, top expenses, by category and account |
| `ynab_monthly_summary` | Monthly income, spending, savings rate, age of money, top groups |
| `ynab_budget_health` | Category-level health for the month: overspent / warning / on_track / ahead |
| `ynab_goal_progress` | Savings goal completion and on-track status |
| `ynab_get_accounts` | Account balances and net worth |
| `ynab_spending_trends` | Multi-month spending patterns, consistency, trend direction, suggested budget |
| `ynab_list_uncategorized` | Transactions missing a category |
| `ynab_list_unapproved` | Transactions not yet approved |
| `ynab_list_approved` | Approved transactions (filterable by account or category) |
| `ynab_categorize` | Assign a category to a transaction |
| `ynab_approve` | Approve a single transaction |
| `ynab_categorize_and_approve` | Categorize + approve in one API call |
| `ynab_approve_all` | Approve all unapproved transactions in a date range |
| `ynab_list_categories` | Browse categories from the local cache |
| `ynab_sync_categories` | Refresh the local category cache from YNAB |

## Requirements

- Node.js 18+
- A [YNAB Personal Access Token](https://app.ynab.com/settings/developer)

## Installation

```bash
git clone https://github.com/your-username/ynab-mcp.git
cd ynab-mcp
npm install
npm run build
```

## Configuration

Run the setup wizard to save your token and default budget:

```bash
node dist/mcp-server.js setup
```

This writes `~/.ynab-cli/config.json` (mode `0600`). The file looks like:

```json
{
  "token": "your-ynab-personal-access-token",
  "budgetId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "budgetName": "My Budget"
}
```

You can also create it manually if you prefer.

## Register with Claude Code

Add to your `~/.claude/claude.json` (global) or `.mcp.json` (project-level):

```json
{
  "mcpServers": {
    "ynab": {
      "command": "node",
      "args": ["/absolute/path/to/ynab-mcp/dist/mcp-server.js"]
    }
  }
}
```

Restart Claude Code after saving.

## Register with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "ynab": {
      "command": "node",
      "args": ["/absolute/path/to/ynab-mcp/dist/mcp-server.js"]
    }
  }
}
```

## Usage examples

Once registered, you can talk to Claude naturally:

- *"How am I doing on my budget this month?"* → `ynab_budget_health`
- *"What did I spend today?"* → `ynab_get_summary`
- *"Categorize my uncategorized transactions"* → `ynab_list_uncategorized` + `ynab_categorize_and_approve`
- *"Am I on track with my savings goals?"* → `ynab_goal_progress`
- *"Are my budget targets realistic based on the last 3 months?"* → `ynab_spending_trends`

## Category cache

Several tools (`ynab_categorize`, `ynab_list_categories`) rely on a local category cache at `~/.ynab-cli/categories.json`. Populate it by calling `ynab_sync_categories` — or ask Claude: *"sync my categories"*.

## Data storage

| File | Purpose |
|---|---|
| `~/.ynab-cli/config.json` | API token + default budget ID |
| `~/.ynab-cli/categories.json` | Local category cache |

Both files are created with restricted permissions (`0600`).

## License

MIT
