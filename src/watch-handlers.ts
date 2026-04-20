/**
 * Watch / push-notification handlers for the YNAB MCP server.
 *
 * Exposes:
 *   - handleWatchBudget   (registers a webhook + thresholds)
 *   - handleUnwatchBudget (deregisters)
 *
 * Plus a singleton background poller (60s by default) that:
 *   1. Loads each watch.
 *   2. Fetches current month budget health via the same logic as handleBudgetHealth.
 *   3. Evaluates each threshold.
 *   4. On a cross (false → true), POSTs a webhook payload.
 *   5. Persists the updated snapshot so crosses survive restarts.
 *
 * Poller lifecycle:
 *   - Started on demand (first watch registered, or when pre-existing watches
 *     are loaded at MCP startup via `initializeWatchPoller`).
 *   - Stopped when the last watch is removed.
 *   - Stopped on process exit via registered SIGINT / SIGTERM / beforeExit hooks.
 */

import axios from 'axios';
import crypto from 'crypto';

import { YNABClient } from './api';
import { loadConfig } from './config';
import { currentMonthISO } from './format';
import {
  emptySnapshot,
  loadWatches,
  saveWatches,
  resolveStorePath,
  type Watch,
  type WatchSnapshot,
  type WatchThresholds,
} from './watch-store';

// ── tunables ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = Number(process.env['YNAB_WATCH_POLL_MS'] ?? 60_000);
const WEBHOOK_RETRY_DELAY_MS = 5_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

// ── types ────────────────────────────────────────────────────────────────────

export interface WatchBudgetArgs {
  webhook_url: string;
  budget_id?: string;
  thresholds: WatchThresholds;
}

export interface WatchBudgetResult {
  watch_id: string;
}

export interface UnwatchBudgetArgs {
  watch_id: string;
}

export interface UnwatchBudgetResult {
  ok: boolean;
  removed: boolean;
}

export type TriggerKind =
  | 'category_overspend_pct'
  | 'category_underspend_pct'
  | 'total_available_below';

/**
 * Webhook payload emitted to chief-ai (or any consumer).
 *
 * The `type` field stays `budget_update` for back-compat with older chief-ai
 * builds. New consumers look at the generic fields (`domain`, `source`,
 * `kind`, `spoken`) — they let a chief-ai-shaped system treat this as a
 * vendor-agnostic `provider_event` without the MCP knowing about that
 * contract.
 */
export interface WebhookEvent {
  type: 'budget_update';
  domain: 'finance';
  source: 'ynab';
  kind: TriggerKind;
  watch_id: string;
  timestamp: string;
  data:
    | {
        category: string;
        category_id: string;
        budgeted: number;
        activity: number;
        available: number;
        overspend_pct: number;
        trigger: 'category_overspend_pct';
      }
    | {
        category: string;
        category_id: string;
        budgeted: number;
        activity: number;
        available: number;
        underspend_pct: number;
        trigger: 'category_underspend_pct';
      }
    | {
        total_available: number;
        threshold: number;
        trigger: 'total_available_below';
      };
  /** Adapter-composed natural-language line; chief-ai prefers this over its
   *  domain-level fallback formatter. */
  spoken: string;
}

/** Natural-language line composed by this MCP. chief-ai uses it verbatim. */
function composeSpoken(data: WebhookEvent['data']): string {
  if (data.trigger === 'category_overspend_pct') {
    const dollars = Math.round(Math.abs(data.available) / 1000);
    return `${data.category} is ${data.overspend_pct}% over budget, $${dollars.toLocaleString()} in the red.`;
  }
  if (data.trigger === 'category_underspend_pct') {
    return `${data.category} is well under budget this month.`;
  }
  if (data.trigger === 'total_available_below') {
    const dollars = Math.round(data.total_available / 1000);
    return `Budget is running low — $${dollars.toLocaleString()} left across all categories.`;
  }
  return '';
}

