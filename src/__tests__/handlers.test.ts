import { jest } from '@jest/globals';

// ── mock config before importing handlers ─────────────────────────────────────

jest.mock('../config', () => ({
  loadCategoryCache: jest.fn(),
  saveCategoryCache: jest.fn(),
  loadConfig: jest.fn(() => ({ token: 'test-token', budgetId: 'budget-1', budgetName: 'Test Budget' })),
}));

import { loadCategoryCache, saveCategoryCache } from '../config';
import type { CategoryCache, Transaction, ScheduledTransaction, Account, Payee } from '../types';
import type { YNABClient } from '../api';
import {
  handleSetBudget,
  handleListScheduled,
  handleSearchTransactions,
  handleSyncCategories,
  handleApproveAll,
  handleCreateTransaction,
  handleListUnapproved,
  handleListPayees,
  handleApprove,
  handleDeleteTransaction,
  handleListApproved,
} from '../handlers';

// ── mock client factory ───────────────────────────────────────────────────────

function makeMockClient(overrides: Record<string, unknown> = {}): YNABClient {
  return {
    getBudgets:                jest.fn(),
    getCategories:             jest.fn(),
    getTransactions:           jest.fn(),
    getAccounts:               jest.fn(),
    getBudgetMonth:            jest.fn(),
    updateTransaction:         jest.fn(),
    getScheduledTransactions:  jest.fn(),
    getPayees:                 jest.fn(),
    updatePayee:               jest.fn(),
    getTransactionsByPayee:    jest.fn(),
    getTransactionsByCategory: jest.fn(),
    updateCategoryMonth:       jest.fn(),
    importTransactions:        jest.fn(),
    createTransaction:         jest.fn(),
    deleteTransaction:         jest.fn(),
    ...overrides,
  } as unknown as YNABClient;
}

const BID = 'budget-1';
const BNAME = 'Test Budget';

// ── fixture helpers ───────────────────────────────────────────────────────────

function makeTxn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'txn-1', date: '2024-01-15', amount: -10000,
    memo: null, cleared: 'cleared', approved: false,
    flag_color: null, account_id: 'acc-1', account_name: 'Checking',
    payee_id: 'pay-1', payee_name: 'Amazon', category_id: 'cat-1',
    category_name: 'Shopping', transfer_account_id: null,
    transfer_transaction_id: null, matched_transaction_id: null,
    import_id: null, import_payee_name: null, import_payee_name_original: null,
    debt_transaction_type: null, deleted: false, subtransactions: [],
    ...overrides,
  };
}

function makeScheduled(overrides: Partial<ScheduledTransaction> = {}): ScheduledTransaction {
  return {
    id: 'sch-1', date_first: '2024-01-01', date_next: '2024-01-20',
    frequency: 'monthly', amount: -15000,
    memo: null, flag_color: null,
    account_id: 'acc-1', account_name: 'Checking',
    payee_id: 'pay-1', payee_name: 'Netflix',
    category_id: 'cat-3', category_name: 'Entertainment',
    transfer_account_id: null, deleted: false,
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1', name: 'Checking', type: 'checking', on_budget: true,
    closed: false, balance: 100000, cleared_balance: 100000,
    uncleared_balance: 0, deleted: false,
    ...overrides,
  };
}

function makePayee(overrides: Partial<Payee> = {}): Payee {
  return { id: 'pay-1', name: 'Amazon', transfer_account_id: null, deleted: false, ...overrides };
}

function makeCache(overrides: Partial<CategoryCache> = {}): CategoryCache {
  return {
    budgetId: BID,
    lastSynced: '2024-01-01T00:00:00.000Z',
    serverKnowledge: 10,
    groups: [],
    flat: [
      { id: 'cat-1', name: 'Groceries',  groupName: 'Food',          groupId: 'g-1', hidden: false, deleted: false },
      { id: 'cat-2', name: 'Dining Out', groupName: 'Food',          groupId: 'g-1', hidden: false, deleted: false },
      { id: 'cat-3', name: 'Netflix',    groupName: 'Entertainment', groupId: 'g-2', hidden: false, deleted: false },
    ],
    ...overrides,
  };
}

