// Checks of the expense tracker (D-183, F3), computed by code, never by a
// model: recurring charges, unusual expenses, possible double charges and
// budgets. Every alert carries its kind, the fingerprints of the rows
// involved and the numbers (integer cents); never a ready-made sentence with
// amounts, which the page composes and which must not leave the Mac.
//
// Thresholds (defaults, all overridable):
// - recurring: same account, merchant key and direction, at least 3
//   occurrences on a regular schedule: weekly (7 days, +-1 day), monthly (same
//   day of the month, clamped to the month's end, +-4 days for weekends and
//   holidays), yearly (same day, +-7 days). The amounts before the last stay
//   within 10% (or 1 euro) of their median; the last one is flagged as changed
//   when it falls outside the range of the earlier ones.
// - unusual: an expense at least 3 times the median of the same merchant
//   (at least 3 other expenses there) or, failing that, of the same category
//   (at least 5 other expenses), and at least 50 euro above that median.
// - duplicate: two or more expenses with the same account, merchant key and
//   amount within 3 days. For a recurring merchant, an extra charge beside
//   the schedule is enough; for any other merchant the amount must be at
//   least 10 euro and the bank's description identical (two coffees, or two
//   shopping trips on different days, are legitimate).
// - budget: spending of a category in a month (expenses minus refunds) over
//   the monthly limit, or at least 80% of it.

import type { Budget, CategorizedTransaction, Day, Transaction } from '../types.ts';
import { addDays, addMonths, daysBetween, monthOf, type Month } from './days.ts';
import { merchantKey } from './normalize.ts';

export type Cadence = 'weekly' | 'monthly' | 'yearly';

export interface RecurringAlert {
  kind: 'recurring';
  account: string;
  merchant: string;
  /** `out` for charges, `in` for recurring income such as a salary. */
  direction: 'out' | 'in';
  cadence: Cadence;
  /** The occurrences, oldest first. */
  fingerprints: string[];
  /** The median of the occurrences before the last, positive cents. */
  amount: number;
  /** The last occurrence, positive cents. */
  lastAmount: number;
  /** True when the last amount is outside the range of the earlier ones. */
  amountChanged: boolean;
  lastDay: Day;
  /** When the next occurrence is due on the schedule. */
  nextExpected: Day;
}

export interface UnusualAlert {
  kind: 'unusual';
  fingerprint: string;
  account: string;
  merchant: string;
  category: string | null;
  /** The expense, positive cents. */
  amount: number;
  /** What it is compared with: the same merchant or the same category. */
  basis: 'merchant' | 'category';
  /** The median of the other expenses of the basis, positive cents, rounded. */
  median: number;
  /** How many other expenses the median comes from. */
  historyCount: number;
  /** `amount / median` in percent, rounded. */
  ratioPercent: number;
}

export interface DuplicateAlert {
  kind: 'duplicate';
  account: string;
  merchant: string;
  /** The repeated amount, positive cents. */
  amount: number;
  /** Two or more rows, oldest first. */
  fingerprints: string[];
  firstDay: Day;
  lastDay: Day;
  /** True when the merchant has a recurring schedule the extra row is beside. */
  recurring: boolean;
}

export interface BudgetAlert {
  kind: 'budget';
  category: string;
  month: Month;
  /** Expenses minus refunds of the category in the month, positive cents (0 at least). */
  spent: number;
  /** The monthly limit, cents. */
  limit: number;
  /** `spent / limit` in percent, rounded down. */
  percent: number;
  state: 'over' | 'near';
  /** The rows of the category in the month. */
  fingerprints: string[];
}

export type FinanceAlert = RecurringAlert | UnusualAlert | DuplicateAlert | BudgetAlert;

export interface RecurringOptions {
  /** Allowed distance from the schedule in days, per cadence. */
  toleranceDays?: Partial<Record<Cadence, number>>;
  /** Default 3. */
  minOccurrences?: number;
  /** Allowed distance of the earlier amounts from their median, percent. Default 10. */
  amountTolerancePercent?: number;
  /** Allowed distance of the earlier amounts from their median, cents, when larger. Default 100. */
  amountToleranceCents?: number;
  /** Same-amount rows this close to the previous occurrence are not occurrences. Default 3, at most 5. */
  duplicateWindowDays?: number;
}