/** Wrap a data payload into the full WebhookEvent envelope. */
function makeEvent(
  watch_id: string,
  timestamp: string,
  data: WebhookEvent['data']
): WebhookEvent {
  return {
    type: 'budget_update',
    domain: 'finance',
    source: 'ynab',
    kind: data.trigger,
    watch_id,
    timestamp,
    data,
    spoken: composeSpoken(data),
  };
}

// Minimal shape of a category coming from YNABClient.getBudgetMonth().categories.
// We only use the fields we care about — the real type has more.
export interface CategorySnapshotLike {
  id: string;
  name: string;
  deleted: boolean;
  hidden: boolean;
  budgeted: number; // milliunits
  activity: number; // milliunits (negative = spent)
  balance: number; // milliunits
}

export interface BudgetSnapshotLike {
  to_be_budgeted: number; // milliunits
  categories: CategorySnapshotLike[];
}

// ── pure evaluation helpers (unit-tested) ────────────────────────────────────

/**
 * Returns true iff a category is currently overspent by >= pct percent
 * relative to its budgeted amount.
 *   overspend_pct = max(0, (spent - budgeted) / budgeted) * 100
 * Only meaningful when budgeted > 0.
 */
export function evaluateOverspend(
  cat: CategorySnapshotLike,
  pct: number
): { met: boolean; overspendPct: number } {
  if (cat.budgeted <= 0) return { met: false, overspendPct: 0 };
  const spent = Math.abs(cat.activity);
  const overspendPct = ((spent - cat.budgeted) / cat.budgeted) * 100;
  return { met: overspendPct >= pct, overspendPct: Math.round(overspendPct) };
}

/**
 * Returns true iff a category currently has >= pct percent of its budgeted
 * amount still available (i.e. has been used less than (100 - pct)% so far).
 * Only meaningful when budgeted > 0. Intended for end-of-month / idle-money
 * signalling, not partial-month "ahead of pace" detection.
 */
export function evaluateUnderspend(
  cat: CategorySnapshotLike,
  pct: number
): { met: boolean; underspendPct: number } {
  if (cat.budgeted <= 0) return { met: false, underspendPct: 0 };
  const available = cat.balance;
  const underspendPct = (available / cat.budgeted) * 100;
  return { met: underspendPct >= pct, underspendPct: Math.round(underspendPct) };
}

/**
 * Converts a threshold-cross ("was false, now true") into 0..N webhook events
 * for a single watch, and returns the updated snapshot. Pure — no I/O.
 */
