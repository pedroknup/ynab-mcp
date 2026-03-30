// YNAB API Types

export interface Budget {
  id: string;
  name: string;
  last_modified_on: string;
  first_month: string;
  last_month: string;
  date_format: { format: string };
  currency_format: {
    iso_code: string;
    example_format: string;
    decimal_digits: number;
    decimal_separator: string;
    symbol_first: boolean;
    group_separator: string;
    currency_symbol: string;
    display_symbol: boolean;
  };
}

export interface CategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
  categories: Category[];
}

export interface Category {
  id: string;
  category_group_id: string;
  category_group_name?: string;
  name: string;
  hidden: boolean;
  note: string | null;
  budgeted: number; // milliunits
  activity: number; // milliunits
  balance: number; // milliunits
  goal_type: 'TB' | 'TBD' | 'MF' | 'NEED' | 'DEBT' | null;
  goal_target: number | null;
  deleted: boolean;
}

export type ClearedStatus = 'cleared' | 'uncleared' | 'reconciled';
export type FlagColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | null;

export interface Subtransaction {
  id: string;
  transaction_id: string;
  amount: number; // milliunits
  memo: string | null;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  deleted: boolean;
}

export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD
  amount: number; // milliunits (negative = outflow, positive = inflow)
  memo: string | null;
  cleared: ClearedStatus;
  approved: boolean;
  flag_color: FlagColor;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  matched_transaction_id: string | null;
  import_id: string | null;
  import_payee_name: string | null;
  import_payee_name_original: string | null;
  debt_transaction_type: string | null;
  deleted: boolean;
  subtransactions: Subtransaction[];
}

export interface TransactionUpdate {
  date?: string;
  amount?: number;
  memo?: string | null;
  cleared?: ClearedStatus;
  approved?: boolean;
  flag_color?: FlagColor | null;
  account_id?: string;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
}

// Local config stored in ~/.ynab-cli/config.json
export interface Config {
  token: string;
  budgetId: string;
  budgetName: string;
}

// Local category cache stored in ~/.ynab-cli/categories.json
export interface CategoryCache {
  lastSynced: string; // ISO timestamp
  groups: CategoryGroup[];
  flat: FlatCategory[];
}

export interface FlatCategory {
  id: string;
  name: string;
  groupName: string;
  groupId: string;
  hidden: boolean;
  deleted: boolean;
}

// Day summary types
export interface DaySummary {
  date: string;
  totalInflow: number;
  totalOutflow: number;
  net: number;
  transactionCount: number;
  uncategorizedCount: number;
  topOutflows: Transaction[];
  byCategory: CategorySpend[];
  byAccount: AccountSpend[];
}

export interface CategorySpend {
  categoryName: string;
  categoryId: string | null;
  total: number;
  count: number;
}

export interface AccountSpend {
  accountName: string;
  accountId: string;
  total: number;
  count: number;
}
