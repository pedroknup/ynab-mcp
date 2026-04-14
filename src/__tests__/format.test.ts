import { formatAmount, todayISO, daysAgoISO, lastNMonths, currentMonthISO, truncate, pad } from '../format';

describe('formatAmount', () => {
  it('formats positive milliunits as dollars', () => {
    expect(formatAmount(1000)).toBe('$1.00');
  });
  it('formats negative milliunits with minus sign before symbol', () => {
    expect(formatAmount(-2500)).toBe('-$2.50');
  });
  it('formats zero', () => {
    expect(formatAmount(0)).toBe('$0.00');
  });
  it('formats large amounts', () => {
    expect(formatAmount(1000000)).toBe('$1000.00');
  });
  it('uses a custom currency symbol', () => {
    expect(formatAmount(5000, '€')).toBe('€5.00');
  });
  it('rounds sub-cent milliunits to 2 decimal places', () => {
    // 1001 milliunits = $1.001 → displayed as $1.00
    expect(formatAmount(1001)).toBe('$1.00');
  });
  it('formats negative with two decimal places', () => {
    expect(formatAmount(-150000)).toBe('-$150.00');
  });
});

describe('todayISO', () => {
  it('returns a string in YYYY-MM-DD format', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('matches the actual current date', () => {
    const d = new Date();
    const expected = d.toISOString().split('T')[0];
    expect(todayISO()).toBe(expected);
  });
});

describe('daysAgoISO', () => {
  it('returns a string in YYYY-MM-DD format', () => {
    expect(daysAgoISO(7)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('returns a date N days in the past', () => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    expect(daysAgoISO(7)).toBe(d.toISOString().split('T')[0]);
  });
  it('returns today for 0 days', () => {
    expect(daysAgoISO(0)).toBe(todayISO());
  });
  it('returns a date 30 days ago', () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    expect(daysAgoISO(30)).toBe(d.toISOString().split('T')[0]);
  });
});

describe('currentMonthISO', () => {
  it('always ends in -01', () => {
    expect(currentMonthISO()).toMatch(/-01$/);
  });
  it('matches the current year and month', () => {
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    expect(currentMonthISO()).toBe(expected);
  });
});

describe('lastNMonths', () => {
  it('returns exactly N entries', () => {
    expect(lastNMonths(3)).toHaveLength(3);
    expect(lastNMonths(6)).toHaveLength(6);
  });
  it('does not include the current month', () => {
    const current = currentMonthISO();
    expect(lastNMonths(3)).not.toContain(current);
  });
  it('returns months in descending order (most recent first)', () => {
    const months = lastNMonths(3);
    expect(months[0] > months[1]).toBe(true);
    expect(months[1] > months[2]).toBe(true);
  });
  it('all entries end in -01', () => {
    lastNMonths(6).forEach((m) => expect(m).toMatch(/-01$/));
  });
  it('all entries are valid YYYY-MM-01 strings', () => {
    lastNMonths(12).forEach((m) => expect(m).toMatch(/^\d{4}-\d{2}-01$/));
  });
});

describe('truncate', () => {
  it('returns empty string for null', () => {
    expect(truncate(null, 10)).toBe('');
  });
  it('returns empty string for undefined', () => {
    expect(truncate(undefined, 10)).toBe('');
  });
  it('returns the string unchanged when shorter than maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });
  it('returns the string unchanged when equal to maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });
  it('truncates and appends ellipsis when longer than maxLen', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
  });
  it('truncates a single-char result correctly', () => {
    expect(truncate('ab', 2)).toBe('ab');
    expect(truncate('abc', 2)).toBe('a…');
  });
});

describe('pad', () => {
  it('pads left by default', () => {
    expect(pad('hi', 5)).toBe('hi   ');
  });
  it('pads right when align is right', () => {
    expect(pad('hi', 5, 'right')).toBe('   hi');
  });
  it('returns string unchanged when already at width', () => {
    expect(pad('hello', 5)).toBe('hello');
  });
  it('returns string unchanged when longer than width', () => {
    expect(pad('toolong', 3)).toBe('toolong');
  });
});
