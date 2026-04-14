import { resolveCategory, buildCache, mergeGroups } from '../categories';
import type { FlatCategory, CategoryGroup, Category } from '../types';

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeFlat(overrides: Partial<FlatCategory>[] = []): FlatCategory[] {
  return [
    { id: 'cat-1', name: 'Groceries',   groupName: 'Food',          groupId: 'g-1', hidden: false, deleted: false },
    { id: 'cat-2', name: 'Dining Out',  groupName: 'Food',          groupId: 'g-1', hidden: false, deleted: false },
    { id: 'cat-3', name: 'Netflix',     groupName: 'Entertainment', groupId: 'g-2', hidden: false, deleted: false },
    { id: 'cat-4', name: 'Old Budget',  groupName: 'Food',          groupId: 'g-1', hidden: false, deleted: true },
    ...overrides.map((o) => ({ id: 'cat-x', name: 'x', groupName: 'x', groupId: 'g-x', hidden: false, deleted: false, ...o })),
  ];
}

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1', category_group_id: 'g-1', name: 'Groceries',
    hidden: false, note: null, budgeted: 50000, activity: 0, balance: 50000,
    goal_type: null, goal_target: null, deleted: false,
    ...overrides,
  };
}

function makeGroup(id: string, name: string, categories: Category[] = []): CategoryGroup {
  return { id, name, hidden: false, deleted: false, categories };
}

// ── resolveCategory ───────────────────────────────────────────────────────────

describe('resolveCategory', () => {
  const flat = makeFlat();

  it('resolves by exact UUID', () => {
    expect(resolveCategory('cat-1', flat).id).toBe('cat-1');
  });

  it('resolves by exact name (case-insensitive)', () => {
    expect(resolveCategory('groceries', flat).id).toBe('cat-1');
    expect(resolveCategory('GROCERIES', flat).id).toBe('cat-1');
  });

  it('resolves by fuzzy/partial name', () => {
    expect(resolveCategory('groc', flat).id).toBe('cat-1');
    expect(resolveCategory('Netflix', flat).id).toBe('cat-3');
  });

  it('throws when no category matches', () => {
    expect(() => resolveCategory('zzz-no-match', flat)).toThrow('No category found');
  });

  it('throws when multiple categories share the same exact name', () => {
    const dupe = makeFlat([{ id: 'cat-dupe', name: 'Groceries' }]);
    expect(() => resolveCategory('Groceries', dupe)).toThrow('Multiple categories match');
  });

  it('throws when multiple categories partially match', () => {
    const ambiguous: FlatCategory[] = [
      { id: 'a', name: 'Dining Out',  groupName: 'Food', groupId: 'g1', hidden: false, deleted: false },
      { id: 'b', name: 'Dining In',   groupName: 'Food', groupId: 'g1', hidden: false, deleted: false },
    ];
    expect(() => resolveCategory('dining', ambiguous)).toThrow('Multiple categories partially match');
  });

  it('does not resolve deleted categories by name', () => {
    expect(() => resolveCategory('Old Budget', flat)).toThrow('No category found');
  });

  it('does not resolve deleted categories by UUID', () => {
    // cat-4 is deleted; resolveCategory should skip it when looking by id
    expect(() => resolveCategory('cat-4', flat)).toThrow('No category found');
  });

  it('prefers exact ID match over name match', () => {
    // If a UUID happens to also be a substring of a name, ID wins
    const tricky = makeFlat([{ id: 'groc', name: 'Something Else' }]);
    // 'groc' is both an ID and a substring of 'Groceries'
    expect(resolveCategory('groc', tricky).id).toBe('groc');
  });
});

// ── buildCache ────────────────────────────────────────────────────────────────

