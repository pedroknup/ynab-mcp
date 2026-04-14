import type { Transaction, BudgetStatus } from './types';

export function isUncategorized(t: Transaction): boolean {
  return !t.deleted && !t.transfer_account_id && !t.category_id;
}

export function monthProgress(): number {
  const now = new Date();
  return (now.getDate() - 1) / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

export function computeStatus(
  budgeted: number,
  balance: number,
  spendRate: number,
  mRate: number
): BudgetStatus {
  if (budgeted === 0) return 'unbudgeted';
  if (balance < 0) return 'overspent';
  if (spendRate > mRate + 0.15) return 'warning';
  if (spendRate < mRate - 0.15) return 'ahead';
  return 'on_track';
}
