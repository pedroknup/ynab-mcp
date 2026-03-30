import axios, { type AxiosInstance } from 'axios';
import type {
  Budget,
  CategoryGroup,
  Transaction,
  TransactionUpdate,
  Account,
  BudgetMonth,
} from './types';

const BASE_URL = 'https://api.ynab.com/v1';

export class YNABClient {
  private http: AxiosInstance;

  constructor(token: string) {
    this.http = axios.create({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
  }

  // ── Budgets ──────────────────────────────────────────────────────────────

  async getBudgets(): Promise<Budget[]> {
    const res = await this.http.get<{ data: { budgets: Budget[] } }>('/budgets');
    return res.data.data.budgets;
  }

  // ── Categories ───────────────────────────────────────────────────────────

  async getCategories(budgetId: string): Promise<CategoryGroup[]> {
    const res = await this.http.get<{
      data: { category_groups: CategoryGroup[] };
    }>(`/budgets/${budgetId}/categories`);
    return res.data.data.category_groups;
  }

  // ── Transactions ─────────────────────────────────────────────────────────

  /**
   * Get transactions for a budget, optionally filtered by date range.
   * sinceDate format: YYYY-MM-DD
   */
  async getTransactions(
    budgetId: string,
    sinceDate?: string,
    type?: 'uncategorized' | 'unapproved'
  ): Promise<Transaction[]> {
    const params: Record<string, string> = {};
    if (sinceDate) params['since_date'] = sinceDate;
    if (type) params['type'] = type;

    const res = await this.http.get<{
      data: { transactions: Transaction[] };
    }>(`/budgets/${budgetId}/transactions`, { params });
    return res.data.data.transactions;
  }

  // ── Accounts ─────────────────────────────────────────────────────────────

  async getAccounts(budgetId: string): Promise<Account[]> {
    const res = await this.http.get<{
      data: { accounts: Account[] };
    }>(`/budgets/${budgetId}/accounts`);
    return res.data.data.accounts;
  }

  // ── Budget Months ─────────────────────────────────────────────────────────

  /**
   * Get a specific month's budget data (categories with budgeted/activity/balance).
   * month format: YYYY-MM-01  or  'current'
   */
  async getBudgetMonth(budgetId: string, month: string): Promise<BudgetMonth> {
    const res = await this.http.get<{
      data: { month: BudgetMonth };
    }>(`/budgets/${budgetId}/months/${month}`);
    return res.data.data.month;
  }

  /**
   * Update a single transaction (e.g., set category_id).
   */
  async updateTransaction(
    budgetId: string,
    transactionId: string,
    update: TransactionUpdate
  ): Promise<Transaction> {
    const res = await this.http.put<{
      data: { transaction: Transaction };
    }>(`/budgets/${budgetId}/transactions/${transactionId}`, {
      transaction: update,
    });
    return res.data.data.transaction;
  }
}