// ── handleSetBudget ───────────────────────────────────────────────────────────

describe('handleSetBudget', () => {
  beforeEach(() => {
    (loadCategoryCache as jest.Mock).mockReturnValue(makeCache());
  });

  it('converts dollars to milliunits before calling the API', async () => {
    const client = makeMockClient({
      updateCategoryMonth: (jest.fn() as any).mockResolvedValue({
        id: 'cat-1', name: 'Groceries', budgeted: 150000, balance: 150000,
        category_group_id: 'g-1', hidden: false, note: null,
        activity: 0, goal_type: null, goal_target: null, deleted: false,
      }),
    });

    await handleSetBudget(client, BID, BNAME, { category: 'Groceries', amount: 150 });
    expect(client.updateCategoryMonth).toHaveBeenCalledWith(BID, expect.any(String), 'cat-1', 150000);
  });

  it('converts fractional dollar amounts correctly', async () => {
    const client = makeMockClient({
      updateCategoryMonth: (jest.fn() as any).mockResolvedValue({
        id: 'cat-1', name: 'Groceries', budgeted: 12500, balance: 12500,
        category_group_id: 'g-1', hidden: false, note: null,
        activity: 0, goal_type: null, goal_target: null, deleted: false,
      }),
    });

    await handleSetBudget(client, BID, BNAME, { category: 'cat-1', amount: 12.50 });
    expect(client.updateCategoryMonth).toHaveBeenCalledWith(BID, expect.any(String), 'cat-1', 12500);
  });

  it('uses the provided month', async () => {
    const client = makeMockClient({
      updateCategoryMonth: (jest.fn() as any).mockResolvedValue({
        id: 'cat-1', name: 'Groceries', budgeted: 50000, balance: 50000,
        category_group_id: 'g-1', hidden: false, note: null,
        activity: 0, goal_type: null, goal_target: null, deleted: false,
      }),
    });

    await handleSetBudget(client, BID, BNAME, { category: 'cat-1', amount: 50, month: '2024-03-01' });
    expect(client.updateCategoryMonth).toHaveBeenCalledWith(BID, '2024-03-01', 'cat-1', 50000);
  });

  it('returns formatted budgeted amount', async () => {
    const client = makeMockClient({
      updateCategoryMonth: (jest.fn() as any).mockResolvedValue({
        id: 'cat-1', name: 'Groceries', budgeted: 150000, balance: 150000,
        category_group_id: 'g-1', hidden: false, note: null,
        activity: 0, goal_type: null, goal_target: null, deleted: false,
      }),
    });

    const result = await handleSetBudget(client, BID, BNAME, { category: 'cat-1', amount: 150 });
    expect(result.budgeted_formatted).toBe('$150.00');
    expect(result.ok).toBe(true);
  });

  it('throws when category is not found', async () => {
    const client = makeMockClient();
    await expect(
      handleSetBudget(client, BID, BNAME, { category: 'NoSuchCategory', amount: 100 })
    ).rejects.toThrow('No category found');
  });
});

// ── handleListScheduled ───────────────────────────────────────────────────────