export function evaluateWatch(
  watch: Watch,
  budget: BudgetSnapshotLike,
  now: Date = new Date()
): { events: WebhookEvent[]; nextSnapshot: WatchSnapshot } {
  const prev = watch.snapshot ?? emptySnapshot();
  const next: WatchSnapshot = {
    category_overspend: {},
    category_underspend: {},
    total_available_below: false,
    lastPolledAt: now.toISOString(),
  };
  const events: WebhookEvent[] = [];

  const activeCats = budget.categories.filter((c) => !c.deleted && !c.hidden);

  // ── category_overspend_pct ─────────────────────────────────────────────────
  if (watch.thresholds.category_overspend_pct !== undefined) {
    const pct = watch.thresholds.category_overspend_pct;
    for (const cat of activeCats) {
      const { met, overspendPct } = evaluateOverspend(cat, pct);
      next.category_overspend[cat.id] = met;
      const wasMet = prev.category_overspend[cat.id] === true;
      if (met && !wasMet) {
        events.push(makeEvent(watch.id, now.toISOString(), {
          category: cat.name,
          category_id: cat.id,
          budgeted: cat.budgeted,
          activity: cat.activity,
          available: cat.balance,
          overspend_pct: overspendPct,
          trigger: 'category_overspend_pct',
        }));
      }
    }
  }

  // ── category_underspend_pct ────────────────────────────────────────────────
  if (watch.thresholds.category_underspend_pct !== undefined) {
    const pct = watch.thresholds.category_underspend_pct;
    for (const cat of activeCats) {
      const { met, underspendPct } = evaluateUnderspend(cat, pct);
      next.category_underspend[cat.id] = met;
      const wasMet = prev.category_underspend[cat.id] === true;
      if (met && !wasMet) {
        events.push(makeEvent(watch.id, now.toISOString(), {
          category: cat.name,
          category_id: cat.id,
          budgeted: cat.budgeted,
          activity: cat.activity,
          available: cat.balance,
          underspend_pct: underspendPct,
          trigger: 'category_underspend_pct',
        }));
      }
    }
  }

  // ── total_available_below ──────────────────────────────────────────────────
  if (watch.thresholds.total_available_below !== undefined) {
    // threshold is in DOLLARS per the public API. Convert to milliunits for
    // comparison with YNAB values.
    const thresholdMilliunits = Math.round(watch.thresholds.total_available_below * 1000);
    const met = budget.to_be_budgeted < thresholdMilliunits;
    next.total_available_below = met;
    const wasMet = prev.total_available_below === true;
    if (met && !wasMet) {
      events.push(makeEvent(watch.id, now.toISOString(), {
        total_available: budget.to_be_budgeted,
        threshold: thresholdMilliunits,
        trigger: 'total_available_below',
      }));
    }
  }

  return { events, nextSnapshot: next };
}

// ── webhook delivery ─────────────────────────────────────────────────────────

/**
 * POST a webhook event with one retry on failure (5s delay), then drop.
 * Logs to stderr so we don't corrupt the MCP stdio protocol.
 */
