import type { WeekdayKey } from '@arianna/config';

import { localDay, weekdayOf } from './commitment-dates.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';

/**
 * The daily ticker (I-12 tappa S2, D-149): "at this local time, on these
 * days, do X once". Built for the three moments of the secretary and meant
 * for the routines of D-110 too. A schedule is a list of slots, each a key
 * and a clock time ("HH:MM", local time of this Mac), and the days they run.
 *
 * Which slot is due is computed here, without the database: the last slot of
 * today whose time has come. A slot left behind while the core was off is
 * still due until the next slot of the day begins (the last one until the
 * end of the day), then it is skipped: started at 11:00 the morning fires,
 * started at 16:00 only the afternoon does. Never a slot of yesterday.
 *
 * "Once" lives in the database (`fireOnce`): an event `schedule.fired` per
 * schedule, day and slot, written in the same transaction as the work, so a
 * restart never fires a slot twice. The ticker also remembers in memory the
 * last slot it has done today, so the database is asked once per slot and
 * run, and a slot left behind never fires after a later one.
 */
export interface DailySlot {
  key: string;
  /** "HH:MM", local time; slots are in order during the day. */
  time: string;
}

export interface DailySchedule {
  enabled: boolean;
  slots: readonly DailySlot[];
  days: readonly WeekdayKey[];
}

/** Sunday first, as Date#getDay. */
const DAY_KEYS: readonly WeekdayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function clockOf(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** The slot due at `now` (local time), or undefined: off, a day not listed, before the first slot. */
export function dueSlot(schedule: DailySchedule, now: Date): { day: string; key: string } | undefined {
  if (!schedule.enabled) return undefined;
  const day = localDay(now);
  const weekday = DAY_KEYS[weekdayOf(day)];
  if (weekday === undefined || !schedule.days.includes(weekday)) return undefined;
  const clock = clockOf(now);
  let due: DailySlot | undefined;
  for (const slot of schedule.slots) if (slot.time <= clock) due = slot;
  return due === undefined ? undefined : { day, key: due.key };
}

export interface DailyTickerOptions {
  /** Read at each tick: a change in the settings applies without a restart. */
  schedule: () => DailySchedule;
  /** The work of a due slot; it must be idempotent per day and slot (see `fireOnce`). */
  fire: (day: string, key: string) => Promise<unknown>;
  now?: () => Date;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface DailyTicker {
  start(): void;
  stop(): void;
  /** One check now; the tests call it with their own clock. */
  tick(): Promise<void>;
}

export function createDailyTicker(options: DailyTickerOptions): DailyTicker {
  const now = options.now ?? (() => new Date());
  // What this run has done today: the slots by index, so that a slot left behind never fires after a later one
  // (the times changed during the day). Forgotten at the change of day.
  let today = '';
  let reached = -1;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

  async function check(): Promise<void> {
    const schedule = options.schedule();
    const due = dueSlot(schedule, now());
    if (due === undefined) return;
    if (due.day !== today) {
      today = due.day;
      reached = -1;
    }
    const index = schedule.slots.findIndex((slot) => slot.key === due.key);
    if (index <= reached) return;
    await options.fire(due.day, due.key);
    reached = index;
  }

  function tick(): Promise<void> {
    // One check at a time: a slow database never fires the same slot twice from here.
    running ??= check()
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  return {
    start() {
      if (timer !== undefined) return;
      void tick();
      timer = setInterval(() => void tick(), options.intervalMs ?? 30_000);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}

type Json = string | number | boolean | null;

/**
 * Runs `work` once for `schedule`, `day` and `slot`, in one transaction with
 * the event `schedule.fired` (L0: names and the day, never content) that
 * remembers it. `work` returns the extra fields of that event. Returns false
 * when it had already run. Concurrent callers wait on a lock and the second
 * finds the event.
 */
export async function fireOnce(
  sql: Sql,
  target: { schedule: string; day: string; slot: string },
  work: (tx: Queryable) => Promise<Record<string, Json>>,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('arianna.schedule:' || current_schema()))`;
    const [found] = await tx<{ one: number }[]>`
      SELECT 1 AS one FROM events
      WHERE kind = 'schedule.fired' AND payload ->> 'schedule' = ${target.schedule}
        AND payload ->> 'day' = ${target.day} AND payload ->> 'slot' = ${target.slot}
      LIMIT 1`;
    if (found !== undefined) return false;
    const extra = await work(tx);
    await appendEvent(tx, { kind: 'schedule.fired', label: 'L0', payload: { ...extra, schedule: target.schedule, day: target.day, slot: target.slot } });
    return true;
  });
}
