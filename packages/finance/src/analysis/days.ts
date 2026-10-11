// Calendar arithmetic on `YYYY-MM-DD` days, in UTC so that no time zone or
// daylight saving change can move a day. Pure, no I/O.

import type { Day } from '../types.ts';

/** A calendar month, `YYYY-MM`. */
export type Month = string;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** True for a real calendar day written `YYYY-MM-DD` (2024-02-29 yes, 2023-02-29 no). */
export function isDay(value: string): boolean {
  const parts = DAY_PATTERN.exec(value);
  if (parts === null) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** True for a month written `YYYY-MM`. */
export function isMonth(value: string): boolean {
  const parts = MONTH_PATTERN.exec(value);
  if (parts === null) return false;
  const month = Number(parts[2]);
  return month >= 1 && month <= 12;
}

function assertDay(day: Day): void {
  if (!isDay(day)) throw new RangeError('not a calendar day (YYYY-MM-DD): ' + day);
}

function assertMonth(month: Month): void {
  if (!isMonth(month)) throw new RangeError('not a month (YYYY-MM): ' + month);
}

/** Days in a month of a year (February has 29 days in leap years). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The day as a count of days since 1970-01-01. */
export function dayIndex(day: Day): number {
  assertDay(day);
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / MS_PER_DAY;
}

/** The inverse of `dayIndex`. */
export function dayFromIndex(index: number): Day {
  return new Date(index * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Days from `from` to `to`: positive when `to` comes later. */
export function daysBetween(from: Day, to: Day): number {
  return dayIndex(to) - dayIndex(from);
}

export function addDays(day: Day, days: number): Day {
  return dayFromIndex(dayIndex(day) + days);
}

/**
 * The same day of the month `months` later, clamped to the end of a shorter
 * month: 2025-01-31 plus one month is 2025-02-28, 2024-01-31 is 2024-02-29.
 */
export function addMonths(day: Day, months: number): Day {
  assertDay(day);
  const total = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  const dayOfMonth = Math.min(Number(day.slice(8, 10)), daysInMonth(year, month));
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(dayOfMonth).padStart(2, '0');
}

/** The month a day belongs to. */
export function monthOf(day: Day): Month {
  assertDay(day);
  return day.slice(0, 7);
}

/** The month `months` later (or earlier, when negative). */
export function addMonthsToMonth(month: Month, months: number): Month {
  assertMonth(month);
  return monthOf(addMonths(month + '-01', months));
}

/** Every month from `from` to `to`, both included; empty when `to` comes first. */
export function monthsBetween(from: Month, to: Month): Month[] {
  assertMonth(from);
  assertMonth(to);
  const months: Month[] = [];
  for (let month = from; month <= to; month = addMonthsToMonth(month, 1)) months.push(month);
  return months;
}