describe('handleListScheduled', () => {
  afterEach(() => jest.useRealTimers());

  it('filters to only transactions within the default 30-day window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-10T12:00:00Z'));

    const client = makeMockClient({
      getScheduledTransactions: (jest.fn() as any).mockResolvedValue([
        makeScheduled({ id: 'sch-1', date_next: '2024-01-15' }), // within 30 days ✓
        makeScheduled({ id: 'sch-2', date_next: '2024-02-20' }), // outside 30-day cutoff ✗
      ]),
    });

    const result = await handleListScheduled(client, BID, BNAME, {});
    expect(result.count).toBe(1);
    expect(result.scheduled[0].id).toBe('sch-1');
  });

  it('respects a custom days_ahead value', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-10T12:00:00Z'));

    const client = makeMockClient({
      getScheduledTransactions: (jest.fn() as any).mockResolvedValue([
        makeScheduled({ id: 'sch-1', date_next: '2024-01-15' }), // within 7 days ✓
        makeScheduled({ id: 'sch-2', date_next: '2024-01-25' }), // outside 7 days ✗
      ]),
    });

    const result = await handleListScheduled(client, BID, BNAME, { days_ahead: 7 });
    expect(result.count).toBe(1);
  });

  it('sorts results by date_next ascending', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const client = makeMockClient({
      getScheduledTransactions: (jest.fn() as any).mockResolvedValue([
        makeScheduled({ id: 'sch-2', date_next: '2024-01-20' }),
        makeScheduled({ id: 'sch-1', date_next: '2024-01-10' }),
      ]),
    });

    const result = await handleListScheduled(client, BID, BNAME, {});
    expect(result.scheduled[0].id).toBe('sch-1');
    expect(result.scheduled[1].id).toBe('sch-2');
  });

  it('excludes deleted transactions', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const client = makeMockClient({
      getScheduledTransactions: (jest.fn() as any).mockResolvedValue([
        makeScheduled({ id: 'sch-1', date_next: '2024-01-15', deleted: true }),
        makeScheduled({ id: 'sch-2', date_next: '2024-01-20' }),
      ]),
    });

    const result = await handleListScheduled(client, BID, BNAME, {});
    expect(result.count).toBe(1);
    expect(result.scheduled[0].id).toBe('sch-2');
  });

  it('totals only outflow non-transfer transactions', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const client = makeMockClient({
      getScheduledTransactions: (jest.fn() as any).mockResolvedValue([
        makeScheduled({ id: 'sch-1', date_next: '2024-01-15', amount: -20000 }),                           // outflow ✓
        makeScheduled({ id: 'sch-2', date_next: '2024-01-16', amount:  10000 }),                           // inflow — excluded
        makeScheduled({ id: 'sch-3', date_next: '2024-01-17', amount: -5000, transfer_account_id: 'x' }), // transfer — excluded
      ]),
    });

    const result = await handleListScheduled(client, BID, BNAME, {});
    expect(result.total_outflow).toBe(-20000);
  });

  it('marks transfers correctly in the is_transfer flag', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const client = makeMockClient({
      getScheduledTransactions: (jest.fn() as any).mockResolvedValue([
        makeScheduled({ id: 'sch-1', date_next: '2024-01-15', transfer_account_id: 'acc-2' }),
      ]),
    });

    const result = await handleListScheduled(client, BID, BNAME, {});
    expect(result.scheduled[0].is_transfer).toBe(true);
  });
});

// ── handleSearchTransactions ──────────────────────────────────────────────────

