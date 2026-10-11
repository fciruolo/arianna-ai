// Totals of the expense tracker (D-183, F2), computed by code in integer cents.
// Expenses are reported as positive cents (the money that went out), income as
// positive cents (the money that came in); a transaction counts in the month
// of its booking day.

import type { CategorizedTransaction, Day, Transaction } from '../types.ts';
import { addMonthsToMonth, dayIndex, monthOf, monthsBetween, type Month } from './days.ts';

export interface MonthTotal {
  month: Month;
  /** Money in, positive cents. */
  income: number;
  /** Money out, positive cents. */
  expenses: number;
  /** `income - expenses`, negative when more went out. */
  net: number;
  /** Number of transactions in the month. */
  count: number;
}

export interface MonthRange {
  from: Month;
  to: Month;
}

export interface DayRange {
  /** First day, included. */
  from: Day;
  /** Last day, included. */
  to: Day;
}

function assertCents(amount: number): void {
  if (!Number.isSafeInteger(amount)) throw new RangeError('amounts must be integer cents');
}

function emptyMonth(month: Month): MonthTotal {
  return { month, income: 0, expenses: 0, net: 0, count: 0 };
}

/**
 * Income and expenses for each month of the range, months without movements
 * included with zeros. Without a range, from the first to the last month
 * with a transaction (empty list when there are none).
 */
export function monthlyTotals(transactions: readonly Transaction[], range?: MonthRange): MonthTotal[] {
  let months: Month[];
  if (range !== undefined) {
    months = monthsBetween(range.from, range.to);
  } else {
    const seen = transactions.map((transaction) => monthOf(transaction.booked)).sort();
    const first = seen[0];
    const last = seen[seen.length - 1];
    months = first === undefined || last === undefined ? [] : monthsBetween(first, last);
  }
  const byMonth = new Map(months.map((month) => [month, emptyMonth(month)]));
  for (const transaction of transactions) {
    assertCents(transaction.amount);
    const total = byMonth.get(monthOf(transaction.booked));
    if (total === undefined) continue;
    if (transaction.amount >= 0) total.income += transaction.amount;
    else total.expenses -= transaction.amount;
    total.net += transaction.amount;
    total.count += 1;
  }
  return months.map((month) => byMonth.get(month) ?? emptyMonth(month));
}

export interface CategoryTotal {
  /** The category id, or null for the transactions without one. */
  category: string | null;
  /** Money out, positive cents. */
  expenses: number;
  /** Money in (refunds, income), positive cents. */
  income: number;
  count: number;
}

/**
 * Expenses and income per category between two days (both included), sorted
 * by expenses, largest first, then by category id; the uncategorized rows
 * have `category: null`.
 */
export function totalsByCategory(transactions: readonly CategorizedTransaction[], range: DayRange): CategoryTotal[] {
  const from = dayIndex(range.from);
  const to = dayIndex(range.to);
  const byCategory = new Map<string | null, CategoryTotal>();
  for (const transaction of transactions) {
    assertCents(transaction.amount);
    const day = dayIndex(transaction.booked);
    if (day < from || day > to) continue;
    let total = byCategory.get(transaction.category);
    if (total === undefined) {
      total = { category: transaction.category, expenses: 0, income: 0, count: 0 };
      byCategory.set(transaction.category, total);
    }
    if (transaction.amount >= 0) total.income += transaction.amount;
    else total.expenses -= transaction.amount;
    total.count += 1;
  }
  return [...byCategory.values()].sort(
    (a, b) => b.expenses - a.expenses || (a.category ?? '￿').localeCompare(b.category ?? '￿'),
  );
}

export interface BalancePoint {
  day: Day;
  /** Balance at the end of the day, cents. */
  balance: number;
  /** `bank` when the statement gave it, `computed` when added up by us. */
  source: 'bank' | 'computed';
}

/**
 * The balance at the end of each day with movements, for one account. Rows
 * are taken in booking order, and in the given order within a day (the
 * import keeps the order of the statement, oldest first). A row with the
 * bank's balance resets the running value to it; the other rows add their
 * amount to the running value, which starts from `opening` (default 0).
 */
export function balanceSeries(transactions: readonly Transaction[], opening = 0): BalancePoint[] {
  assertCents(opening);
  const accounts = new Set(transactions.map((transaction) => transaction.account));
  if (accounts.size > 1) throw new RangeError('balanceSeries takes the transactions of one account');
  const ordered = transactions
    .map((transaction, position) => ({ transaction, position, day: dayIndex(transaction.booked) }))
    .sort((a, b) => a.day - b.day || a.position - b.position);
  const points: BalancePoint[] = [];
  let running = opening;
  for (const { transaction } of ordered) {
    assertCents(transaction.amount);
    let source: BalancePoint['source'];
    if (transaction.balance !== null) {
      assertCents(transaction.balance);
      running = transaction.balance;
      source = 'bank';
    } else {
      running += transaction.amount;
      source = 'computed';
    }
    const last = points[points.length - 1];
    if (last?.day === transaction.booked) {
      last.balance = running;
      last.source = source;
    } else {
      points.push({ day: transaction.booked, balance: running, source });
    }
  }
  return points;
}

export interface YearOverYear {
  current: MonthTotal;
  /** The same month one year earlier. */
  previous: MonthTotal;
  /** `current.expenses - previous.expenses`, cents. */
  expensesChange: number;
  /** `current.income - previous.income`, cents. */
  incomeChange: number;
}

/** A month against the same month of the year before (2024-02 against 2023-02). */
export function yearOverYear(transactions: readonly Transaction[], month: Month): YearOverYear {
  const previousMonth = addMonthsToMonth(month, -12);
  const [current] = monthlyTotals(transactions, { from: month, to: month });
  const [previous] = monthlyTotals(transactions, { from: previousMonth, to: previousMonth });
  const now = current ?? emptyMonth(month);
  const before = previous ?? emptyMonth(previousMonth);
  return {
    current: now,
    previous: before,
    expensesChange: now.expenses - before.expenses,
    incomeChange: now.income - before.income,
  };
}