describe('buildCache', () => {
  const groups: CategoryGroup[] = [
    makeGroup('g-1', 'Food', [
      makeCategory({ id: 'cat-1', name: 'Groceries', category_group_id: 'g-1' }),
      makeCategory({ id: 'cat-2', name: 'Dining Out', category_group_id: 'g-1', hidden: true }),
    ]),
    makeGroup('g-2', 'Entertainment', [
      makeCategory({ id: 'cat-3', name: 'Netflix', category_group_id: 'g-2', deleted: true }),
    ]),
  ];

  it('stores budgetId and serverKnowledge', () => {
    const cache = buildCache('budget-1', groups, 42);
    expect(cache.budgetId).toBe('budget-1');
    expect(cache.serverKnowledge).toBe(42);
  });

  it('sets a valid ISO lastSynced timestamp', () => {
    const cache = buildCache('budget-1', groups, 42);
    expect(new Date(cache.lastSynced).toISOString()).toBe(cache.lastSynced);
  });

  it('flattens all categories including hidden and deleted', () => {
    const cache = buildCache('budget-1', groups, 42);
    expect(cache.flat).toHaveLength(3);
  });

  it('populates groupName and groupId correctly', () => {
    const cache = buildCache('budget-1', groups, 42);
    const groceries = cache.flat.find((c) => c.id === 'cat-1');
    expect(groceries?.groupName).toBe('Food');
    expect(groceries?.groupId).toBe('g-1');
  });

  it('preserves hidden and deleted flags in flat', () => {
    const cache = buildCache('budget-1', groups, 42);
    expect(cache.flat.find((c) => c.id === 'cat-2')?.hidden).toBe(true);
    expect(cache.flat.find((c) => c.id === 'cat-3')?.deleted).toBe(true);
  });
});

// ── mergeGroups ───────────────────────────────────────────────────────────────

describe('mergeGroups', () => {
  const existing: CategoryGroup[] = [
    makeGroup('g-1', 'Food', [
      makeCategory({ id: 'cat-1', name: 'Groceries',  budgeted: 50000 }),
      makeCategory({ id: 'cat-2', name: 'Dining Out', budgeted: 30000 }),
    ]),
  ];

  it('returns existing groups unchanged when delta is empty', () => {
    const result = mergeGroups(existing, []);
    expect(result).toHaveLength(1);
    expect(result[0].categories).toHaveLength(2);
  });

  it('adds a new group from delta', () => {
    const delta = [makeGroup('g-2', 'Entertainment')];
    const result = mergeGroups(existing, delta);
    expect(result).toHaveLength(2);
    expect(result.find((g) => g.id === 'g-2')?.name).toBe('Entertainment');
  });

  it('updates group-level metadata (name, hidden) from delta', () => {
    const delta = [makeGroup('g-1', 'Renamed Food', [])];
    const result = mergeGroups(existing, delta);
    expect(result.find((g) => g.id === 'g-1')?.name).toBe('Renamed Food');
  });

  it('upserts a changed category and keeps unchanged ones', () => {
    const delta: CategoryGroup[] = [
      makeGroup('g-1', 'Food', [
        makeCategory({ id: 'cat-1', name: 'Groceries Updated', budgeted: 60000 }),
      ]),
    ];
    const result = mergeGroups(existing, delta);
    const cats = result[0].categories;
    expect(cats).toHaveLength(2); // cat-1 updated, cat-2 kept
    expect(cats.find((c) => c.id === 'cat-1')?.name).toBe('Groceries Updated');
    expect(cats.find((c) => c.id === 'cat-2')?.name).toBe('Dining Out');
  });

  it('adds a new category to an existing group', () => {
    const delta: CategoryGroup[] = [
      makeGroup('g-1', 'Food', [
        makeCategory({ id: 'cat-3', name: 'Snacks', budgeted: 10000 }),
      ]),
    ];
    const result = mergeGroups(existing, delta);
    expect(result[0].categories).toHaveLength(3);
    expect(result[0].categories.find((c) => c.id === 'cat-3')?.name).toBe('Snacks');
  });

  it('marks a category as deleted when delta has deleted: true', () => {
    const delta: CategoryGroup[] = [
      makeGroup('g-1', 'Food', [
        makeCategory({ id: 'cat-2', name: 'Dining Out', deleted: true }),
      ]),
    ];
    const result = mergeGroups(existing, delta);
    expect(result[0].categories.find((c) => c.id === 'cat-2')?.deleted).toBe(true);
  });

  it('handles multiple groups in delta simultaneously', () => {
    const delta = [
      makeGroup('g-1', 'Food', [makeCategory({ id: 'cat-1', name: 'Groceries v2' })]),
      makeGroup('g-2', 'New Group'),
    ];
    const result = mergeGroups(existing, delta);
    expect(result).toHaveLength(2);
    expect(result.find((g) => g.id === 'g-1')?.categories.find((c) => c.id === 'cat-1')?.name).toBe('Groceries v2');
    expect(result.find((g) => g.id === 'g-2')).toBeDefined();
  });
});