describe('handleSearchTransactions', () => {
  it('throws when no search criteria provided', async () => {
    const client = makeMockClient();
    await expect(
      handleSearchTransactions(client, BID, BNAME, {})
    ).rejects.toThrow('Provide at least one of');
  });

  it('searches by payee_id directly without fetching payees', async () => {
    const client = makeMockClient({
      getTransactionsByPayee: (jest.fn() as any).mockResolvedValue([makeTxn()]),
    });

    const result = await handleSearchTransactions(client, BID, BNAME, { payee_id: 'pay-1' });
    expect(client.getTransactionsByPayee).toHaveBeenCalledWith(BID, 'pay-1', expect.any(String));
    expect(client.getPayees).not.toHaveBeenCalled();
    expect(result.count).toBe(1);
  });

  it('resolves payee by name (partial match)', async () => {
    const client = makeMockClient({
      getPayees: (jest.fn() as any).mockResolvedValue([
        makePayee({ id: 'pay-amzn', name: 'Amazon' }),
      ]),
      getTransactionsByPayee: (jest.fn() as any).mockResolvedValue([makeTxn()]),
    });

    await handleSearchTransactions(client, BID, BNAME, { payee_name: 'amaz' });
    expect(client.getTransactionsByPayee).toHaveBeenCalledWith(BID, 'pay-amzn', expect.any(String));
  });

  it('throws when payee name matches multiple payees', async () => {
    const client = makeMockClient({
      getPayees: (jest.fn() as any).mockResolvedValue([
        makePayee({ id: 'p1', name: 'Amazon Fresh' }),
        makePayee({ id: 'p2', name: 'Amazon Prime' }),
      ]),
    });

    await expect(
      handleSearchTransactions(client, BID, BNAME, { payee_name: 'amazon' })
    ).rejects.toThrow();
  });

  it('searches by category_id directly without fetching categories', async () => {
    const client = makeMockClient({
      getTransactionsByCategory: (jest.fn() as any).mockResolvedValue([makeTxn()]),
    });

    const result = await handleSearchTransactions(client, BID, BNAME, { category_id: 'cat-1' });
    expect(client.getTransactionsByCategory).toHaveBeenCalledWith(BID, 'cat-1', expect.any(String));
    expect(result.count).toBe(1);
  });

  it('resolves category by name using cache', async () => {
    (loadCategoryCache as jest.Mock).mockReturnValue(makeCache());
    const client = makeMockClient({
      getTransactionsByCategory: (jest.fn() as any).mockResolvedValue([makeTxn()]),
    });

    await handleSearchTransactions(client, BID, BNAME, { category_name: 'Groceries' });
    expect(client.getTransactionsByCategory).toHaveBeenCalledWith(BID, 'cat-1', expect.any(String));
  });

  it('filters out deleted transactions', async () => {
    const client = makeMockClient({
      getTransactionsByPayee: (jest.fn() as any).mockResolvedValue([
        makeTxn({ id: 'txn-1', deleted: false }),
        makeTxn({ id: 'txn-2', deleted: true }),
      ]),
    });

    const result = await handleSearchTransactions(client, BID, BNAME, { payee_id: 'pay-1' });
    expect(result.count).toBe(1);
    expect(result.transactions[0].id).toBe('txn-1');
  });
});

// ── handleSyncCategories ──────────────────────────────────────────────────────

describe('handleSyncCategories', () => {
  it('does a full fetch when no cache exists', async () => {
    (loadCategoryCache as jest.Mock).mockReturnValue(null);
    const client = makeMockClient({
      getCategories: (jest.fn() as any).mockResolvedValue({ groups: [], serverKnowledge: 99 }),
    });

    const result = await handleSyncCategories(client, BID, BNAME, {});
    expect(client.getCategories).toHaveBeenCalledWith(BID, undefined);
    expect(result.sync_type).toBe('full');
    expect(result.ok).toBe(true);
  });

  it('does a delta fetch when cache already exists', async () => {
    (loadCategoryCache as jest.Mock).mockReturnValue(makeCache({ serverKnowledge: 10 }));
    const client = makeMockClient({
      getCategories: (jest.fn() as any).mockResolvedValue({ groups: [], serverKnowledge: 15 }),
    });

    const result = await handleSyncCategories(client, BID, BNAME, {});
    expect(client.getCategories).toHaveBeenCalledWith(BID, 10);
    expect(result.sync_type).toBe('delta');
  });

  it('saves the updated cache after syncing', async () => {
    (loadCategoryCache as jest.Mock).mockReturnValue(null);
    const client = makeMockClient({
      getCategories: (jest.fn() as any).mockResolvedValue({ groups: [], serverKnowledge: 5 }),
    });

    await handleSyncCategories(client, BID, BNAME, {});
    expect(saveCategoryCache).toHaveBeenCalled();
  });
});

// ── handleApproveAll ──────────────────────────────────────────────────────────

