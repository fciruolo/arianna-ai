/**
 * The calendar of the routines (D-257, idea 5 of OpenWork): pure helpers of
 * the view «Calendario» of the page «Routine». The times of the routines come
 * from the core (GET /api/routines/calendar, computed with the zone of each
 * routine as the ticker does); here only the days of the week, the place of
 * each block on the wall clock and the words. The tests need no browser.
 */
import { DAY_LETTERS, emptyForm, type IsoDay, type Routine, type RoutineForm, type RoutineStatus, type RunReason, type RunStatus } from './routines.ts';

export interface CalendarDay {
  date: string;
  isoDay: IsoDay;
}

/** One time of a routine as the core gives it (dates as text). */
export interface CalendarEntry {
  routineId: string;
  at: string;
  date: string;
  time: string;
  minute: number;
  run: { status: RunStatus; reason: RunReason | null; trigger: 'schedule' | 'manual' } | null;
  planned: boolean;
}

export interface CalendarWeek {
  timezone: string;
  from: string;
  to: string;
  days: CalendarDay[];
  entries: CalendarEntry[];
}

export type RoutinesView = 'list' | 'calendar';
export const VIEW_KEY = 'arianna.routines.view';
export const VIEW_LIST_TEXT = 'Elenco';
export const VIEW_CALENDAR_TEXT = 'Calendario';
export const TODAY_TEXT = 'Oggi';
export const CALENDAR_LOAD_ERROR = 'Non riesco a leggere il calendario delle routine.';
export const CALENDAR_HINT = 'Clic su un’ora libera: una routine nuova a quell’ora. Clic su un blocco: la modifichi.';

/** How tall a block is, in minutes of the grid: a routine has a time, not a length. */
export const BLOCK_MINUTES = 30;
/** The hour the grid opens on; the hours before stay a scroll away. */
export const FIRST_VISIBLE_HOUR = 6;
export const HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour);

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const SHORT: Record<IsoDay, string> = { 1: 'lun', 2: 'mar', 3: 'mer', 4: 'gio', 5: 'ven', 6: 'sab', 7: 'dom' };