export interface UnusualOptions {
  /** Default 300: three times the median. */
  ratioPercent?: number;
  /** Default 5000 cents: 50 euro above the median. */
  minExcessCents?: number;
  /** Default 3. */
  minMerchantHistory?: number;
  /** Default 5. */
  minCategoryHistory?: number;
  /** Only rows booked on this day or later are checked (all rows are history). */
  from?: Day;
}

export interface DuplicateOptions {
  /** Default 3. */
  windowDays?: number;
  /** Default 1000 cents; not applied to recurring merchants. */
  minAmountCents?: number;
  /** The recurring schedules, when already computed. */
  recurring?: readonly RecurringAlert[];
}

export interface BudgetOptions {
  /** Default 80. */
  nearPercent?: number;
}

const DEFAULT_TOLERANCE: Record<Cadence, number> = { weekly: 1, monthly: 4, yearly: 7 };
const CADENCES: readonly Cadence[] = ['weekly', 'monthly', 'yearly'];

function step(anchor: Day, cadence: Cadence, count: number): Day {
  if (cadence === 'weekly') return addDays(anchor, 7 * count);
  return addMonths(anchor, cadence === 'monthly' ? count : 12 * count);
}

/** The median of a non-empty list of numbers. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2;
}

interface Row<T extends Transaction> {
  transaction: T;
  merchant: string;
  /** Positive cents. */
  size: number;
}

function rows<T extends Transaction>(transactions: readonly T[]): Row<T>[] {
  return transactions.map((transaction) => {
    if (!Number.isSafeInteger(transaction.amount)) throw new RangeError('amounts must be integer cents');
    return { transaction, merchant: merchantKey(transaction.description), size: Math.abs(transaction.amount) };
  });
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group === undefined) groups.set(name, [item]);
    else group.push(item);
  }
  return groups;
}

function byDay<T extends Transaction>(a: Row<T>, b: Row<T>): number {
  return daysBetween(b.transaction.booked, a.transaction.booked);
}

function fitsSchedule<T extends Transaction>(series: readonly Row<T>[], cadence: Cadence, tolerance: number): boolean {
  const anchor = series[0]?.transaction.booked;
  if (anchor === undefined) return false;
  return series.every((row, index) => Math.abs(daysBetween(step(anchor, cadence, index), row.transaction.booked)) <= tolerance);
}

function amountsSteady<T extends Transaction>(earlier: readonly Row<T>[], percent: number, cents: number): boolean {
  const middle = median(earlier.map((row) => row.size));
  return earlier.every((row) => {
    const distance = Math.abs(row.size - middle);
    return distance <= cents || distance * 100 <= middle * percent;
  });
}

/**
 * The recurring schedules: for each account, merchant and direction, the
 * longest run up to the latest row that follows a weekly, monthly or yearly
 * schedule with steady amounts.
 */
export function findRecurring(transactions: readonly Transaction[], options: RecurringOptions = {}): RecurringAlert[] {
  const minOccurrences = Math.max(2, options.minOccurrences ?? 3);
  const percent = options.amountTolerancePercent ?? 10;
  const cents = options.amountToleranceCents ?? 100;
  // Capped below a week, so that weekly occurrences are never taken for double charges.
  const window = Math.min(options.duplicateWindowDays ?? 3, 5);
  const alerts: RecurringAlert[] = [];
  const groups = groupBy(
    rows(transactions).filter((row) => row.size > 0),
    (row) => JSON.stringify([row.transaction.account, row.merchant, row.transaction.amount < 0]),
  );
  for (const group of groups.values()) {
    group.sort(byDay);
    // Same-amount rows right after an occurrence are possible double charges, not occurrences.
    const occurrences: Row<Transaction>[] = [];
    for (const row of group) {
      const previous = occurrences[occurrences.length - 1];
      const extra =
        previous !== undefined &&
        previous.size === row.size &&
        daysBetween(previous.transaction.booked, row.transaction.booked) <= window;
      if (!extra) occurrences.push(row);
    }
    let found: { series: Row<Transaction>[]; cadence: Cadence } | null = null;
    for (let start = 0; found === null && start + minOccurrences <= occurrences.length; start++) {
      const series = occurrences.slice(start);
      for (const cadence of CADENCES) {
        const tolerance = options.toleranceDays?.[cadence] ?? DEFAULT_TOLERANCE[cadence];
        if (fitsSchedule(series, cadence, tolerance) && amountsSteady(series.slice(0, -1), percent, cents)) {
          found = { series, cadence };
          break;
        }
      }
    }
    if (found === null) continue;
    const { series, cadence } = found;
    const earlier = series.slice(0, -1).map((row) => row.size);
    const first = series[0];
    const last = series[series.length - 1];
    if (first === undefined || last === undefined) continue;
    alerts.push({
      kind: 'recurring',
      account: last.transaction.account,
      merchant: last.merchant,
      direction: last.transaction.amount < 0 ? 'out' : 'in',
      cadence,
      fingerprints: series.map((row) => row.transaction.fingerprint),
      amount: Math.round(median(earlier)),
      lastAmount: last.size,
      amountChanged: last.size < Math.min(...earlier) || last.size > Math.max(...earlier),
      lastDay: last.transaction.booked,
      nextExpected: step(first.transaction.booked, cadence, series.length),
    });
  }
  return alerts.sort((a, b) => a.merchant.localeCompare(b.merchant) || a.account.localeCompare(b.account));
}

