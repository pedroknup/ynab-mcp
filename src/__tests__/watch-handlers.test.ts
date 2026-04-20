import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Block real HTTP calls from any webhook delivery that sneaks through a test.
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn(async () => ({ status: 200, data: {} })) },
}));

import {
  evaluateOverspend,
  evaluateUnderspend,
  evaluateWatch,
  deliverWebhook,
  handleWatchBudget,
  handleUnwatchBudget,
  __resetPollerForTests,
  isPollerRunning,
  pollTick,
  __setClientFactoryForTests,
  type CategorySnapshotLike,
  type BudgetSnapshotLike,
  type WebhookEvent,
} from '../watch-handlers';
import {
  emptySnapshot,
  loadWatches,
  saveWatches,
  type Watch,
} from '../watch-store';
import type { YNABClient } from '../api';

// ── tmp store helpers ────────────────────────────────────────────────────────

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynab-watch-test-'));
  storePath = path.join(tmpDir, 'watches.json');
  process.env['YNAB_WATCH_STORE'] = storePath;
  __resetPollerForTests();
});

afterEach(() => {
  delete process.env['YNAB_WATCH_STORE'];
  __resetPollerForTests();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── fixture helpers ──────────────────────────────────────────────────────────

function makeCat(overrides: Partial<CategorySnapshotLike> = {}): CategorySnapshotLike {
  return {
    id: 'cat-1',
    name: 'Groceries',
    deleted: false,
    hidden: false,
    budgeted: 600_000,   // $600
    activity: -420_000,  // -$420 spent
    balance: 180_000,    // $180 left
    ...overrides,
  };
}

function makeWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: 'w-1',
    webhookUrl: 'http://example.test/hook',
    budgetId: 'budget-1',
    thresholds: {},
    createdAt: '2024-01-01T00:00:00.000Z',
    snapshot: emptySnapshot(),
    ...overrides,
  };
}

function makeBudget(cats: CategorySnapshotLike[], to_be_budgeted = 50_000_000): BudgetSnapshotLike {
  return { categories: cats, to_be_budgeted };
}

// ── pure evaluation tests ────────────────────────────────────────────────────

describe('evaluateOverspend', () => {
  it('returns met=false and 0 when not budgeted', () => {
    const r = evaluateOverspend(makeCat({ budgeted: 0, activity: -50_000 }), 10);
    expect(r.met).toBe(false);
    expect(r.overspendPct).toBe(0);
  });

  it('returns met=false when within budget', () => {
    const r = evaluateOverspend(makeCat({ budgeted: 600_000, activity: -500_000 }), 10);
    expect(r.met).toBe(false);
  });

  it('fires at exactly the threshold percentage', () => {
    const r = evaluateOverspend(makeCat({ budgeted: 600_000, activity: -720_000 }), 20);
    expect(r.met).toBe(true);
    expect(r.overspendPct).toBe(20);
  });

  it('does not fire at 19% over when threshold is 20%', () => {
    const r = evaluateOverspend(makeCat({ budgeted: 1_000_000, activity: -1_190_000 }), 20);
    expect(r.met).toBe(false);
  });
});

describe('evaluateUnderspend', () => {
  it('fires when a category has >= pct% of its budget still available', () => {
    const r = evaluateUnderspend(makeCat({ budgeted: 600_000, balance: 420_000 }), 50);
    expect(r.met).toBe(true); // 70% left
  });

  it('does not fire when the category has less than pct% remaining', () => {
    const r = evaluateUnderspend(makeCat({ budgeted: 600_000, balance: 120_000 }), 50);
    expect(r.met).toBe(false); // 20% left
  });

  it('is inert for un-budgeted categories', () => {
    const r = evaluateUnderspend(makeCat({ budgeted: 0, balance: 0 }), 50);
    expect(r.met).toBe(false);
  });
});

// ── threshold-cross logic ────────────────────────────────────────────────────

