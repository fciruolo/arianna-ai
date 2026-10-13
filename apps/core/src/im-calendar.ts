/**
 * The calendar of the IM of a project (D-167 punto 3, P4d, D-169): the file
 * `calendario.md` in the folder IM, the only source, edited by hand in
 * Obsidian or from the tab "IM" of "Progetti". Its header says the weekday,
 * the time and every how many weeks; every new IM takes its date from it
 * (without it, seven days after the last one as before). The optional field
 * `fine` (`YYYY-MM-DD`) is the day the IM of the project end: no IM is made
 * after it (request of the user, 2026-10-10). Read and written by
 * code only: a change rewrites only its fields (`giorno`, `ora`, `ogni` or
 * `fine`), the rest of the file stays as it is. Never a price here (the folder IM is Interno).
 */

import { addDays, isImDate } from './im-format.ts';

export const CALENDAR_FILE = 'calendario.md';
export const MAX_EVERY = 12;

/** Sunday first, like `Date.getUTCDay`. */
export const CALENDAR_WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'] as const;

export interface ImCalendar {
  /** 0 = domenica … 6 = sabato. */
  weekday: number;
  /** `HH:MM`, local time. */
  time: string;
  /** Every how many weeks, 1 to MAX_EVERY. */
  every: number;
}

/** The field of the header that is missing or not valid. */
export type CalendarIssue = 'giorno' | 'ora' | 'ogni' | 'fine' | 'intestazione';

export interface ParsedCalendar {
  calendar: ImCalendar | null;
  /** The first field that is wrong; null when the calendar is fine. */
  issue: CalendarIssue | null;
  /** The last day of the IM (`YYYY-MM-DD`), when the file says one. */
  end: string | null;
}

export class ImCalendarError extends Error {
  override name = 'ImCalendarError';
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function fold(value: string): string {
  // "lunedi", "Lunedì", "LUNEDÌ" all name Monday.
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export function weekdayOf(name: string): number | null {
  const index = CALENDAR_WEEKDAYS.findIndex((day) => fold(day) === fold(name));
  return index === -1 ? null : index;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1).trim();
  return trimmed;
}

/** The header lines `[start, end)` between the first two `---`, when the file starts with one. */
function headerRange(lines: readonly string[]): { start: number; end: number } | null {
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return end === -1 ? null : { start: 1, end };
}

/** True for a valid day `YYYY-MM-DD`. */
export function isDay(value: string): boolean {
  return isImDate(`${value} 00:00`);
}

function headerFields(lines: readonly string[]): Map<string, string> | null {
  const header = headerRange(lines);
  if (header === null) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(header.start, header.end)) {
    const match = /^([A-Za-z_]+)\s*:(.*)$/.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? '').toLowerCase();
    if (!fields.has(key)) fields.set(key, unquote(match[2] ?? ''));
  }
  return fields;
}

/** The calendar of the file and its last day; the first field that is wrong, if any (`fine` alone is a valid file). */
export function parseCalendar(text: string): ParsedCalendar {
  const fields = headerFields(text.split(/\r?\n/));
  if (fields === null) return { calendar: null, issue: 'intestazione', end: null };
  const endText = fields.get('fine') ?? '';
  const end = isDay(endText) ? endText : null;
  const endIssue: CalendarIssue | null = endText !== '' && end === null ? 'fine' : null;
  // Only the end: no calendar, nothing wrong.
  if (!fields.has('giorno') && !fields.has('ora') && !fields.has('ogni')) return { calendar: null, issue: endIssue, end };
  const weekday = weekdayOf(fields.get('giorno') ?? '');
  if (weekday === null) return { calendar: null, issue: 'giorno', end };
  const time = fields.get('ora') ?? '';
  if (!TIME.test(time)) return { calendar: null, issue: 'ora', end };
  // "ogni" may be left out: every week.
  const everyText = fields.get('ogni') ?? '1';
  const every = /^\d{1,2}$/.test(everyText) ? Number(everyText) : NaN;
  if (!(every >= 1 && every <= MAX_EVERY)) return { calendar: null, issue: 'ogni', end };
  return { calendar: { weekday, time, every }, issue: endIssue, end };
}

/** True when the meeting `date` (`YYYY-MM-DD HH:MM`) falls after the last day of the IM. */
export function afterEnd(date: string, end: string | null): boolean {
  return end !== null && date.slice(0, 10) > end;
}

