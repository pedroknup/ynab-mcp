import inquirer from 'inquirer';
import { YNABClient } from '../api';
import { saveConfig, configExists } from '../config';
import chalk from 'chalk';

export async function setupCommand(opts: { force?: boolean }): Promise<void> {
  if (configExists() && !opts.force) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'A configuration already exists. Overwrite it?',
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log('Setup cancelled.');
      return;
    }
  }

  const { token } = await inquirer.prompt([
    {
      type: 'password',
      name: 'token',
      message: 'Enter your YNAB Personal Access Token:',
      validate: (v: string) => (v.trim().length > 0 ? true : 'Token cannot be empty'),
    },
  ]);

  console.log(chalk.gray('Fetching your budgets...'));

  let budgets;
  try {
    const client = new YNABClient(token.trim());
    budgets = await client.getBudgets();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Failed to connect to YNAB: ${msg}`));
    process.exit(1);
  }

  if (budgets.length === 0) {
    console.error(chalk.red('No budgets found in your YNAB account.'));
    process.exit(1);
  }

  const { budgetId } = await inquirer.prompt([
    {
      type: 'list',
      name: 'budgetId',
      message: 'Select your default budget:',
      choices: budgets.map((b) => ({ name: b.name, value: b.id })),
    },
  ]);

  const selectedBudget = budgets.find((b) => b.id === budgetId)!;

  saveConfig({ token: token.trim(), budgetId, budgetName: selectedBudget.name });

  console.log(chalk.green(`\nSetup complete! Using budget: ${selectedBudget.name}`));
  console.log(
    chalk.gray(`Config saved to ~/.ynab-cli/config.json (permissions: 600)\n`)
  );
  console.log(`Next: run ${chalk.cyan('ynab sync')} to cache your categories.`);
}