describe('evaluateWatch — threshold crossing', () => {
  it('fires exactly once when a category transitions from ok → overspent', () => {
    const watch = makeWatch({ thresholds: { category_overspend_pct: 20 } });
    const budget = makeBudget([makeCat({ budgeted: 600_000, activity: -720_000, balance: -120_000 })]);
    const first = evaluateWatch(watch, budget);
    expect(first.events.length).toBe(1);
    expect(first.events[0].data.trigger).toBe('category_overspend_pct');

    // feed the new snapshot back in — no fire this time
    const stillOverspent = evaluateWatch(
      { ...watch, snapshot: first.nextSnapshot },
      budget
    );
    expect(stillOverspent.events.length).toBe(0);
  });

  it('re-fires after crossing back under and then over again', () => {
    const watch = makeWatch({ thresholds: { category_overspend_pct: 20 } });
    const overspent = makeBudget([makeCat({ budgeted: 600_000, activity: -720_000, balance: -120_000 })]);
    const recovered = makeBudget([makeCat({ budgeted: 600_000, activity: -500_000, balance: 100_000 })]);

    const a = evaluateWatch(watch, overspent);
    expect(a.events.length).toBe(1);

    const b = evaluateWatch({ ...watch, snapshot: a.nextSnapshot }, recovered);
    expect(b.events.length).toBe(0);
    expect(b.nextSnapshot.category_overspend['cat-1']).toBe(false);

    const c = evaluateWatch({ ...watch, snapshot: b.nextSnapshot }, overspent);
    expect(c.events.length).toBe(1);
  });

  it('tracks per-category state independently', () => {
    const watch = makeWatch({ thresholds: { category_overspend_pct: 20 } });
    const budget = makeBudget([
      makeCat({ id: 'cat-a', name: 'Groceries',  budgeted: 600_000, activity: -720_000, balance: -120_000 }),
      makeCat({ id: 'cat-b', name: 'Dining Out', budgeted: 300_000, activity: -200_000, balance:  100_000 }),
    ]);
    const first = evaluateWatch(watch, budget);
    expect(first.events.length).toBe(1);
    expect(first.events[0].data).toMatchObject({ category_id: 'cat-a' });
    expect(first.nextSnapshot.category_overspend).toEqual({ 'cat-a': true, 'cat-b': false });
  });

  it('fires total_available_below on cross', () => {
    const watch = makeWatch({ thresholds: { total_available_below: 100 } });
    const belowBudget = makeBudget([], 50_000); // $50 to-be-budgeted, threshold $100
    const first = evaluateWatch(watch, belowBudget);
    expect(first.events.length).toBe(1);
    expect(first.events[0].data).toMatchObject({
      trigger: 'total_available_below',
      total_available: 50_000,
      threshold: 100_000,
    });

    // Does not re-fire while still below
    const still = evaluateWatch({ ...watch, snapshot: first.nextSnapshot }, belowBudget);
    expect(still.events.length).toBe(0);
  });

  it('ignores deleted and hidden categories', () => {
    const watch = makeWatch({ thresholds: { category_overspend_pct: 20 } });
    const budget = makeBudget([
      makeCat({ id: 'cat-a', deleted: true,  budgeted: 600_000, activity: -720_000, balance: -120_000 }),
      makeCat({ id: 'cat-b', hidden:  true,  budgeted: 600_000, activity: -720_000, balance: -120_000 }),
    ]);
    const r = evaluateWatch(watch, budget);
    expect(r.events.length).toBe(0);
  });

  it('emits the documented payload shape', () => {
    const watch = makeWatch({ id: 'w-xyz', thresholds: { category_overspend_pct: 20 } });
    const budget = makeBudget([makeCat({ id: 'cat-g', name: 'Groceries', budgeted: 600_000, activity: -720_000, balance: -120_000 })]);
    const { events } = evaluateWatch(watch, budget, new Date('2026-04-17T14:32:00Z'));
    expect(events[0]).toEqual({
      type: 'budget_update',
      domain: 'finance',
      source: 'ynab',
      kind: 'category_overspend_pct',
      watch_id: 'w-xyz',
      timestamp: '2026-04-17T14:32:00.000Z',
      data: {
        category: 'Groceries',
        category_id: 'cat-g',
        budgeted: 600_000,
        activity: -720_000,
        available: -120_000,
        overspend_pct: 20,
        trigger: 'category_overspend_pct',
      },
      spoken: 'Groceries is 20% over budget, $120 in the red.',
    });
  });
});

