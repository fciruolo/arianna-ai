/**
 * The days of the feasts (D-103, punto 2; D-246): a window of month-days, or
 * a movable feast counted from Easter Sunday. Everything is in the local
 * calendar of the Mac, at day precision: the hour never matters.
 */

/** A day of the calendar, month 1-12. */
export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

export type FeastDates = { from: string; to: string } | { feast: 'carnevale' | 'pasqua' };

/**
 * Easter Sunday of the Gregorian calendar (the anonymous computus of Meeus,
 * Jones and Butcher), valid for every year from 1583.
 */
export function easterSunday(year: number): CalendarDay {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

/** Days since an epoch, for the arithmetic of the windows (UTC, so no clock change moves a day). */
function serial(day: CalendarDay): number {
  return Math.round(Date.UTC(day.year, day.month - 1, day.day) / 86_400_000);
}

/**
 * The movable windows, in days from Easter Sunday, both ends included:
 * Carnevale from giovedì grasso (−52) to martedì grasso (−47), Pasqua from
 * Palm Sunday (−7) to Easter Monday (+1).
 */
export const MOVABLE: Readonly<Record<'carnevale' | 'pasqua', readonly [number, number]>> = {
  carnevale: [-52, -47],
  pasqua: [-7, 1],
};

/** Whether `today` falls in the window, ends included; `from` after `to` is a window across the new year. */
export function inWindow(dates: FeastDates, today: CalendarDay): boolean {
  if ('feast' in dates) {
    const [first, last] = MOVABLE[dates.feast];
    const offset = serial(today) - serial(easterSunday(today.year));
    return offset >= first && offset <= last;
  }
  const key = today.month * 100 + today.day;
  const value = (text: string) => {
    const [month = 0, day = 0] = text.split('-').map(Number);
    return month * 100 + day;
  };
  const [from, to] = [value(dates.from), value(dates.to)];
  return from <= to ? key >= from && key <= to : key >= from || key <= to;
}

/** How many days the window lasts in the year of `today`: the shorter feast wins when two meet. */
export function windowLength(dates: FeastDates, today: CalendarDay): number {
  if ('feast' in dates) {
    const [first, last] = MOVABLE[dates.feast];
    return last - first + 1;
  }
  const at = (text: string, year: number) => {
    const [month = 1, day = 1] = text.split('-').map(Number);
    return serial({ year, month, day });
  };
  const from = at(dates.from, today.year);
  let to = at(dates.to, today.year);
  if (to < from) to = at(dates.to, today.year + 1);
  return to - from + 1;
}

/** Today in the local calendar of the Mac. */
export function localDay(date: Date): CalendarDay {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The day the themes see (D-246): the local date, or in development the one
 * written as `YYYY-MM-DD` in ARIANNA_TODAY, to look at a feast out of season.
 * A value that is not a real day is ignored.
 */
export function themeDay(env: Readonly<Record<string, string | undefined>>, now: Date): CalendarDay {
  const match = ISO_DAY.exec(env.ARIANNA_TODAY ?? '');
  if (match !== null) {
    const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const check = new Date(Date.UTC(day.year, day.month - 1, day.day));
    if (check.getUTCFullYear() === day.year && check.getUTCMonth() === day.month - 1 && check.getUTCDate() === day.day) return day;
  }
  return localDay(now);
}

function fromSerial(value: number): CalendarDay {
  const date = new Date(value * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * The days of the window that holds `today` (D-315), both ends included, or
 * undefined when `today` is outside: a window across the new year begins in
 * the year before when `today` is in its second part.
 */
export function windowOf(dates: FeastDates, today: CalendarDay): { from: CalendarDay; to: CalendarDay } | undefined {
  if (!inWindow(dates, today)) return undefined;
  if ('feast' in dates) {
    const [first, last] = MOVABLE[dates.feast];
    const easter = serial(easterSunday(today.year));
    return { from: fromSerial(easter + first), to: fromSerial(easter + last) };
  }
  const part = (text: string): { month: number; day: number } => {
    const [month = 1, day = 1] = text.split('-').map(Number);
    return { month, day };
  };
  const from = part(dates.from);
  const to = part(dates.to);
  const across = from.month * 100 + from.day > to.month * 100 + to.day;
  const inSecondPart = across && today.month * 100 + today.day <= to.month * 100 + to.day;
  const fromYear = inSecondPart ? today.year - 1 : today.year;
  const toYear = across ? fromYear + 1 : fromYear;
  return { from: { year: fromYear, ...from }, to: { year: toYear, ...to } };
}

/** A day as `YYYY-MM-DD`. */
export function isoDay(day: CalendarDay): string {
  return `${String(day.year)}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
}
