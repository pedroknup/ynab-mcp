import { computeStatus, isUncategorized, monthProgress } from '../budget';
import type { Transaction } from '../types';

// ── computeStatus ─────────────────────────────────────────────────────────────

describe('computeStatus', () => {
  it('returns unbudgeted when budgeted is 0', () => {
    expect(computeStatus(0, 0, 0, 0.5)).toBe('unbudgeted');
    expect(computeStatus(0, 100, 0.5, 0.5)).toBe('unbudgeted');
  });

  it('returns overspent when balance is negative', () => {
    expect(computeStatus(50000, -1, 1.02, 0.5)).toBe('overspent');
    expect(computeStatus(50000, -1000, 0, 0.5)).toBe('overspent');
  });

  it('returns warning when spend rate exceeds month rate by more than 0.15', () => {
    // mRate=0.5, spendRate=0.66 → diff=0.16 > 0.15 → warning
    expect(computeStatus(50000, 17000, 0.66, 0.5)).toBe('warning');
    expect(computeStatus(50000, 5000, 0.9, 0.5)).toBe('warning');
  });

  it('returns ahead when spend rate is more than 0.15 below month rate', () => {
    // mRate=0.5, spendRate=0.34 → diff=-0.16 < -0.15 → ahead
    expect(computeStatus(50000, 33000, 0.34, 0.5)).toBe('ahead');
    expect(computeStatus(50000, 50000, 0, 0.5)).toBe('ahead');
  });

  it('returns on_track when rates are within ±0.15 of each other', () => {
    expect(computeStatus(50000, 25000, 0.5, 0.5)).toBe('on_track');
    expect(computeStatus(50000, 20000, 0.6, 0.5)).toBe('on_track');  // diff=0.1
    expect(computeStatus(50000, 32000, 0.36, 0.5)).toBe('on_track'); // diff=-0.14
  });

  it('boundary: spendRate exactly 0.15 above mRate → on_track (not warning)', () => {
    // diff must be strictly > 0.15 for warning
    expect(computeStatus(50000, 17500, 0.65, 0.5)).toBe('on_track');
  });

  it('boundary: spendRate exactly 0.15 below mRate → on_track (not ahead)', () => {
    expect(computeStatus(50000, 32500, 0.35, 0.5)).toBe('on_track');
  });

  it('overspent takes priority over warning', () => {
    // balance negative AND spendRate > mRate+0.15 → overspent wins
    expect(computeStatus(50000, -100, 0.9, 0.5)).toBe('overspent');
  });
});

// ── isUncategorized ───────────────────────────────────────────────────────────

describe('isUncategorized', () => {
  const base = (): Partial<Transaction> => ({
    deleted: false,
    transfer_account_id: null,
    category_id: null,
  });

  it('returns true for a transaction with no category, not deleted, not a transfer', () => {
    expect(isUncategorized(base() as Transaction)).toBe(true);
  });

  it('returns false for a deleted transaction', () => {
    expect(isUncategorized({ ...base(), deleted: true } as Transaction)).toBe(false);
  });

  it('returns false for a transfer (transfer_account_id set)', () => {
    expect(isUncategorized({ ...base(), transfer_account_id: 'acc-2' } as Transaction)).toBe(false);
  });

  it('returns false for a categorized transaction', () => {
    expect(isUncategorized({ ...base(), category_id: 'cat-1' } as Transaction)).toBe(false);
  });

  it('returns false when both deleted and transfer', () => {
    expect(isUncategorized({ ...base(), deleted: true, transfer_account_id: 'acc-2' } as Transaction)).toBe(false);
  });
});

// ── monthProgress ─────────────────────────────────────────────────────────────

describe('monthProgress', () => {
  afterEach(() => jest.useRealTimers());

  it('returns a number between 0 and 1', () => {
    const p = monthProgress();
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it('returns 0 on the 1st day of the month', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T12:00:00Z'));
    expect(monthProgress()).toBe(0);
  });

  it('returns close to 1 on the last day of a 31-day month', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-31T12:00:00Z'));
    expect(monthProgress()).toBeCloseTo(30 / 31, 5);
  });

  it('handles February correctly (28-day month)', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2023-02-14T12:00:00Z'));
    // (14-1)/28 = 13/28
    expect(monthProgress()).toBeCloseTo(13 / 28, 5);
  });

  it('handles leap year February correctly (29-day month)', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-02-15T12:00:00Z'));
    // (15-1)/29 = 14/29
    expect(monthProgress()).toBeCloseTo(14 / 29, 5);
  });
});