export async function deliverWebhook(
  url: string,
  event: WebhookEvent,
  // injectable for tests
  poster: (u: string, body: WebhookEvent) => Promise<void> = defaultPost,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<{ delivered: boolean }> {
  try {
    await poster(url, event);
    return { delivered: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[ynab-watch] webhook POST failed for ${url} (watch=${event.watch_id}): ${msg} — retrying in ${WEBHOOK_RETRY_DELAY_MS}ms\n`
    );
    await sleep(WEBHOOK_RETRY_DELAY_MS);
    try {
      await poster(url, event);
      return { delivered: true };
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      process.stderr.write(
        `[ynab-watch] webhook POST retry failed for ${url} (watch=${event.watch_id}): ${msg2} — dropping (TODO: persistent retry)\n`
      );
      return { delivered: false };
    }
  }
}

async function defaultPost(url: string, body: WebhookEvent): Promise<void> {
  await axios.post(url, body, { timeout: WEBHOOK_TIMEOUT_MS });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── poller state (module-local singleton) ────────────────────────────────────

interface PollerState {
  interval: NodeJS.Timeout | null;
  ticking: boolean; // re-entrancy guard
  exitHooksBound: boolean;
  clientFactory: () => YNABClient;
}

const state: PollerState = {
  interval: null,
  ticking: false,
  exitHooksBound: false,
  clientFactory: () => new YNABClient(loadConfig().token),
};

/** For tests: swap how we build the YNAB client. */
export function __setClientFactoryForTests(factory: () => YNABClient): void {
  state.clientFactory = factory;
}

/** For tests: reset internal state. */
export function __resetPollerForTests(): void {
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
  state.ticking = false;
}

/** Exposed for tests + the MCP server bootstrap. */
export function isPollerRunning(): boolean {
  return state.interval !== null;
}

function ensureExitHooksBound(): void {
  if (state.exitHooksBound) return;
  state.exitHooksBound = true;
  const stop = (): void => {
    stopPoller();
  };
  process.on('beforeExit', stop);
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });
}

export function startPollerIfNeeded(): void {
  if (state.interval) return;
  ensureExitHooksBound();
  state.interval = setInterval(() => {
    void pollTick();
  }, POLL_INTERVAL_MS);
  // Allow the process to exit naturally even if the timer is still scheduled.
  if (typeof state.interval.unref === 'function') state.interval.unref();
}

export function stopPoller(): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
}

/**
 * One poller tick. Exported so tests can invoke deterministically.
 */
export async function pollTick(): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const storePath = resolveStorePath();
    const watches = loadWatches(storePath);
    if (watches.length === 0) {
      stopPoller();
      return;
    }

    let client: YNABClient;
    try {
      client = state.clientFactory();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ynab-watch] cannot construct YNAB client: ${msg}\n`);
      return;
    }

    // Group watches by budget so we only fetch each budget once per tick.
    const byBudget = new Map<string, Watch[]>();
    for (const w of watches) {
      const list = byBudget.get(w.budgetId);
      if (list) list.push(w);
      else byBudget.set(w.budgetId, [w]);
    }

    const month = currentMonthISO();
    const updated: Watch[] = [];

    for (const [budgetId, budgetWatches] of byBudget.entries()) {
      let budget: BudgetSnapshotLike;
      try {
        budget = await client.getBudgetMonth(budgetId, month);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[ynab-watch] failed to fetch budget month for ${budgetId}: ${msg}\n`
        );
        // Keep existing watches untouched so we retry next tick.
        updated.push(...budgetWatches);
        continue;
      }

      for (const w of budgetWatches) {
        const { events, nextSnapshot } = evaluateWatch(w, budget);
        updated.push({ ...w, snapshot: nextSnapshot });
        for (const ev of events) {
          // Fire-and-forget with retry; do not block the tick on it.
          void deliverWebhook(w.webhookUrl, ev);
        }
      }
    }

    saveWatches(updated, storePath);
  } finally {
    state.ticking = false;
  }
}

/** Call once at MCP server boot so any pre-existing watches resume polling. */
export function initializeWatchPoller(): void {
  const watches = loadWatches();
  if (watches.length > 0) startPollerIfNeeded();
}

// ── MCP tool handlers ────────────────────────────────────────────────────────

export function handleWatchBudget(
  _client: YNABClient,
  defaultBudgetId: string,
  _budgetName: string,
  args: WatchBudgetArgs
): WatchBudgetResult {
  if (!args.webhook_url || typeof args.webhook_url !== 'string') {
    throw new Error('webhook_url is required.');
  }
  if (!args.thresholds || typeof args.thresholds !== 'object') {
    throw new Error('thresholds object is required.');
  }
  const hasAny =
    args.thresholds.category_overspend_pct !== undefined ||
    args.thresholds.category_underspend_pct !== undefined ||
    args.thresholds.total_available_below !== undefined;
  if (!hasAny) {
    throw new Error(
      'At least one threshold (category_overspend_pct, category_underspend_pct, total_available_below) is required.'
    );
  }

  const storePath = resolveStorePath();
  const watches = loadWatches(storePath);
  const watch: Watch = {
    id: crypto.randomUUID(),
    webhookUrl: args.webhook_url,
    budgetId: args.budget_id ?? defaultBudgetId,
    thresholds: args.thresholds,
    createdAt: new Date().toISOString(),
    snapshot: emptySnapshot(),
  };
  watches.push(watch);
  saveWatches(watches, storePath);

  startPollerIfNeeded();

  return { watch_id: watch.id };
}

export function handleUnwatchBudget(
  _client: YNABClient,
  _budgetId: string,
  _budgetName: string,
  args: UnwatchBudgetArgs
): UnwatchBudgetResult {
  if (!args.watch_id) throw new Error('watch_id is required.');

  const storePath = resolveStorePath();
  const before = loadWatches(storePath);
  const after = before.filter((w) => w.id !== args.watch_id);
  const removed = after.length < before.length;
  saveWatches(after, storePath);

  if (after.length === 0) stopPoller();

  return { ok: true, removed };
}
