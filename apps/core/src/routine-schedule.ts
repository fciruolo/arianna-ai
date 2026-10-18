/**
 * When a routine runs (D-110, tappa A; D-254): days of the week, a clock time
 * and a time zone, computed here without the database and without a library
 * (Intl.DateTimeFormat of Node). Pure: the tests give their own instants.
 *
 * - A local time the day skips (the spring change of the clock, 02:30 when
 *   02:00 jumps to 03:00) runs when the clock comes back, at the end of the gap
 *   (03:00).
 * - A local time the day has twice (the autumn change, 02:30 twice) runs once,
 *   the first time.
 */

/** ISO days: 1 Monday … 7 Sunday. */
export type IsoDay = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ISO_DAYS: readonly IsoDay[] = [1, 2, 3, 4, 5, 6, 7];

export interface RoutineRule {
  /** At least one, no repeats, in any order. */
  days: readonly IsoDay[];
  /** "HH:MM", 24 hours, in `timezone`. */
  at: string;
  /** An IANA name, e.g. Europe/Rome. */
  timezone: string;
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** IANA names are letters, digits and a few signs; Intl decides whether one exists. */
const ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
const MINUTE = 60_000;
const DAY = 86_400_000;

export function isClock(value: unknown): value is string {
  return typeof value === 'string' && CLOCK.test(value);
}

export function isIsoDay(value: unknown): value is IsoDay {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;
}

/** A time zone Node knows, by its IANA name ("UTC" too). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !ZONE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The time zone of this Mac: the default of a new routine. */
export function systemTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isTimeZone(zone) ? zone : 'UTC';
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let found = formatters.get(timezone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, found);
  }
  return found;
}

/** The wall clock of `instant` in `timezone`. */
export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function wallOf(instant: number, timezone: string): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year ?? 0, month: parts.month ?? 1, day: parts.day ?? 1, hour: (parts.hour ?? 0) % 24, minute: parts.minute ?? 0 };
}

/** The wall clock read as if it were UTC, in ms: what offsets are measured against. */
function wallMs(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/** How far `timezone` is ahead of UTC at `instant`, in ms (whole minutes). */
function offsetAt(instant: number, timezone: string): number {
  const floored = Math.floor(instant / MINUTE) * MINUTE;
  return wallMs(wallOf(floored, timezone)) - floored;
}

/**
 * The instant at which the wall clock of `timezone` shows `wall`: the first
 * one when it shows it twice, the end of the gap when it never shows it.
 */
export function instantOf(wall: Wall, timezone: string): number {
  const target = wallMs(wall);
  // The offsets on either side: a change of the clock is never longer than a day.
  const before = offsetAt(target - DAY, timezone);
  const after = offsetAt(target + DAY, timezone);
  const candidates = [...new Set([target - before, target - after])]
    .filter((instant) => wallMs(wallOf(instant, timezone)) === target)
    .sort((a, b) => a - b);
  const first = candidates[0];
  if (first !== undefined) return first;
  // A gap: the first minute after the change, found between the two readings.
  let low = Math.min(target - before, target - after);
  let high = Math.max(target - before, target - after);
  while (high - low > MINUTE) {
    const middle = Math.floor((low + high) / 2 / MINUTE) * MINUTE;
    if (middle <= low || middle >= high) break;
    if (wallMs(wallOf(middle, timezone)) < target) low = middle;
    else high = middle;
  }
  return high;
}

/** ISO day of a calendar date (1 Monday … 7 Sunday). */
function isoDayOf(year: number, month: number, day: number): IsoDay {
  const sunday0 = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (sunday0 === 0 ? 7 : sunday0) as IsoDay;
}

/**
 * The first run strictly after `after`, or undefined for a rule that cannot
 * run (no day, a bad clock or zone). At most eight local days are looked at:
 * every listed day comes back within a week.
 */
export function nextRun(rule: RoutineRule, after: Date): Date | undefined {
  const match = CLOCK.exec(rule.at);
  if (match === null || rule.days.length === 0 || !isTimeZone(rule.timezone)) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const from = after.getTime();
  const today = wallOf(from, rule.timezone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!rule.days.includes(isoDayOf(year, month, day))) continue;
    const instant = instantOf({ year, month, day, hour, minute }, rule.timezone);
    if (instant > from) return new Date(instant);
  }
  return undefined;
}

/**
 * The latest run from `from` (included) up to `now` (included): what was due
 * when the core finds a routine behind, after the Mac was off. Undefined
 * when none fell in between. Only the last one counts: the days before are
 * never made up (D-110, risposta 7).
 */
export function latestDue(rule: RoutineRule, from: Date, now: Date): Date | undefined {
  if (from.getTime() > now.getTime()) return undefined;
  // Never more than a week back: older runs would be replaced by a newer one anyway.
  const start = Math.max(from.getTime(), now.getTime() - 8 * DAY);
  let last: Date | undefined;
  let cursor = nextRun(rule, new Date(start - 1));
  while (cursor !== undefined && cursor.getTime() <= now.getTime()) {
    last = cursor;
    cursor = nextRun(rule, cursor);
  }
  return last;
}

const DAY_SHORT: Record<IsoDay, string> = { 1: 'lun', 2: 'mar', 3: 'mer', 4: 'gio', 5: 'ven', 6: 'sab', 7: 'dom' };
const DAY_LONG: Record<IsoDay, string> = { 1: 'lunedì', 2: 'martedì', 3: 'mercoledì', 4: 'giovedì', 5: 'venerdì', 6: 'sabato', 7: 'domenica' };

/** The days in words: "ogni giorno", "lun-ven", "sab e dom", "lun, mer e ven". */
export function daysText(days: readonly IsoDay[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return 'ogni giorno';
  if (sorted.join() === '1,2,3,4,5') return 'lun-ven';
  if (sorted.join() === '6,7') return 'sab e dom';
  const names = sorted.map((day) => DAY_SHORT[day]);
  if (names.length === 1) return `ogni ${DAY_LONG[sorted[0] ?? 1]}`;
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1] ?? ''}`;
}

/** "lunedì 20 ottobre alle 18:00", in the zone of the routine. */
export function whenText(instant: Date, timezone: string): string {
  const wall = wallOf(instant.getTime(), timezone);
  const months = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  const day = DAY_LONG[isoDayOf(wall.year, wall.month, wall.day)];
  const clock = `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
  return `${day} ${String(wall.day)} ${months[wall.month - 1] ?? ''} alle ${clock}`;
}
