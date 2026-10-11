import type { BalancePoint, CategoryTotal, Day, MonthTotal } from './finance.ts';

/**
 * The charts of "Finanze" (I-18, D-183), drawn by the page in SVG without a
 * library: here only the numbers (scales, ticks, rectangles, paths), so the
 * components draw and the tests check the geometry.
 */

/** A round upper bound for an axis: 1, 2, 2.5 or 5 times a power of ten, at least the value. */
export function niceCeil(value: number): number {
  if (value <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * power;
    if (candidate >= value) return candidate;
  }
  return 10 * power;
}

/** The domain of an axis that holds zero and every value, with round ends. */
export function niceDomain(values: readonly number[]): [number, number] {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const top = niceCeil(max);
  const bottom = min < 0 ? -niceCeil(-min) : 0;
  return top === bottom ? [0, 1] : [bottom, top];
}

/** `count` + 1 evenly spaced ticks from the bottom to the top of a domain. */
export function ticks(domain: readonly [number, number], count = 4): number[] {
  const [bottom, top] = domain;
  const step = (top - bottom) / count;
  return Array.from({ length: count + 1 }, (_, index) => Math.round(bottom + step * index));
}

/** A linear scale from a domain to a range of pixels. */
export function scale(domain: readonly [number, number], range: readonly [number, number]): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (value) => (span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0));
}

export interface Frame {
  width: number;
  height: number;
  /** Room for the labels: left for the axis, bottom for the months. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonthBars {
  month: string;
  income: Bar;
  expenses: Bar;
  /** Middle of the group, for the label. */
  center: number;
}

/** Two bars per month (income, expenses) from the zero line up. */
export function monthBars(months: readonly MonthTotal[], frame: Frame): { bars: MonthBars[]; domain: [number, number]; y: (value: number) => number } {
  const domain = niceDomain(months.flatMap((month) => [month.income, month.expenses]));
  const y = scale(domain, [frame.height - frame.bottom, frame.top]);
  const inner = frame.width - frame.left - frame.right;
  const slot = months.length === 0 ? inner : inner / months.length;
  const barWidth = Math.max(2, Math.min(18, slot * 0.34));
  const zero = y(0);
  const bar = (x: number, value: number): Bar => ({ x, y: y(value), width: barWidth, height: Math.max(0, zero - y(value)) });
  const bars = months.map((month, index) => {
    const center = frame.left + slot * index + slot / 2;
    return { month: month.month, income: bar(center - barWidth - 1, month.income), expenses: bar(center + 1, month.expenses), center };
  });
  return { bars, domain, y };
}

export interface CategoryBar {
  category: string | null;
  expenses: number;
  /** Width as a share of the largest, 0-100. */
  percent: number;
  /** Share of all the expenses, 0-100, rounded. */
  share: number;
}

/**
 * The expenses per category, largest first, the categories without expenses
 * left out; after `limit`, the rest together as one line (category `''`).
 */
export function categoryBars(totals: readonly CategoryTotal[], limit = 8): CategoryBar[] {
  const spending = totals.filter((total) => total.expenses > 0).sort((a, b) => b.expenses - a.expenses);
  const all = spending.reduce((sum, total) => sum + total.expenses, 0);
  const shown: { category: string | null; expenses: number }[] = spending.slice(0, limit);
  const rest = spending.slice(limit).reduce((sum, total) => sum + total.expenses, 0);
  if (rest > 0) shown.push({ category: '', expenses: rest });
  const largest = Math.max(1, ...shown.map((item) => item.expenses));
  return shown.map((item) => ({
    category: item.category,
    expenses: item.expenses,
    percent: (item.expenses * 100) / largest,
    share: all === 0 ? 0 : Math.round((item.expenses * 100) / all),
  }));
}

/** Days since 1970-01-01, for the time axis. */
export function dayNumber(day: Day): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

export interface LinePoint {
  x: number;
  y: number;
  day: Day;
  balance: number;
}

/** The balance over time: points, the SVG path and the domain of the axis. */
export function balanceLine(points: readonly BalancePoint[], frame: Frame): { points: LinePoint[]; path: string; domain: [number, number]; y: (value: number) => number } {
  const domain = niceDomain(points.map((point) => point.balance));
  const y = scale(domain, [frame.height - frame.bottom, frame.top]);
  const first = points[0];
  const last = points[points.length - 1];
  const start = first === undefined ? 0 : dayNumber(first.day);
  const end = last === undefined ? 1 : dayNumber(last.day);
  const x = scale(start === end ? [start - 1, end + 1] : [start, end], [frame.left, frame.width - frame.right]);
  const placed = points.map((point) => ({ x: round(x(dayNumber(point.day))), y: round(y(point.balance)), day: point.day, balance: point.balance }));
  const path = placed.map((point, index) => `${index === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`).join(' ');
  return { points: placed, path, domain, y };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A few points of a long series to label on the axis: first, last and evenly between. */
export function sampleLabels<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const step = (items.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, index) => items[Math.round(index * step)]).filter((item): item is T => item !== undefined);
}