/**
 * Expenses well above what is usual at the same merchant or, without enough
 * history there, in the same category. Only expenses are checked.
 */
export function findUnusual(transactions: readonly CategorizedTransaction[], options: UnusualOptions = {}): UnusualAlert[] {
  const ratio = options.ratioPercent ?? 300;
  const minExcess = options.minExcessCents ?? 5000;
  const minMerchant = options.minMerchantHistory ?? 3;
  const minCategory = options.minCategoryHistory ?? 5;
  const expenses = rows(transactions).filter((row) => row.transaction.amount < 0);
  const byMerchant = groupBy(expenses, (row) => row.merchant);
  const byCategory = groupBy(
    expenses.filter((row) => row.transaction.category !== null),
    (row) => row.transaction.category ?? '',
  );
  const alerts: UnusualAlert[] = [];
  for (const row of expenses) {
    if (options.from !== undefined && daysBetween(options.from, row.transaction.booked) < 0) continue;
    const others = (group: readonly Row<CategorizedTransaction>[] | undefined): number[] =>
      (group ?? []).filter((other) => other !== row).map((other) => other.size);
    let basis: UnusualAlert['basis'];
    let history = others(byMerchant.get(row.merchant));
    if (history.length >= minMerchant) {
      basis = 'merchant';
    } else {
      if (row.transaction.category === null) continue;
      history = others(byCategory.get(row.transaction.category));
      if (history.length < minCategory) continue;
      basis = 'category';
    }
    const middle = median(history);
    if (middle <= 0 || row.size * 100 < middle * ratio || row.size - middle < minExcess) continue;
    alerts.push({
      kind: 'unusual',
      fingerprint: row.transaction.fingerprint,
      account: row.transaction.account,
      merchant: row.merchant,
      category: row.transaction.category,
      amount: row.size,
      basis,
      median: Math.round(middle),
      historyCount: history.length,
      ratioPercent: Math.round((row.size * 100) / middle),
    });
  }
  return alerts;
}

