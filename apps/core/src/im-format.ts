/**
 * The format of an IM (Iteration Meeting, D-167): one Markdown file
 * `IM-<n>.md` per meeting in the folder IM of a project, read and written by
 * code only, never by a model. The header says number, date, status and the
 * optional moved call; the section `## Lavori` holds one item per line with
 * the checkbox of the Obsidian Tasks plugin. Every change rewrites only the
 * lines it touches: sections and lines this module does not know stay as
 * they are, so the user can keep editing the file by hand.
 */

export const IM_STATES = ['todo', 'doing', 'done', 'postponed', 'cancelled'] as const;
export type ImState = (typeof IM_STATES)[number];

export const IM_STATUSES = ['previsto', 'in corso', 'chiuso'] as const;
export type ImStatus = (typeof IM_STATUSES)[number];

/** The checkbox of each state (Obsidian Tasks): `[ ]`, `[/]`, `[x]`, `[>]`, `[-]`. */
const MARK: Record<ImState, string> = { todo: ' ', doing: '/', done: 'x', postponed: '>', cancelled: '-' };

export const MAX_ITEM_TITLE = 300;
const ITEMS_HEADING = 'Lavori';
const DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const ITEM = /^(\s*[-*] \[)(.)(\] )(.*)$/;
const CARD = /\s+#card-([0-9a-f]{8})\s*$/i;
const PART = /\s+[—–-]\s*Parte\s+(\d{1,4})\s*$/i;

export interface ImItem {
  /** The line of the item in the file, from 1. */
  line: number;
  state: ImState;
  /** The title without `— Parte N` and `#card-<id>`. */
  title: string;
  part: number | null;
  /** The first 8 hex digits of the id of the linked card, lower case (cards have uuids). */
  card: string | null;
}

export interface ParsedIm {
  number: number | null;
  /** `YYYY-MM-DD HH:MM`, local time; null when missing or not a date. */
  date: string | null;
  /** The moved call (D-167): moves only the reminder and the closing, never the date. */
  call: string | null;
  status: ImStatus;
  items: ImItem[];
  /** The text of the section `## Report` without the blank lines around it; empty when there is none (D-167, P4c). */
  report: string;
}

export class ImFormatError extends Error {
  override name = 'ImFormatError';
}

/** The number of an IM from its file name (`IM-32.md`, any case), or null. */
export function imNumberOf(fileName: string): number | null {
  const match = /^im-([1-9]\d{0,5})\.md$/i.exec(fileName);
  return match === null ? null : Number(match[1]);
}

export function imFileName(number: number): string {
  return `IM-${String(number)}.md`;
}

/** True for a valid local date `YYYY-MM-DD HH:MM`. */
export function isImDate(value: string): boolean {
  const match = DATE.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour < 24 && minute < 60;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1);
  return trimmed;
}

interface Lines {
  lines: string[];
  /** The line end the file uses: `\r\n` when it has one, else `\n`. */
  eol: string;
}