describe('handleApproveAll', () => {
  it('returns approved_count=0 when there are no unapproved transactions', async () => {
    const client = makeMockClient({
      getTransactions: (jest.fn() as any).mockResolvedValue([]),
    });

    const result = await handleApproveAll(client, BID, BNAME, {});
    expect(result.approved_count).toBe(0);
  });

  it('approves all unapproved non-deleted transactions', async () => {
    const client = makeMockClient({
      getTransactions: (jest.fn() as any).mockResolvedValue([
        makeTxn({ id: 'txn-1', approved: false, deleted: false }),
        makeTxn({ id: 'txn-2', approved: true,  deleted: false }),
        makeTxn({ id: 'txn-3', approved: false, deleted: true  }),
      ]),
      updateTransaction: (jest.fn() as any).mockResolvedValue(makeTxn({ approved: true })),
    });

    const result = await handleApproveAll(client, BID, BNAME, {});
    expect(result.approved_count).toBe(1);
    expect(client.updateTransaction).toHaveBeenCalledTimes(1);
    expect(client.updateTransaction).toHaveBeenCalledWith(BID, 'txn-1', { approved: true });
  });

  it('continues approving even if one transaction fails', async () => {
    const client = makeMockClient({
      getTransactions: (jest.fn() as any).mockResolvedValue([
        makeTxn({ id: 'txn-1', approved: false }),
        makeTxn({ id: 'txn-2', approved: false }),
      ]),
      updateTransaction: (jest.fn() as any)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(makeTxn({ approved: true })),
    });

    const result = await handleApproveAll(client, BID, BNAME, {});
    expect(result.approved_count).toBe(1);
    expect(result.failed_count).toBe(1);
  });
});

// ── handleCreateTransaction ───────────────────────────────────────────────────

describe('handleCreateTransaction', () => {
  beforeEach(() => {
    (loadCategoryCache as jest.Mock).mockReturnValue(makeCache());
  });

  it('converts dollar amount to milliunits', async () => {
    const client = makeMockClient({
      createTransaction: (jest.fn() as any).mockResolvedValue(makeTxn({ amount: -12500 })),
    });

    await handleCreateTransaction(client, BID, BNAME, {
      account_id: 'acc-1', date: '2024-01-15', amount: -12.50,
    });
    expect(client.createTransaction).toHaveBeenCalledWith(
      BID,
      expect.objectContaining({ amount: -12500 })
    );
  });

  it('resolves category name to id', async () => {
    const client = makeMockClient({
      createTransaction: (jest.fn() as any).mockResolvedValue(makeTxn()),
    });

    await handleCreateTransaction(client, BID, BNAME, {
      account_id: 'acc-1', date: '2024-01-15', amount: -10,
      category: 'Groceries',
    });
    expect(client.createTransaction).toHaveBeenCalledWith(
      BID,
      expect.objectContaining({ category_id: 'cat-1' })
    );
  });

  it('works without a category', async () => {
    const client = makeMockClient({
      createTransaction: (jest.fn() as any).mockResolvedValue(makeTxn()),
    });

    await handleCreateTransaction(client, BID, BNAME, {
      account_id: 'acc-1', date: '2024-01-15', amount: -10,
    });
    expect(client.createTransaction).toHaveBeenCalledWith(
      BID,
      expect.objectContaining({ account_id: 'acc-1' })
    );
  });
});

// ── handleListUnapproved ──────────────────────────────────────────────────────

describe('handleListUnapproved', () => {
  it('returns only non-deleted, unapproved transactions', async () => {
    const client = makeMockClient({
      getTransactions: (jest.fn() as any).mockResolvedValue([
        makeTxn({ id: 'txn-1', approved: false, deleted: false }),
        makeTxn({ id: 'txn-2', approved: true,  deleted: false }),
        makeTxn({ id: 'txn-3', approved: false, deleted: true  }),
      ]),
    });

    const result = await handleListUnapproved(client, BID, BNAME, {});
    expect(result.count).toBe(1);
    expect(result.transactions[0].id).toBe('txn-1');
  });

  it('returns multiple unapproved transactions from different accounts', async () => {
    const client = makeMockClient({
      getTransactions: (jest.fn() as any).mockResolvedValue([
        makeTxn({ id: 'txn-1', approved: false, account_id: 'acc-1' }),
        makeTxn({ id: 'txn-2', approved: false, account_id: 'acc-2' }),
      ]),
    });

    const result = await handleListUnapproved(client, BID, BNAME, {});
    expect(result.count).toBe(2);
    const ids = result.transactions.map((t: { id: string }) => t.id);
    expect(ids).toContain('txn-1');
    expect(ids).toContain('txn-2');
  });

  it('returns shaped transaction objects (not raw Transaction type)', async () => {
    const client = makeMockClient({
      getTransactions: (jest.fn() as any).mockResolvedValue([
        makeTxn({ id: 'txn-1', approved: false }),
      ]),
    });

    const result = await handleListUnapproved(client, BID, BNAME, {});
    expect(result.count).toBe(1);
    expect(result.transactions[0]).toHaveProperty('amount_formatted');
  });
});

