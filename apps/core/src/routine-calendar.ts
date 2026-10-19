/**
 * The calendar of the routines (D-257, idea 5 of OpenWork): the times a
 * routine runs in a few days, placed on the wall clock of the person who
 * looks, and the runs already written with their outcome. The times come from
 * `nextRun` (routine-schedule.ts), so the calendar and the ticker agree,
 * changes of the clock included; the browser only draws them.
 *
 * Nothing new leaves the core: the calendar names routines by id only, the
 * page already has their titles from GET /api/routines.
 */
import type { Queryable } from './db/client.ts';
import { RoutineError, type RoutineStatus, type RunReason, type RunStatus } from './routines.ts';
import { instantOf, isIsoDay, isTimeZone, nextRun, systemTimeZone, wallOf, type IsoDay, type RoutineRule } from './routine-schedule.ts';

/** At most two weeks in one request: the page asks for one. */
export const CALENDAR_MAX_DAYS = 14;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400_000;
/** A time just gone of an active routine stays drawn while the ticker writes its run (it looks every 30 seconds). */
export const CALENDAR_GRACE_MS = 5 * 60_000;

export interface CalendarQuery {
  /** First local day, "YYYY-MM-DD", included. */
  from: string;
  /** Last local day, excluded. */
  to: string;
  /** The zone of the person who looks (the browser's). */
  timezone: string;
}

export interface CalendarDay {
  date: string;
  isoDay: IsoDay;
}

export interface CalendarEntry {
  routineId: string;
  /** The instant, as the ticker uses it. */
  at: Date;
  /** The local day and the wall clock in the zone of the query. */
  date: string;
  time: string;
  /** Minutes from the local midnight on the wall clock (0-1439). */
  minute: number;
  /** The run already written for this time, or null. */
  run: { status: RunStatus; reason: RunReason | null; trigger: 'schedule' | 'manual' } | null;
  /** A time of the rule as it is now; false for a run outside it (a «Prova adesso», a rule changed later). */
  planned: boolean;
}

export interface CalendarWeek {
  timezone: string;
  from: string;
  to: string;
  days: CalendarDay[];
  entries: CalendarEntry[];
}

/** A routine as the calendar needs it. */
export interface CalendarRoutine {
  id: string;
  rule: RoutineRule;
  status: RoutineStatus;
  createdAt: Date;
}

export interface CalendarRun {
  routineId: string;
  scheduledFor: Date;
  trigger: 'schedule' | 'manual';
  status: RunStatus;
  reason: RunReason | null;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseDate(value: unknown): DateParts | undefined {
  if (typeof value !== 'string') return undefined;
  const match = DATE.exec(value);
  if (match === null) return undefined;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day) return undefined;
  return parts;
}