/** The bank's text, compared without case and extra spaces. */
function bankText(description: string): string {
  return description.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Possible double charges: a warning for the user to look at, never a
 * correction. Rows with the same fingerprint are the same movement and are
 * the import's business, not counted here.
 */
export function findDuplicates(transactions: readonly Transaction[], options: DuplicateOptions = {}): DuplicateAlert[] {
  const window = options.windowDays ?? 3;
  const minAmount = options.minAmountCents ?? 1000;
  const recurring = options.recurring ?? findRecurring(transactions, { duplicateWindowDays: window });
  const recurringMerchants = new Set(
    recurring.filter((alert) => alert.direction === 'out').map((alert) => JSON.stringify([alert.account, alert.merchant])),
  );
  const occurrences = new Set(recurring.flatMap((alert) => alert.fingerprints));
  const seen = new Set<string>();
  const expenses = rows(transactions).filter((row) => {
    if (row.transaction.amount >= 0 || seen.has(row.transaction.fingerprint)) return false;
    seen.add(row.transaction.fingerprint);
    return true;
  });
  const alerts: DuplicateAlert[] = [];
  const groups = groupBy(expenses, (row) => JSON.stringify([row.transaction.account, row.merchant, row.size]));
  for (const group of groups.values()) {
    group.sort(byDay);
    const first = group[0];
    if (first === undefined) continue;
    const isRecurring = recurringMerchants.has(JSON.stringify([first.transaction.account, first.merchant]));
    // Clusters of rows each within the window of the one before.
    const clusters: Row<Transaction>[][] = [];
    for (const row of group) {
      const cluster = clusters[clusters.length - 1];
      const previous = cluster?.[cluster.length - 1];
      if (cluster !== undefined && previous !== undefined && daysBetween(previous.transaction.booked, row.transaction.booked) <= window) {
        cluster.push(row);
      } else {
        clusters.push([row]);
      }
    }
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      let suspects: Row<Transaction>[][];
      if (isRecurring) {
        // Two scheduled occurrences are never a duplicate of each other.
        suspects = cluster.filter((row) => !occurrences.has(row.transaction.fingerprint)).length > 0 ? [cluster] : [];
      } else if (first.size < minAmount) {
        suspects = [];
      } else {
        // Only rows with the very same bank text: a different time or reference means two operations.
        suspects = [...groupBy(cluster, (row) => bankText(row.transaction.description)).values()].filter((same) => same.length >= 2);
      }
      for (const suspect of suspects) {
        const head = suspect[0];
        const tail = suspect[suspect.length - 1];
        if (head === undefined || tail === undefined) continue;
        alerts.push({
          kind: 'duplicate',
          account: head.transaction.account,
          merchant: head.merchant,
          amount: head.size,
          fingerprints: suspect.map((row) => row.transaction.fingerprint),
          firstDay: head.transaction.booked,
          lastDay: tail.transaction.booked,
          recurring: isRecurring,
        });
      }
    }
  }
  return alerts.sort((a, b) => daysBetween(b.firstDay, a.firstDay) || a.merchant.localeCompare(b.merchant));
}

/**
 * Budgets over the limit or close to it in a month. Spending is the expenses
 * minus the refunds of the category in that month, never below zero.
 */
export function checkBudgets(
  transactions: readonly CategorizedTransaction[],
  budgets: readonly Budget[],
  month: Month,
  options: BudgetOptions = {},
): BudgetAlert[] {
  const near = options.nearPercent ?? 80;
  const alerts: BudgetAlert[] = [];
  for (const budget of budgets) {
    if (!Number.isSafeInteger(budget.monthly) || budget.monthly <= 0) {
      throw new RangeError('a budget is a positive number of integer cents');
    }
    const inMonth = transactions.filter(
      (transaction) => transaction.category === budget.category && monthOf(transaction.booked) === month,
    );
    let net = 0;
    for (const transaction of inMonth) {
      if (!Number.isSafeInteger(transaction.amount)) throw new RangeError('amounts must be integer cents');
      net += transaction.amount;
    }
    const spent = Math.max(0, -net);
    let state: BudgetAlert['state'];
    if (spent > budget.monthly) state = 'over';
    else if (spent * 100 >= budget.monthly * near) state = 'near';
    else continue;
    alerts.push({
      kind: 'budget',
      category: budget.category,
      month,
      spent,
      limit: budget.monthly,
      percent: Math.floor((spent * 100) / budget.monthly),
      state,
      fingerprints: inMonth.map((transaction) => transaction.fingerprint),
    });
  }
  return alerts;
}

export interface CheckOptions {
  /** The month for the budgets, and the first day of the expenses checked as unusual. */
  month: Month;
  budgets?: readonly Budget[];
  recurring?: RecurringOptions;
  unusual?: Omit<UnusualOptions, 'from'>;
  duplicates?: Omit<DuplicateOptions, 'recurring'>;
  budget?: BudgetOptions;
}

/**
 * All the alerts for a month: possible double charges, budgets, unusual
 * expenses booked from the start of the month, and recurring schedules whose
 * last amount changed. The whole history is used as reference.
 */
export function runChecks(transactions: readonly CategorizedTransaction[], options: CheckOptions): FinanceAlert[] {
  const recurring = findRecurring(transactions, options.recurring);
  const start = options.month + '-01';
  return [
    ...findDuplicates(transactions, { ...options.duplicates, recurring }).filter((alert) => daysBetween(start, alert.lastDay) >= 0),
    ...checkBudgets(transactions, options.budgets ?? [], options.month, options.budget),
    ...findUnusual(transactions, { ...options.unusual, from: start }),
    ...recurring.filter((alert) => alert.amountChanged && daysBetween(start, alert.lastDay) >= 0),
  ];
}
