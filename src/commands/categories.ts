import { loadCategoryCache } from '../config';
import chalk from 'chalk';
import { table } from 'table';

interface CategoriesOptions {
  search?: string;
  group?: string;
  json?: boolean;
  showHidden?: boolean;
}

export function categoriesCommand(opts: CategoriesOptions): void {
  const cache = loadCategoryCache();

  if (!cache) {
    console.error(
      chalk.red('No category cache found. Run `ynab sync` first.')
    );
    process.exit(1);
  }

  let results = cache.flat.filter((c) => !c.deleted);

  if (!opts.showHidden) {
    results = results.filter((c) => !c.hidden);
  }

  if (opts.search) {
    const q = opts.search.toLowerCase();
    results = results.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.groupName.toLowerCase().includes(q)
    );
  }

  if (opts.group) {
    const g = opts.group.toLowerCase();
    results = results.filter((c) => c.groupName.toLowerCase().includes(g));
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(chalk.yellow('No categories found matching your criteria.'));
    return;
  }

  const rows = results.map((c) => [
    chalk.cyan(c.id),
    c.groupName,
    c.name,
    c.hidden ? chalk.gray('hidden') : '',
  ]);

  console.log(
    table(
      [
        [
          chalk.bold('ID'),
          chalk.bold('Group'),
          chalk.bold('Category'),
          chalk.bold('Flags'),
        ],
        ...rows,
      ],
      {
        columns: {
          0: { width: 36 },
          1: { width: 24, truncate: 24 },
          2: { width: 28, truncate: 28 },
          3: { width: 8 },
        },
      }
    )
  );

  console.log(
    chalk.gray(
      `${results.length} categories  |  last synced: ${new Date(cache.lastSynced).toLocaleString()}`
    )
  );
}
