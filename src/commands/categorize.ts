import { YNABClient } from '../api';
import { loadConfig, loadCategoryCache } from '../config';
import { formatAmount, formatDate } from '../format';
import type { FlatCategory } from '../types';
import chalk from 'chalk';

interface CategorizeOptions {
  json?: boolean;
}

/**
 * Resolve a category by exact ID or by name search.
 * Returns the matched category or throws.
 */
function resolveCategory(input: string, flat: FlatCategory[]): FlatCategory {
  // Try exact ID match first
  const byId = flat.find((c) => c.id === input && !c.deleted);
  if (byId) return byId;

  // Try exact name match (case-insensitive)
  const byName = flat.filter(
    (c) => !c.deleted && c.name.toLowerCase() === input.toLowerCase()
  );
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `Multiple categories match "${input}":\n` +
        byName.map((c) => `  ${c.id}  ${c.groupName} > ${c.name}`).join('\n') +
        '\nPlease use the category ID instead.'
    );
  }

  // Fuzzy search
  const fuzzy = flat.filter(
    (c) =>
      !c.deleted && c.name.toLowerCase().includes(input.toLowerCase())
  );
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(
      `Multiple categories partially match "${input}":\n` +
        fuzzy.map((c) => `  ${c.id}  ${c.groupName} > ${c.name}`).join('\n') +
        '\nPlease use the category ID or a more specific name.'
    );
  }

  throw new Error(
    `No category found matching "${input}". Run \`ynab categories --search ${input}\` to browse.`
  );
}

export async function categorizeCommand(
  transactionId: string,
  categoryInput: string,
  opts: CategorizeOptions
): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);

  // Resolve category
  const cache = loadCategoryCache();
  if (!cache) {
    console.error(
      chalk.red('No category cache found. Run `ynab sync` first.')
    );
    process.exit(1);
  }

  let category: FlatCategory;
  try {
    category = resolveCategory(categoryInput, cache.flat);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(msg));
    process.exit(1);
  }

  if (!opts.json) {
    console.log(
      chalk.gray(
        `Assigning category "${category.groupName} > ${category.name}" to transaction ${transactionId}...`
      )
    );
  }

  let updated;
  try {
    updated = await client.updateTransaction(config.budgetId, transactionId, {
      category_id: category.id,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Failed to update transaction: ${msg}`));
    process.exit(1);
  }

  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        transaction: {
          id: updated.id,
          date: updated.date,
          amount: updated.amount,
          amount_formatted: formatAmount(updated.amount),
          payee_name: updated.payee_name,
          category_id: updated.category_id,
          category_name: updated.category_name,
        },
      })
    );
    return;
  }

  console.log(chalk.green('\nTransaction updated successfully!'));
  console.log(`  Date:     ${formatDate(updated.date)}`);
  console.log(`  Amount:   ${formatAmount(updated.amount)}`);
  console.log(`  Payee:    ${updated.payee_name ?? '—'}`);
  console.log(`  Category: ${chalk.cyan(updated.category_name ?? '—')}`);
  console.log();
}