/** The lines without their ends, and the end to put back: a change touches only its lines. */
function splitLines(text: string): Lines {
  return { lines: text.split(/\r?\n/), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** True on the opening or closing line of a fenced code block. */
function isFence(line: string): boolean {
  return /^\s{0,3}(`{3}|~{3})/.test(line);
}

/** The header lines `[start, end)` between the first two `---`, when the file starts with one. */
function headerRange(lines: readonly string[]): { start: number; end: number } | null {
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return end === -1 ? null : { start: 1, end };
}

/** The lines `[start, end)` of the section `## <name>` (any letter case), or null when there is none. */
function sectionRange(lines: readonly string[], name: string): { heading: number; start: number; end: number } | null {
  const header = headerRange(lines);
  const from = header === null ? 0 : header.end + 1;
  for (let index = from; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*#*\s*$/.exec(lines[index] ?? '');
    if (match?.[1]?.toLowerCase() !== name.toLowerCase()) continue;
    // A heading inside a fenced code block does not close the section.
    let end = index + 1;
    let fenced = false;
    while (end < lines.length && (fenced || !/^#{1,2}\s/.test(lines[end] ?? ''))) {
      if (isFence(lines[end] ?? '')) fenced = !fenced;
      end += 1;
    }
    return { heading: index, start: index + 1, end };
  }
  return null;
}

/** The lines `[start, end)` of the section `## Lavori`, or null when there is none. */
function itemsRange(lines: readonly string[]): { heading: number; start: number; end: number } | null {
  return sectionRange(lines, ITEMS_HEADING);
}

function stateOf(mark: string): ImState | undefined {
  const lower = mark.toLowerCase();
  return IM_STATES.find((state) => MARK[state] === lower);
}

function parseItem(rest: string): { title: string; part: number | null; card: string | null } {
  let title = rest;
  let card: string | null = null;
  const cardMatch = CARD.exec(title);
  if (cardMatch !== null) {
    card = (cardMatch[1] ?? '').toLowerCase();
    title = title.slice(0, cardMatch.index);
  }
  let part: number | null = null;
  const partMatch = PART.exec(title);
  if (partMatch !== null) {
    part = Number(partMatch[1]);
    title = title.slice(0, partMatch.index);
  }
  return { title: title.trim(), part, card };
}

export function parseIm(text: string): ParsedIm {
  const { lines } = splitLines(text);
  const fields = new Map<string, string>();
  const header = headerRange(lines);
  if (header !== null) {
    for (const line of lines.slice(header.start, header.end)) {
      const match = /^([A-Za-z_]+)\s*:(.*)$/.exec(line);
      if (match === null) continue;
      const key = (match[1] ?? '').toLowerCase();
      const value = unquote(match[2] ?? '');
      if (!fields.has(key)) fields.set(key, value);
    }
  }
  const numberText = fields.get('im') ?? '';
  const number = /^[1-9]\d{0,5}$/.test(numberText) ? Number(numberText) : null;
  const date = fields.get('data') ?? '';
  const call = fields.get('chiamata') ?? '';
  const status = IM_STATUSES.find((value) => value === (fields.get('stato') ?? '').toLowerCase()) ?? 'previsto';

  const items: ImItem[] = [];
  const range = itemsRange(lines);
  if (range !== null) {
    for (let index = range.start; index < range.end; index += 1) {
      const match = ITEM.exec(lines[index] ?? '');
      if (match === null) continue;
      const state = stateOf(match[2] ?? '');
      // An unknown checkbox (another plugin) is left alone, not shown.
      if (state === undefined) continue;
      const item = parseItem(match[4] ?? '');
      if (item.title === '') continue;
      items.push({ line: index + 1, state, ...item });
    }
  }
  return { number, date: isImDate(date) ? date : null, call: isImDate(call) ? call : null, status, items, report: reportOf(text) };
}

/** The text with the item on `line` set to `state`; anything that is not an item there is refused. */
export function setItemState(text: string, line: number, state: ImState): string {
  if (!IM_STATES.includes(state)) throw new ImFormatError('unknown state');
  const { lines, eol } = splitLines(text);
  const item = parseIm(text).items.find((candidate) => candidate.line === line);
  if (item === undefined) throw new ImFormatError('there is no item on this line');
  const index = line - 1;
  lines[index] = (lines[index] ?? '').replace(ITEM, (_all, open: string, _mark: string, close: string, rest: string) => `${open}${MARK[state]}${close}${rest}`);
  return lines.join(eol);
}

/** One line of a title the user wrote: no control characters, not empty, at most MAX_ITEM_TITLE. */
export function checkItemTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '' || trimmed.length > MAX_ITEM_TITLE || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(trimmed)) {
    throw new ImFormatError(`the title must be one line of at most ${String(MAX_ITEM_TITLE)} characters`);
  }
  return trimmed;
}

export interface NewItem {
  title: string;
  state?: ImState;
  part?: number | null;
  card?: string | null;
}

/** The line of an item as this module writes it. */
export function itemLine(item: NewItem): string {
  const title = checkItemTitle(item.title);
  const part = item.part === undefined || item.part === null ? '' : ` — Parte ${String(item.part)}`;
  if (item.card !== undefined && item.card !== null && !/^[0-9a-f]{8}$/.test(item.card)) throw new ImFormatError('the card must be the first 8 hex digits of its id');
  const card = item.card === undefined || item.card === null ? '' : ` #card-${item.card}`;
  return `- [${MARK[item.state ?? 'todo']}] ${title}${part}${card}`;
}

/**
 * The text with one more item at the end of `## Lavori`; when the file has no
 * such section, it is added before the first other `##` section (or at the end).
 */
export function addItem(text: string, item: NewItem): string {
  const line = itemLine(item);
  const { lines, eol } = splitLines(text);
  const range = itemsRange(lines);
  if (range === null) {
    const header = headerRange(lines);
    const from = header === null ? 0 : header.end + 1;
    const at = lines.findIndex((value, index) => index >= from && /^##\s/.test(value));
    if (at === -1) {
      while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
      return [...lines, '', `## ${ITEMS_HEADING}`, '', line, ''].join(eol);
    }
    lines.splice(at, 0, `## ${ITEMS_HEADING}`, '', line, '');
    return lines.join(eol);
  }
  // After the last non-empty line of the section, so the blank line before the next section stays.
  let last = range.end - 1;
  while (last > range.heading && (lines[last] ?? '').trim() === '') last -= 1;
  const insertAt = last === range.heading ? range.heading + 1 : last + 1;
  const insert = last === range.heading ? ['', line] : [line];
  lines.splice(insertAt, 0, ...insert);
  // A section followed straight by the next heading gets its blank line back.
  const after = insertAt + insert.length;
  if (after < lines.length && /^#{1,2}\s/.test(lines[after] ?? '')) lines.splice(after, 0, '');
  return lines.join(eol);
}

const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

function parts(date: string): { year: number; month: number; day: number; time: string } {
  if (!isImDate(date)) throw new ImFormatError('the date must be YYYY-MM-DD HH:MM');
  const [day, time] = date.split(' ') as [string, string];
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  return { year, month, day: dayOfMonth, time };
}

/** "giovedì 15 ottobre 2026, 10:00", from the calendar date (no time zone involved). */
export function longDate(date: string): string {
  const { year, month, day, time } = parts(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday] ?? ''} ${String(day)} ${MONTHS[month - 1] ?? ''} ${String(year)}, ${time}`;
}

/** The date `days` later at the same time: the next IM is seven days after `data` (D-167), whatever the call. */
export function addDays(date: string, days: number): string {
  const { year, month, day, time } = parts(date);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(next.getUTCFullYear())}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())} ${time}`;
}

/** A new IM as this module writes it: header, title, `## Lavori`, `## Report`, `## Note`. */
export function newImText(number: number, date: string, items: readonly NewItem[] = []): string {
  if (!Number.isInteger(number) || number < 1 || number > 999_999) throw new ImFormatError('invalid IM number');
  const title = `# IM-${String(number)} · ${longDate(date)}`;
  const lines = ['---', `im: ${String(number)}`, `data: ${date}`, 'stato: previsto', '---', '', title, '', `## ${ITEMS_HEADING}`, ''];
  for (const item of items) lines.push(itemLine(item));
  if (items.length > 0) lines.push('');
  lines.push('## Report', '', '## Note', '');
  return lines.join('\n');
}

/** The text with the item on `line` written again as `item` (state, title, part, card), keeping its indentation. */
export function rewriteItem(text: string, line: number, item: NewItem): string {
  const { lines, eol } = splitLines(text);
  if (!parseIm(text).items.some((candidate) => candidate.line === line)) throw new ImFormatError('there is no item on this line');
  const index = line - 1;
  const indent = /^\s*/.exec(lines[index] ?? '')?.[0] ?? '';
  lines[index] = `${indent}${itemLine(item)}`;
  return lines.join(eol);
}

/** The text with the header field `stato` set (added when missing). */
export function setStatus(text: string, status: ImStatus): string {
  if (!IM_STATUSES.includes(status)) throw new ImFormatError('unknown status');
  const { lines, eol } = splitLines(text);
  const header = headerRange(lines);
  if (header === null) throw new ImFormatError('the IM has no header');
  const at = lines.findIndex((line, index) => index >= header.start && index < header.end && /^stato\s*:/i.test(line));
  if (at === -1) lines.splice(header.end, 0, `stato: ${status}`);
  else lines[at] = `stato: ${status}`;
  return lines.join(eol);
}

/** When the meeting is held: the moved call when there is one, else the date (D-167). */
export function meetingTime(im: Pick<ParsedIm, 'date' | 'call'>): string | null {
  return im.call ?? im.date;
}

/** `at` as a local `YYYY-MM-DD HH:MM`, to compare with the dates of the IM. */
export function localImDate(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * The text with `label: <label>` in the header, when it raises the label the
 * header has (none counts as the folder's): an IM that receives a private
 * item becomes private, never the other way round.
 */
export function raiseLabel(text: string, label: string, current: string): string {
  if (!/^L[0-3]$/.test(label) || label <= current) return text;
  const { lines, eol } = splitLines(text);
  const header = headerRange(lines);
  if (header === null) throw new ImFormatError('the IM has no header');
  const kept = lines.filter((line, index) => !(index >= header.start && index < header.end && /^\s*label\s*:/i.test(line)));
  kept.splice(header.start, 0, `label: ${label}`);
  return kept.join(eol);
}

const REPORT_HEADING = 'Report';
const NOTES_HEADING = 'Note';

/** The text of the section `## Report`, without the blank lines around it, with `\n` line ends; empty when there is none. */
export function reportOf(text: string): string {
  const { lines } = splitLines(text);
  const range = sectionRange(lines, REPORT_HEADING);
  if (range === null) return '';
  return lines.slice(range.start, range.end).join('\n').replace(/^\s*\n/, '').trimEnd();
}

/**
 * The text with `report` as the body of `## Report` (D-167, P4c): only the
 * lines of that section change; when the file has none, the section is
 * added before `## Note` (or at the end). The report must not hold a heading
 * of level 1 or 2 nor a fence, which would end the section or swallow the
 * next one: the caller cleans the text of a model first (cleanReport).
 */
export function setReport(text: string, report: string): string {
  const body = report.replace(/\r\n?/g, '\n').trim();
  const bodyLines = body === '' ? [] : body.split('\n');
  if (bodyLines.some((line) => /^#{1,2}(\s|$)/.test(line) || isFence(line))) throw new ImFormatError('the report must not hold headings of level 1 or 2 nor code fences');
  const { lines, eol } = splitLines(text);
  const range = sectionRange(lines, REPORT_HEADING);
  const block = bodyLines.length === 0 ? [''] : ['', ...bodyLines, ''];
  if (range !== null) {
    // The blank line before the next section stays (at the end of the file, the last line end).
    lines.splice(range.start, range.end - range.start, ...block);
    return lines.join(eol);
  }
  const notes = sectionRange(lines, NOTES_HEADING);
  if (notes !== null) {
    lines.splice(notes.heading, 0, `## ${REPORT_HEADING}`, ...block);
    return lines.join(eol);
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  return [...lines, '', `## ${REPORT_HEADING}`, ...block].join(eol);
}

/** "giovedì 15 ottobre, 10:00": the day and hour of an IM without the year, for a reminder. */
export function dayAndTime(date: string): string {
  return longDate(date).replace(/ \d{4}, /, ', ');
}
