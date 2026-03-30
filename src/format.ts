/**
 * Utility functions for formatting YNAB data.
 * YNAB amounts are in milliunits (1/1000 of a currency unit).
 */

/** Convert milliunits to a dollar amount string */
export function formatAmount(milliunits: number, symbol = '$'): string {
  const amount = milliunits / 1000;
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount).toFixed(2);
  return `${sign}${symbol}${abs}`;
}

/** Format a date string for display */
export function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${month}/${day}/${year}`;
}

/** Get today's date in YYYY-MM-DD */
export function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

/** Get a date N days ago in YYYY-MM-DD */
export function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

/** Truncate a string to maxLen characters */
export function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

/** Pad string to a fixed width */
export function pad(str: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (align === 'right') return str.padStart(width);
  return str.padEnd(width);
}