function parts(date: string): { year: number; month: number; day: number } {
  const match = DATE.exec(date);
  if (match === null) throw new Error(`not a date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function text(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** The day `days` after `date` (before, when negative), as a calendar date: no clock involved. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parts(date);
  return text(new Date(Date.UTC(year, month - 1, day + days)));
}

export function isoDayOf(date: string): IsoDay {
  const { year, month, day } = parts(date);
  const sunday0 = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (sunday0 === 0 ? 7 : sunday0) as IsoDay;
}

/** The Monday of the week of `date`. */
export function mondayOf(date: string): string {
  return addDays(date, 1 - isoDayOf(date));
}

/** The days to ask the core for: the week of `anchor`, Monday to the next Monday (excluded). */
export function weekRange(anchor: string): { from: string; to: string } {
  const from = mondayOf(anchor);
  return { from, to: addDays(from, 7) };
}

/** Today and the minute of the wall clock in `timezone` at `now`: the line of the current hour. */
export function nowIn(timezone: string, now: Date): { date: string; minute: number } {
  let found: Record<string, number>;
  try {
    const format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    found = Object.fromEntries(format.formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  } catch {
    found = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), minute: now.getMinutes() };
  }
  const date = `${String(found.year ?? 1970).padStart(4, '0')}-${String(found.month ?? 1).padStart(2, '0')}-${String(found.day ?? 1).padStart(2, '0')}`;
  return { date, minute: ((found.hour ?? 0) % 24) * 60 + (found.minute ?? 0) };
}

/** The anchor after an arrow: a week on a wide screen, a day on a phone. */
export function stepAnchor(anchor: string, direction: -1 | 1, narrow: boolean): string {
  return addDays(anchor, direction * (narrow ? 1 : 7));
}

/** The columns drawn: the whole week, or only the anchor's day on a phone. */
export function visibleDays(days: readonly CalendarDay[], anchor: string, narrow: boolean): CalendarDay[] {
  if (!narrow) return [...days];
  const day = days.find((item) => item.date === anchor);
  return day === undefined ? [{ date: anchor, isoDay: isoDayOf(anchor) }] : [day];
}

/** "12-18 ottobre 2026", "28 settembre - 4 ottobre 2026", "29 dicembre 2025 - 4 gennaio 2026". */
export function weekTitle(from: string, to: string): string {
  const first = parts(from);
  const last = parts(addDays(to, -1));
  const month = (value: { month: number }): string => MONTHS[value.month - 1] ?? '';
  if (first.year !== last.year) return `${String(first.day)} ${month(first)} ${String(first.year)} - ${String(last.day)} ${month(last)} ${String(last.year)}`;
  if (first.month !== last.month) return `${String(first.day)} ${month(first)} - ${String(last.day)} ${month(last)} ${String(last.year)}`;
  return `${String(first.day)}-${String(last.day)} ${month(last)} ${String(last.year)}`;
}

/** "lunedì 19 ottobre 2026": the title of the single day on a phone. */
export function dayTitle(date: string): string {
  const { year, month, day } = parts(date);
  const name = DAY_LETTERS.find((item) => item.day === isoDayOf(date))?.name ?? '';
  return `${name} ${String(day)} ${MONTHS[month - 1] ?? ''} ${String(year)}`;
}

/** "lun 19": the head of a column. */
export function dayHead(day: CalendarDay): string {
  return `${SHORT[day.isoDay]} ${String(parts(day.date).day)}`;
}

/** A block of a day: where it starts (minutes) and its lane among blocks that overlap. */
export interface DayBlock {
  entry: CalendarEntry;
  start: number;
  lane: number;
  lanes: number;
}

/**
 * The blocks of one day, side by side when they overlap (two routines at
 * 18:00, or at 18:00 and 18:15): each group of blocks that touch shares the
 * width in lanes, the first free lane to each.
 */
export function layoutDay(entries: readonly CalendarEntry[], date: string): DayBlock[] {
  const sorted = entries.filter((entry) => entry.date === date).sort((a, b) => a.minute - b.minute || a.routineId.localeCompare(b.routineId));
  const blocks: DayBlock[] = [];
  let group: DayBlock[] = [];
  let groupEnd = -1;
  const close = (): void => {
    const lanes = group.reduce((most, block) => Math.max(most, block.lane + 1), 1);
    for (const block of group) block.lanes = lanes;
    group = [];
  };
  for (const entry of sorted) {
    const start = Math.min(entry.minute, 24 * 60 - BLOCK_MINUTES);
    if (start >= groupEnd) close();
    const busy = new Set(group.filter((block) => block.start + BLOCK_MINUTES > start).map((block) => block.lane));
    let lane = 0;
    while (busy.has(lane)) lane += 1;
    const block: DayBlock = { entry, start, lane, lanes: 1 };
    group.push(block);
    blocks.push(block);
    groupEnd = Math.max(groupEnd, start + BLOCK_MINUTES);
  }
  close();
  return blocks;
}

/** The outcome of a run in one word, or null before it ran. */
export type Outcome = 'done' | 'skipped' | 'failed';

export function outcomeOf(entry: CalendarEntry): Outcome | null {
  if (entry.run === null) return null;
  if (entry.run.status === 'done') return 'done';
  if (entry.run.status === 'failed') return 'failed';
  return 'skipped';
}

export const OUTCOME_TEXT: Record<Outcome, string> = { done: 'fatta', skipped: 'saltata', failed: 'fallita' };

/** How the block looks: the state of its routine and whether its time has passed. */
export interface BlockLook {
  status: RoutineStatus;
  outcome: Outcome | null;
  past: boolean;
  trial: boolean;
}

export function blockLook(entry: CalendarEntry, routine: Pick<Routine, 'status'> | undefined, now: Date): BlockLook {
  return {
    status: routine?.status ?? 'active',
    outcome: outcomeOf(entry),
    past: new Date(entry.at).getTime() <= now.getTime(),
    trial: entry.run?.trigger === 'manual',
  };
}

/** What a block says to a screen reader and on hover: "Resoconto, 18:00, fatta" or "…, in pausa". */
export function blockText(entry: CalendarEntry, title: string, look: BlockLook): string {
  const bits = [title, entry.time];
  if (look.trial) bits.push('prova');
  if (look.outcome !== null) bits.push(OUTCOME_TEXT[look.outcome]);
  else if (look.past) bits.push('non eseguita');
  if (look.status === 'paused') bits.push('in pausa');
  if (look.status === 'proposed') bits.push('proposta, da approvare');
  return bits.join(', ');
}

/** The form of a routine born from a free hour: that day of the week, that hour. */
export function formAt(date: string, hour: number): RoutineForm {
  return { ...emptyForm(), days: [isoDayOf(date)], at: `${String(hour).padStart(2, '0')}:00` };
}

/**
 * The hour the grid opens on: 06, or earlier when the current hour (on the
 * week of today) or the first block of the columns drawn comes before, with
 * an hour of margin above; never before 00.
 */
export function startHour(nowMinute: number | null, firstBlockMinute: number | null): number {
  let hour = FIRST_VISIBLE_HOUR;
  if (nowMinute !== null) hour = Math.min(hour, Math.floor(nowMinute / 60) - 1);
  if (firstBlockMinute !== null) hour = Math.min(hour, Math.floor(firstBlockMinute / 60) - 1);
  return Math.max(0, hour);
}

/** The hour to scroll to for a block: an hour of margin above it. */
export function hourFor(minute: number): number {
  return Math.max(0, Math.floor(minute / 60) - 1);
}

/** The time of a routine to show after it is saved: its first still to come in the entries, else its first. */
export function focusEntry(entries: readonly CalendarEntry[], routineId: string, now: Date): CalendarEntry | undefined {
  const own = entries.filter((entry) => entry.routineId === routineId);
  return own.find((entry) => new Date(entry.at).getTime() >= now.getTime()) ?? own[0];
}

/** The line of the current hour, when today is among the columns drawn. */
export function nowLine(days: readonly CalendarDay[], now: { date: string; minute: number }): { column: number; minute: number } | null {
  const column = days.findIndex((day) => day.date === now.date);
  return column < 0 ? null : { column, minute: now.minute };
}

/** The view remembered in this browser; the list when nothing (or nothing readable) is there. */
export function readView(storage: Pick<Storage, 'getItem'> | undefined): RoutinesView {
  try {
    return storage?.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}

export function writeView(storage: Pick<Storage, 'setItem'> | undefined, view: RoutinesView): void {
  try {
    storage?.setItem(VIEW_KEY, view);
  } catch {
    // A private window or blocked storage: the view is simply not remembered.
  }
}
