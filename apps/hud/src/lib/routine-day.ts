/**
 * The day view of the routines on a phone (D-293): the strip of the seven
 * days of the week, to tap, and the chosen day as a line of time, one card
 * per run. Pure helpers: the tests need no browser.
 */
import { blockLook, outcomeOf, type CalendarDay, type CalendarEntry } from './routine-calendar.ts';
import type { IsoDay, Routine } from './routines.ts';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const LETTERS: Record<IsoDay, string> = { 1: 'LUN', 2: 'MAR', 3: 'MER', 4: 'GIO', 5: 'VEN', 6: 'SAB', 7: 'DOM' };

function parts(date: string): { year: number; month: number; day: number } {
  const match = DATE.exec(date);
  if (match === null) throw new Error(`not a date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** One day of the strip. */
export interface StripDay {
  date: string;
  /** "GIO". */
  name: string;
  /** "22". */
  number: string;
  /** At least one run of a routine on that day. */
  busy: boolean;
  chosen: boolean;
  today: boolean;
}

/** The seven days of the strip, with a dot for the days that have a routine. */
export function weekStrip(days: readonly CalendarDay[], entries: readonly CalendarEntry[], chosen: string, today: string): StripDay[] {
  const busy = new Set(entries.map((entry) => entry.date));
  return days.map((day) => ({
    date: day.date,
    name: LETTERS[day.isoDay],
    number: String(parts(day.date).day),
    busy: busy.has(day.date),
    chosen: day.date === chosen,
    today: day.date === today,
  }));
}

/** "Ottobre 2026"; a week across two months "Settembre - ottobre 2026", across two years with both years. */
export function monthTitle(from: string, lastDay: string): string {
  const first = parts(from);
  const last = parts(lastDay);
  const name = (month: number): string => MONTHS[month - 1] ?? '';
  if (first.year !== last.year) return `${name(first.month)} ${String(first.year)} - ${name(last.month).toLowerCase()} ${String(last.year)}`;
  if (first.month !== last.month) return `${name(first.month)} - ${name(last.month).toLowerCase()} ${String(last.year)}`;
  return `${name(first.month)} ${String(first.year)}`;
}

/** How a card of the line looks: its dot and the word of its state. */
export type DayTone = 'done' | 'failed' | 'skipped' | 'next' | 'proposed' | 'paused' | 'missed' | 'planned';

export interface DayItem {
  entry: CalendarEntry;
  routine: Routine | undefined;
  title: string;
  tone: DayTone;
  /** "fatta", "da approvare", "prossima"…; empty for a run still to come that is not the next one. */
  state: string;
}

const STATE: Record<DayTone, string> = {
  done: 'fatta',
  failed: 'fallita',
  skipped: 'saltata',
  next: 'prossima',
  proposed: 'da approvare',
  paused: 'in pausa',
  missed: 'non eseguita',
  planned: '',
};

/**
 * The runs of one day in time order. The first run still to come of an
 * active routine is «prossima» (only on today: another day has no next one);
 * a proposed routine says «da approvare», a paused one «in pausa», a run
 * already written its outcome.
 */
export function dayLine(entries: readonly CalendarEntry[], date: string, routines: ReadonlyMap<string, Routine>, now: Date, today: string): DayItem[] {
  const items = entries
    .filter((entry) => entry.date === date && routines.has(entry.routineId))
    .sort((a, b) => a.minute - b.minute || a.routineId.localeCompare(b.routineId));
  let nextGiven = date !== today;
  return items.map((entry) => {
    const routine = routines.get(entry.routineId);
    const look = blockLook(entry, routine, now);
    const outcome = outcomeOf(entry);
    let tone: DayTone;
    if (outcome !== null) tone = outcome;
    else if (look.status === 'proposed') tone = 'proposed';
    else if (look.status === 'paused') tone = 'paused';
    else if (look.past) tone = 'missed';
    else if (!nextGiven) {
      tone = 'next';
      nextGiven = true;
    } else tone = 'planned';
    return { entry, routine, title: routine?.title ?? 'Routine', tone, state: STATE[tone] };
  });
}

/** The words for a screen reader on a card: "Rassegna, 07:30, fatta". */
export function dayItemText(item: Pick<DayItem, 'title' | 'state' | 'entry'>): string {
  return [item.title, item.entry.time, item.state].filter((bit) => bit !== '').join(', ');
}

export const DAY_EMPTY_TEXT = 'Nessuna routine in questo giorno.';
export const DAY_VIEW_TEXT = 'Giorno';