// ── handleApprove ─────────────────────────────────────────────────────────────

describe('handleApprove', () => {
  it('calls updateTransaction with approved: true', async () => {
    const client = makeMockClient({
      updateTransaction: (jest.fn() as any).mockResolvedValue(makeTxn({ approved: true })),
    });

    const result = await handleApprove(client, BID, BNAME, { transaction_id: 'txn-1' });
    expect(client.updateTransaction).toHaveBeenCalledWith(BID, 'txn-1', { approved: true });
    expect(result.ok).toBe(true);
  });
});

// ── handleDeleteTransaction ───────────────────────────────────────────────────

describe('handleDeleteTransaction', () => {
  it('calls deleteTransaction with the given id', async () => {
    const client = makeMockClient({
      deleteTransaction: (jest.fn() as any).mockResolvedValue(makeTxn()),
    });

    const result = await handleDeleteTransaction(client, BID, BNAME, { transaction_id: 'txn-1' });
    expect(client.deleteTransaction).toHaveBeenCalledWith(BID, 'txn-1');
    expect(result.ok).toBe(true);
  });
});

// ── handleListApproved ────────────────────────────────────────────────────────

describe('handleListApproved', () => {
  it('returns only approved, non-deleted transactions', async () => {
    const client = makeMockClient({
      getTransactions: (jest.fn() as any).mockResolvedValue([
        makeTxn({ id: 'txn-1', approved: true,  deleted: false }),
        makeTxn({ id: 'txn-2', approved: false, deleted: false }),
        makeTxn({ id: 'txn-3', approved: true,  deleted: true  }),
      ]),
    });

    const result = await handleListApproved(client, BID, BNAME, {});
    expect(result.count).toBe(1);
    expect(result.transactions[0].id).toBe('txn-1');
  });
});

// ── handleListPayees ──────────────────────────────────────────────────────────

describe('handleListPayees', () => {
  it('returns only non-deleted, non-transfer payees', async () => {
    const client = makeMockClient({
      getPayees: (jest.fn() as any).mockResolvedValue([
        makePayee({ id: 'p1', name: 'Amazon',  deleted: false }),
        makePayee({ id: 'p2', name: 'Netflix', deleted: true  }),
      ]),
    });

    const result = await handleListPayees(client, BID, BNAME, {});
    expect(result.count).toBe(1);
    expect(result.payees[0].id).toBe('p1');
  });

  it('excludes transfer payees', async () => {
    const client = makeMockClient({
      getPayees: (jest.fn() as any).mockResolvedValue([
        makePayee({ id: 'p1', name: 'Amazon',        transfer_account_id: null }),
        makePayee({ id: 'p2', name: 'Transfer: Sav', transfer_account_id: 'acc-sav' }),
      ]),
    });

    const result = await handleListPayees(client, BID, BNAME, {});
    expect(result.payees.find((p: { id: string }) => p.id === 'p2')).toBeUndefined();
  });

  it('returns shaped objects with id and name only', async () => {
    const client = makeMockClient({
      getPayees: (jest.fn() as any).mockResolvedValue([
        makePayee({ id: 'p1', name: 'Amazon' }),
      ]),
    });

    const result = await handleListPayees(client, BID, BNAME, {});
    expect(result.payees[0]).toEqual({ id: 'p1', name: 'Amazon' });
  });

  it('filters by name substring when search is provided', async () => {
    const client = makeMockClient({
      getPayees: (jest.fn() as any).mockResolvedValue([
        makePayee({ id: 'p1', name: 'Amazon' }),
        makePayee({ id: 'p2', name: 'Netflix' }),
      ]),
    });

    const result = await handleListPayees(client, BID, BNAME, { search: 'amaz' });
    expect(result.count).toBe(1);
    expect(result.payees[0].id).toBe('p1');
  });
});