// ── webhook delivery retry ───────────────────────────────────────────────────

describe('deliverWebhook retry', () => {
  const event: WebhookEvent = {
    type: 'budget_update',
    domain: 'finance',
    source: 'ynab',
    kind: 'category_overspend_pct',
    watch_id: 'w-1',
    timestamp: '2026-04-17T14:32:00.000Z',
    data: {
      category: 'Groceries', category_id: 'cat-1',
      budgeted: 600_000, activity: -720_000, available: -120_000,
      overspend_pct: 20, trigger: 'category_overspend_pct',
    },
    spoken: 'Groceries is 20% over budget, $120 in the red.',
  };

  it('does not retry on success', async () => {
    const poster = jest.fn(async () => undefined) as any;
    const sleep = jest.fn(async () => undefined) as any;
    const r = await deliverWebhook('http://x', event, poster, sleep);
    expect(r.delivered).toBe(true);
    expect(poster).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries once after 5s on failure', async () => {
    const poster = ((jest.fn() as any)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined)) as any;
    const sleep = jest.fn(async () => undefined) as any;
    const r = await deliverWebhook('http://x', event, poster, sleep);
    expect(r.delivered).toBe(true);
    expect(poster).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('gives up and returns delivered=false after second failure', async () => {
    const poster = jest.fn(async () => { throw new Error('still down'); }) as any;
    const sleep = jest.fn(async () => undefined) as any;
    const r = await deliverWebhook('http://x', event, poster, sleep);
    expect(r.delivered).toBe(false);
    expect(poster).toHaveBeenCalledTimes(2);
  });
});

// ── handleWatchBudget / handleUnwatchBudget ──────────────────────────────────

function makeMockClient(overrides: Record<string, unknown> = {}): YNABClient {
  return {
    getBudgets: jest.fn(),
    getCategories: jest.fn(),
    getTransactions: jest.fn(),
    getAccounts: jest.fn(),
    getBudgetMonth: jest.fn(),
    updateTransaction: jest.fn(),
    getScheduledTransactions: jest.fn(),
    getPayees: jest.fn(),
    updatePayee: jest.fn(),
    getTransactionsByPayee: jest.fn(),
    getTransactionsByCategory: jest.fn(),
    updateCategoryMonth: jest.fn(),
    importTransactions: jest.fn(),
    createTransaction: jest.fn(),
    deleteTransaction: jest.fn(),
    ...overrides,
  } as unknown as YNABClient;
}

describe('handleWatchBudget', () => {
  it('persists a new watch and returns an id', () => {
    const client = makeMockClient();
    const r = handleWatchBudget(client, 'budget-1', 'Test', {
      webhook_url: 'http://x',
      thresholds: { category_overspend_pct: 20 },
    });
    expect(typeof r.watch_id).toBe('string');
    const saved = loadWatches(storePath);
    expect(saved.length).toBe(1);
    expect(saved[0].id).toBe(r.watch_id);
    expect(saved[0].budgetId).toBe('budget-1');
  });

  it('respects a supplied budget_id', () => {
    const client = makeMockClient();
    handleWatchBudget(client, 'budget-default', 'Test', {
      webhook_url: 'http://x',
      budget_id: 'budget-override',
      thresholds: { category_overspend_pct: 20 },
    });
    expect(loadWatches(storePath)[0].budgetId).toBe('budget-override');
  });

  it('starts the poller', () => {
    const client = makeMockClient();
    handleWatchBudget(client, 'budget-1', 'Test', {
      webhook_url: 'http://x',
      thresholds: { category_overspend_pct: 20 },
    });
    expect(isPollerRunning()).toBe(true);
  });

  it('rejects when no thresholds are given', () => {
    const client = makeMockClient();
    expect(() => handleWatchBudget(client, 'budget-1', 'Test', {
      webhook_url: 'http://x',
      thresholds: {},
    })).toThrow(/At least one threshold/);
  });

  it('rejects when webhook_url is missing', () => {
    const client = makeMockClient();
    expect(() => handleWatchBudget(client, 'budget-1', 'Test', {
      webhook_url: '',
      thresholds: { category_overspend_pct: 20 },
    })).toThrow(/webhook_url/);
  });
});

describe('handleUnwatchBudget', () => {
  it('removes the watch and stops the poller when it was the last one', () => {
    const client = makeMockClient();
    const { watch_id } = handleWatchBudget(client, 'budget-1', 'Test', {
      webhook_url: 'http://x',
      thresholds: { category_overspend_pct: 20 },
    });
    expect(isPollerRunning()).toBe(true);

    const r = handleUnwatchBudget(client, 'budget-1', 'Test', { watch_id });
    expect(r).toEqual({ ok: true, removed: true });
    expect(loadWatches(storePath)).toEqual([]);
    expect(isPollerRunning()).toBe(false);
  });

  it('leaves the poller running when other watches remain', () => {
    const client = makeMockClient();
    const a = handleWatchBudget(client, 'budget-1', 'Test', {
      webhook_url: 'http://x', thresholds: { category_overspend_pct: 20 },
    });
    handleWatchBudget(client, 'budget-1', 'Test', {
      webhook_url: 'http://y', thresholds: { category_overspend_pct: 20 },
    });
    handleUnwatchBudget(client, 'budget-1', 'Test', { watch_id: a.watch_id });
    expect(isPollerRunning()).toBe(true);
    expect(loadWatches(storePath).length).toBe(1);
  });

  it('returns removed=false when the id is unknown', () => {
    const client = makeMockClient();
    const r = handleUnwatchBudget(client, 'budget-1', 'Test', { watch_id: 'not-a-real-id' });
    expect(r.removed).toBe(false);
  });
});

// ── pollTick integration ─────────────────────────────────────────────────────

describe('pollTick', () => {
  it('no-ops and stops the poller when no watches exist', async () => {
    saveWatches([], storePath);
    __setClientFactoryForTests(() => makeMockClient({
      getBudgetMonth: jest.fn(),
    }));
    // Start manually so we can observe it being stopped
    handleUnwatchBudget(makeMockClient(), 'b', 'T', { watch_id: 'nope' });
    await pollTick();
    expect(isPollerRunning()).toBe(false);
  });

  it('fetches the budget once per budgetId and persists the snapshot', async () => {
    const getBudgetMonth = (jest.fn() as any).mockResolvedValue({
      to_be_budgeted: 50_000_000,
      categories: [makeCat({ budgeted: 600_000, activity: -720_000, balance: -120_000 })],
    });
    __setClientFactoryForTests(() => makeMockClient({ getBudgetMonth }) );

    saveWatches([makeWatch({
      id: 'w-1', budgetId: 'budget-A',
      thresholds: { category_overspend_pct: 20 },
    }), makeWatch({
      id: 'w-2', budgetId: 'budget-A',
      thresholds: { category_overspend_pct: 20 },
    })], storePath);

    await pollTick();

    // Only one fetch for the single distinct budgetId
    expect(getBudgetMonth).toHaveBeenCalledTimes(1);

    const saved = loadWatches(storePath);
    expect(saved.map((w) => w.id).sort()).toEqual(['w-1', 'w-2']);
    expect(saved[0].snapshot.category_overspend['cat-1']).toBe(true);
    expect(saved[0].snapshot.lastPolledAt).not.toBeNull();
  });

  it('keeps existing snapshot untouched when the API call fails', async () => {
    const existing = makeWatch({
      id: 'w-1', budgetId: 'budget-A',
      thresholds: { category_overspend_pct: 20 },
      snapshot: {
        category_overspend: { 'cat-prev': true },
        category_underspend: {},
        total_available_below: false,
        lastPolledAt: '2020-01-01T00:00:00.000Z',
      },
    });
    saveWatches([existing], storePath);

    __setClientFactoryForTests(() => makeMockClient({
      getBudgetMonth: (jest.fn() as any).mockRejectedValue(new Error('503')),
    }));

    await pollTick();

    const saved = loadWatches(storePath);
    expect(saved[0].snapshot.category_overspend['cat-prev']).toBe(true);
    expect(saved[0].snapshot.lastPolledAt).toBe('2020-01-01T00:00:00.000Z');
  });
});