function dateText(parts: DateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function dayNumber(parts: DateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY;
}

function isoDayOf(parts: DateParts): IsoDay {
  const sunday0 = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return (sunday0 === 0 ? 7 : sunday0) as IsoDay;
}

/** The query of GET /api/routines/calendar, checked: two days and a zone, at most two weeks apart. */
export function parseCalendarQuery(params: { from: string | null; to: string | null; timezone: string | null }): CalendarQuery {
  const from = parseDate(params.from);
  const to = parseDate(params.to);
  if (from === undefined || to === undefined) throw new RoutineError('invalid', 'from and to must be YYYY-MM-DD');
  const span = dayNumber(to) - dayNumber(from);
  if (span < 1) throw new RoutineError('invalid', 'to must come after from');
  if (span > CALENDAR_MAX_DAYS) throw new RoutineError('invalid', `at most ${String(CALENDAR_MAX_DAYS)} days`);
  const timezone = params.timezone ?? systemTimeZone();
  if (!isTimeZone(timezone)) throw new RoutineError('invalid', 'unknown time zone');
  return { from: dateText(from), to: dateText(to), timezone };
}

/** Every run of `rule` from `from` (included) to `to` (excluded), in order. */
export function occurrencesBetween(rule: RoutineRule, from: Date, to: Date): Date[] {
  const found: Date[] = [];
  let cursor = nextRun(rule, new Date(from.getTime() - 1));
  while (cursor !== undefined && cursor.getTime() < to.getTime()) {
    found.push(cursor);
    cursor = nextRun(rule, cursor);
  }
  return found;
}

/** The local midnight of `parts` in `timezone` (the end of the gap when midnight is skipped). */
function midnight(parts: DateParts, timezone: string): number {
  return instantOf({ ...parts, hour: 0, minute: 0 }, timezone);
}

function place(instant: Date, timezone: string): Pick<CalendarEntry, 'date' | 'time' | 'minute'> {
  const wall = wallOf(instant.getTime(), timezone);
  return {
    date: dateText(wall),
    time: `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`,
    minute: wall.hour * 60 + wall.minute,
  };
}

/**
 * The calendar of the days asked, pure: the times of every routine not
 * removed (paused and proposed ones too, the page draws them apart), from its
 * creation on, each with its run when there is one, and the runs that match
 * no time of the rule as it is now. Before `now` only the times that ran: the
 * rule of today drawn on the days before a change would be a past that never was.
 */
export function calendarOf(query: CalendarQuery, routines: readonly CalendarRoutine[], runs: readonly CalendarRun[], now: Date): CalendarWeek {
  const from = parseDate(query.from);
  const to = parseDate(query.to);
  if (from === undefined || to === undefined) throw new RoutineError('invalid', 'from and to must be YYYY-MM-DD');
  const days: CalendarDay[] = [];
  for (let cursor = from; dayNumber(cursor) < dayNumber(to); cursor = addDays(cursor, 1)) days.push({ date: dateText(cursor), isoDay: isoDayOf(cursor) });
  const start = midnight(from, query.timezone);
  const end = midnight(to, query.timezone);
  const runKey = (routineId: string, instant: Date): string => `${routineId}@${String(instant.getTime())}`;
  const scheduled = new Map<string, CalendarRun>();
  for (const run of runs) if (run.trigger === 'schedule') scheduled.set(runKey(run.routineId, run.scheduledFor), run);
  const used = new Set<string>();
  const entries: CalendarEntry[] = [];
  const known = new Set<string>();
  for (const routine of routines) {
    if (routine.status === 'retired') continue;
    known.add(routine.id);
    const first = Math.max(start, routine.createdAt.getTime());
    if (first >= end) continue;
    for (const at of occurrencesBetween(routine.rule, new Date(first), new Date(end))) {
      const key = runKey(routine.id, at);
      const run = scheduled.get(key);
      // The past is what ran: a time gone by without a run is not drawn (after a change of the rule it was never its time).
      const gone = routine.status === 'active' ? now.getTime() - CALENDAR_GRACE_MS : now.getTime();
      if (run === undefined && at.getTime() <= gone) continue;
      if (run !== undefined) used.add(key);
      entries.push({ routineId: routine.id, at, ...place(at, query.timezone), run: run === undefined ? null : { status: run.status, reason: run.reason, trigger: run.trigger }, planned: true });
    }
  }
  for (const run of runs) {
    if (!known.has(run.routineId)) continue;
    const time = run.scheduledFor.getTime();
    if (time < start || time >= end) continue;
    if (run.trigger === 'schedule' && used.has(runKey(run.routineId, run.scheduledFor))) continue;
    entries.push({ routineId: run.routineId, at: run.scheduledFor, ...place(run.scheduledFor, query.timezone), run: { status: run.status, reason: run.reason, trigger: run.trigger }, planned: false });
  }
  entries.sort((a, b) => a.at.getTime() - b.at.getTime() || a.routineId.localeCompare(b.routineId));
  return { timezone: query.timezone, from: query.from, to: query.to, days, entries };
}

/** The calendar from the database: the routines of the page (not removed, their chat not erased) and their runs in the days asked. */
export async function readCalendar(sql: Queryable, query: CalendarQuery, now = new Date()): Promise<CalendarWeek> {
  const from = parseDate(query.from);
  const to = parseDate(query.to);
  if (from === undefined || to === undefined) throw new RoutineError('invalid', 'from and to must be YYYY-MM-DD');
  const start = new Date(midnight(from, query.timezone));
  const end = new Date(midnight(to, query.timezone));
  const rows = await sql<{ id: string; days: number[]; at: string; timezone: string; status: RoutineStatus; createdAt: Date }[]>`
    SELECT r.id::text, r.days::int[] AS days, r.at, r.timezone, r.status, r.created_at AS "createdAt"
    FROM routines r JOIN conversations c ON c.id = r.conversation_id
    WHERE r.status <> 'retired' AND c.purged_at IS NULL
    ORDER BY r.created_at, r.id`;
  const runs = await sql<CalendarRun[]>`
    SELECT x.routine_id::text AS "routineId", x.scheduled_for AS "scheduledFor", x.trigger, x.status, x.reason
    FROM routine_runs x JOIN routines r ON r.id = x.routine_id JOIN conversations c ON c.id = r.conversation_id
    WHERE r.status <> 'retired' AND c.purged_at IS NULL AND x.scheduled_for >= ${start} AND x.scheduled_for < ${end}
    ORDER BY x.id`;
  const routines: CalendarRoutine[] = rows.map((row) => ({
    id: row.id,
    rule: { days: row.days.filter(isIsoDay), at: row.at, timezone: row.timezone },
    status: row.status,
    createdAt: row.createdAt,
  }));
  return calendarOf(query, routines, [...runs], now);
}