/** The text with `fine: <end>` in the header, or without it (null); a file without header gets one. */
export function setEnd(text: string, end: string | null): string {
  if (end !== null && !isDay(end)) throw new ImCalendarError('the end must be YYYY-MM-DD');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const header = headerRange(lines);
  const line = end === null ? [] : [`fine: ${end}`];
  if (header === null) {
    if (end === null) return text;
    const body = text.trim() === '' ? [''] : ['', ...lines];
    return ['---', ...line, '---', ...body].join(eol);
  }
  const kept = lines.slice(header.start, header.end).filter((value) => !/^\s*fine\s*:/i.test(value));
  return [lines[0] ?? '---', ...kept, ...line, ...lines.slice(header.end)].join(eol);
}

export function checkCalendar(calendar: ImCalendar): ImCalendar {
  if (!Number.isInteger(calendar.weekday) || calendar.weekday < 0 || calendar.weekday > 6) throw new ImCalendarError('the weekday must be 0 to 6');
  if (!TIME.test(calendar.time)) throw new ImCalendarError('the time must be HH:MM');
  if (!Number.isInteger(calendar.every) || calendar.every < 1 || calendar.every > MAX_EVERY) throw new ImCalendarError(`every must be 1 to ${String(MAX_EVERY)} weeks`);
  return calendar;
}

function fieldLines(calendar: ImCalendar): string[] {
  return [`giorno: ${CALENDAR_WEEKDAYS[calendar.weekday] ?? ''}`, `ora: ${calendar.time}`, `ogni: ${String(calendar.every)}`];
}

/** A new calendar file: the header and a line that says what it is for. */
export function newCalendarText(calendar: ImCalendar): string {
  checkCalendar(calendar);
  return [
    '---',
    ...fieldLines(calendar),
    '---',
    '',
    '# Calendario degli IM',
    '',
    'Ogni IM nuovo di questo progetto prende la data da qui: `giorno` della settimana, `ora` e `ogni` quante settimane. Si cambia qui o dalla scheda IM della pagina Progetti.',
    '',
  ].join('\n');
}

/** The text with the three fields written again; the other lines of the header and the body stay. */
export function setCalendar(text: string, calendar: ImCalendar): string {
  checkCalendar(calendar);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const header = headerRange(lines);
  if (header === null) {
    const body = text.trim() === '' ? [] : ['', ...lines];
    return ['---', ...fieldLines(calendar), '---', ...body].join(eol);
  }
  const ours = /^\s*(giorno|ora|ogni)\s*:/i;
  const kept = lines.slice(header.start, header.end).filter((line) => !ours.test(line));
  return [lines[0] ?? '---', ...fieldLines(calendar), ...kept, ...lines.slice(header.end)].join(eol);
}

function weekdayOfDay(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

/** Days from Monday: an Italian week starts on Monday. */
const fromMonday = (weekday: number): number => (weekday + 6) % 7;

/**
 * The date of the IM after one held on `last` (`YYYY-MM-DD HH:MM`): the
 * weekday of the calendar in the week (Monday to Sunday) `every` weeks after
 * the week of `last`, at its time. With the same weekday, exactly `every`
 * weeks later; a weekday changed in the calendar stays in that week, so two
 * IM are never in the same week.
 */
export function nextCalendarDate(last: string, calendar: ImCalendar): string {
  if (!isImDate(last)) throw new ImCalendarError('the date must be YYYY-MM-DD HH:MM');
  checkCalendar(calendar);
  const day = last.slice(0, 10);
  const offset = 7 * calendar.every - fromMonday(weekdayOfDay(day)) + fromMonday(calendar.weekday);
  return addDays(`${day} ${calendar.time}`, offset);
}

/** The first meeting of the calendar at `floor` or after it: for the first IM of a project. */
export function firstCalendarDate(floor: string, calendar: ImCalendar): string {
  if (!isImDate(floor)) throw new ImCalendarError('the date must be YYYY-MM-DD HH:MM');
  checkCalendar(calendar);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = addDays(`${floor.slice(0, 10)} ${calendar.time}`, offset);
    if (weekdayOfDay(candidate.slice(0, 10)) === calendar.weekday && candidate >= floor) return candidate;
  }
  throw new ImCalendarError('no day of the calendar');
}
