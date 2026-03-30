import { YNABClient } from '../api';
import { loadConfig } from '../config';
import { formatAmount } from '../format';
import chalk from 'chalk';

interface AccountsOptions {
  json?: boolean;
  onBudget?: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  checking:       'Checking',
  savings:        'Savings',
  cash:           'Cash',
  creditCard:     'Credit Card',
  lineOfCredit:   'Line of Credit',
  otherAsset:     'Asset',
  otherLiability: 'Liability',
  mortgage:       'Mortgage',
  autoLoan:       'Auto Loan',
  studentLoan:    'Student Loan',
  personalLoan:   'Personal Loan',
  medicalDebt:    'Medical Debt',
  otherDebt:      'Debt',
};

export async function accountsCommand(opts: AccountsOptions): Promise<void> {
  const config = loadConfig();
  const client = new YNABClient(config.token);

  if (!opts.json) console.log(chalk.gray('Fetching accounts...'));

  const all = await client.getAccounts(config.budgetId);
  const accounts = all.filter((a) => !a.deleted && !a.closed);

  const onBudget  = accounts.filter((a) => a.on_budget);
  const offBudget = accounts.filter((a) => !a.on_budget);

  // Separate assets vs liabilities for net worth
  const isLiability = (type: string) =>
    ['creditCard', 'lineOfCredit', 'mortgage', 'autoLoan', 'studentLoan',
     'personalLoan', 'medicalDebt', 'otherDebt', 'otherLiability'].includes(type);

  const totalAssets     = accounts.filter((a) => !isLiability(a.type)).reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = accounts.filter((a) => isLiability(a.type)).reduce((s, a) => s + a.balance, 0);
  const netWorth = totalAssets + totalLiabilities;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          net_worth: netWorth,
          net_worth_formatted: formatAmount(netWorth),
          total_assets: totalAssets,
          total_assets_formatted: formatAmount(totalAssets),
          total_liabilities: totalLiabilities,
          total_liabilities_formatted: formatAmount(totalLiabilities),
          on_budget: onBudget.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            balance: a.balance,
            balance_formatted: formatAmount(a.balance),
            cleared_balance: a.cleared_balance,
            uncleared_balance: a.uncleared_balance,
          })),
          off_budget: offBudget.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            balance: a.balance,
            balance_formatted: formatAmount(a.balance),
          })),
        },
        null,
        2
      )
    );
    return;
  }

  const printGroup = (label: string, list: typeof accounts) => {
    if (list.length === 0) return;
    console.log(chalk.bold(`  ${label}`));
    for (const a of list) {
      const typeStr = chalk.gray((TYPE_LABEL[a.type] ?? a.type).padEnd(14));
      const bal = a.balance >= 0 ? chalk.green(formatAmount(a.balance)) : chalk.red(formatAmount(a.balance));
      const uncleared = a.uncleared_balance !== 0
        ? chalk.gray(` (${formatAmount(a.uncleared_balance)} uncleared)`)
        : '';
      console.log(`    ${typeStr}  ${a.name.padEnd(28)}  ${bal}${uncleared}`);
    }
    console.log();
  };

  console.log();
  console.log(chalk.bold.cyan(`  Accounts — ${config.budgetName}`));
  console.log(chalk.gray('  ' + '─'.repeat(56)));
  console.log();

  if (!opts.onBudget) {
    printGroup('On Budget', onBudget);
    printGroup('Off Budget / Tracking', offBudget);
  } else {
    printGroup('On Budget', onBudget);
  }

  const nwColor = netWorth >= 0 ? chalk.green : chalk.red;
  console.log(chalk.gray('  ' + '─'.repeat(56)));
  console.log(
    `  ${chalk.bold('Net Worth:')}   ${nwColor(formatAmount(netWorth))}`
  );
  console.log(
    `  ${chalk.gray('Assets:')}      ${chalk.green(formatAmount(totalAssets))}   ` +
    `${chalk.gray('Liabilities:')}  ${chalk.red(formatAmount(totalLiabilities))}`
  );
  console.log();
}
