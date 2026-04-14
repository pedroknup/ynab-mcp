import { YNABClient } from './api';
import { loadCategoryCache, saveCategoryCache } from './config';
import type { FlatCategory, CategoryGroup, CategoryCache } from './types';

export function resolveCategory(input: string, flat: FlatCategory[]): FlatCategory {
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

export function buildCache(
  budgetId: string,
  groups: CategoryGroup[],
  serverKnowledge: number
): CategoryCache {
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

export function mergeGroups(
  existing: CategoryGroup[],
  delta: CategoryGroup[]
): CategoryGroup[] {
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

/**
 * Load the category cache for the given budget. If missing, fetch from the
 * YNAB API, persist it, and return it — callers never need to pre-sync.
 */
export async function getOrFetchCategories(
  client: YNABClient,
  budgetId: string
): Promise<CategoryCache> {
  const cached = loadCategoryCache(budgetId);
  if (cached) return cached;

  const { groups, serverKnowledge } = await client.getCategories(budgetId);
  const cache = buildCache(budgetId, groups, serverKnowledge);
  saveCategoryCache(budgetId, cache);
  return cache;
}
