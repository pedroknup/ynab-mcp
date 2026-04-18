# Spike: include transaction IDs in YNAB budget context

**Notion task:** https://www.notion.so/346dbdded41c81dba473d8f59c9b4c5d
**Branch:** `feat/spike-ynab-transaction-ids`
**Status:** Investigation complete — no code change in this repo.

## Problem (restated)

Chief AI injects a short natural-language summary of YNAB state into the
assistant prompt. Today the summary looks like:

> `1 uncategorized transactions: Hazewinkel Via Tikkie -$15.00`

When the model wants to categorize one of those transactions it must first call
`ynab_list_uncategorized` to fetch the transaction UUID, then call
`ynab_categorize`. That's a wasted round-trip. If the ID (or a short form of
it) were already in the context string, the model could skip straight to
`ynab_categorize`.

## Where the summary is built

The "N uncategorized transactions: ..." string is **not built in this repo**.
It is built by Chief AI's Finance tab:

- File: `chief-ai/client/src/tabs/finance.js`
- Function: the context formatter — search for the literal
  `` `${txns.length} uncategorized transactions: ${list}` `` (around line 192).
- Current body:

  ```js
  const txns = data.uncategorized ?? [];
  if (txns.length) {
    const list = txns
      .map(t => `${t.payee_name} ${formatAmount(t.amount)} (${t.date})`)
      .join(', ');
    parts.push(`${txns.length} uncategorized transactions: ${list}`);
  }
  ```

`data.uncategorized` is the `transactions` array returned by the MCP tool
`ynab_list_uncategorized` (see `src/handlers.ts` → `handleListUncategorized`).

## What the MCP returns today

`handleListUncategorized` already emits `id` for every transaction:

```ts
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
```

`handleListUnapproved` (same file) likewise returns `id`.

**So the data is already available on the MCP side.** Nothing needs to change
in `ynab-cli` — the payload already carries the UUID. The gap is purely on the
Chief AI formatter, which happens to drop the `id` field when flattening to a
prose string.

## Recommended fix (on Chief AI, not here)

Change the formatter to include a short-form ID (first 8 chars of the UUID is
enough — YNAB UUIDs have plenty of entropy and Claude only needs a disambiguator
to pass back to `ynab_categorize`):

```js
const list = txns
  .map(t => `${t.payee_name} ${formatAmount(t.amount)} (${t.date}) [${t.id.slice(0, 8)}]`)
  .join(', ');
```

Producing e.g.:

> `1 uncategorized transactions: Hazewinkel Via Tikkie -$15.00 (2026-04-16) [a1b2c3d4]`

### Short-form vs full UUID — tradeoff

I recommend **full UUID, not truncated**.

- **Full UUID (recommended)**
  - Pros: zero ambiguity; `ynab_categorize` accepts it as-is — no
    disambiguation step, no fallback lookup ever needed.
  - Cons: 36 chars per transaction. With 5 uncategorized transactions that's
    ~180 extra context chars, which is trivial compared to the rest of the
    prompt (health section, budgets, etc.).
- **Short form (first 8 chars)**
  - Pros: more readable, ~28 fewer chars per txn.
  - Cons: the model has to resolve the short ID back to a full UUID before
    calling `ynab_categorize` (that tool takes a full UUID). If Chief AI caches
    the last `ynab_list_uncategorized` response it can resolve locally — but
    that re-introduces the very round-trip we're trying to avoid. If it
    doesn't, the model has to call `ynab_list_uncategorized` again, which
    defeats the purpose.

Given the goal is "one-shot categorization without an extra lookup
round-trip", the clean answer is **full UUID**. Context cost is negligible.

Format recommendation:

```
Hazewinkel Via Tikkie -$15.00 (2026-04-16) [id=a1b2c3d4-e5f6-7890-abcd-ef1234567890]
```

## Why no change in `ynab-cli`

- The MCP already returns transaction IDs in `ynab_list_uncategorized`,
  `ynab_list_unapproved`, `ynab_list_approved`, and `ynab_search_transactions`.
- There is no context-summary formatter in this repo to modify — the only
  text-level formatter is `src/format.ts`, which handles amount / date / pad
  helpers, not transaction summaries.
- The watcher (`watch-handlers.ts`) emits **category threshold** webhooks, not
  transaction summaries, so it's not related.

## Verification

- `npx tsc --noEmit` — clean (no errors).
- `npm test` — 133 / 133 passing.

## Follow-up

Open a task against Chief AI to update
`client/src/tabs/finance.js` (and the equivalent in the `serene-mayer`
worktree / the dashboard-refactor plan at
`docs/superpowers/plans/2026-04-17-dashboard-refactor.md`, lines ~1175-1178,
which mirror the same code). The plan file should be updated in lockstep so
the dashboard refactor doesn't regress this.

Suggested one-line change (full UUID variant):

```diff
-    const list = txns.map(t => `${t.payee_name} ${formatAmount(t.amount)} (${t.date})`).join(', ');
+    const list = txns.map(t => `${t.payee_name} ${formatAmount(t.amount)} (${t.date}) [id=${t.id}]`).join(', ');
```

And a matching finance-tab test update to assert the ID appears in the
rendered context string.
