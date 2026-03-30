import { YNABClient } from '../api';
import { loadConfig, saveCategoryCache } from '../config';
import type { FlatCategory, CategoryCache } from '../types';
import chalk from 'chalk';

export async function syncCommand(opts: { json?: boolean }): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);

  if (!opts.json) console.log(chalk.gray('Syncing categories from YNAB...'));

  const groups = await client.getCategories(config.budgetId);

  const flat: FlatCategory[] = [];
  for (const group of groups) {
    for (const cat of group.categories) {
      flat.push({
        id: cat.id,
        name: cat.name,
        groupName: group.name,
        groupId: group.id,
        hidden: cat.hidden,
        deleted: cat.deleted,
      });
    }
  }

  const cache: CategoryCache = {
    lastSynced: new Date().toISOString(),
    groups,
    flat,
  };

  saveCategoryCache(cache);

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, categoryCount: flat.length, lastSynced: cache.lastSynced }));
  } else {
    console.log(
      chalk.green(
        `Synced ${flat.length} categories across ${groups.length} groups. Last synced: ${new Date().toLocaleString()}`
      )
    );
  }
}
