import { ApiError } from './api.ts';
import { errorText } from './italian.ts';
import type { Label } from './types.ts';

/**
 * The section "IM" of the cardwall (D-167, I-11 tappa P4a): the Iteration
 * Meetings of a project, one file `IM-<n>.md` each, read and written by the
 * core. Pure helpers: the types of `GET /api/browse/:project/im` and
 * `GET /api/browse/:project/im/:number`, the five columns of the items, the
 * Italian words and dates, the IM chosen by default and the user's choice in
 * this browser.
 */

export type ImItemState = 'todo' | 'doing' | 'done' | 'postponed' | 'cancelled';
export const IM_ITEM_STATES: readonly ImItemState[] = ['todo', 'doing', 'done', 'postponed', 'cancelled'];

export const IM_STATE_TEXT: Record<ImItemState, string> = {
  todo: 'Da fare',
  doing: 'In corso',
  done: 'Fatto',
  postponed: 'Rimandato',
  cancelled: 'Annullato',
};

export type ImStatus = 'previsto' | 'in corso' | 'chiuso';

export const IM_STATUS_TEXT: Record<ImStatus, string> = { previsto: 'Previsto', 'in corso': 'In corso', chiuso: 'Chiuso' };

export type ImCounts = Record<ImItemState, number>;

/**
 * One IM in the list of a project. `date` and `call` are "YYYY-MM-DD HH:MM",
 * local time; `date` is null for a file written by hand without a valid `data`.
 */
export interface ImSummary {
  number: number;
  date: string | null;
  call: string | null;
  status: ImStatus;
  label: Label;
  path: string;
  counts: ImCounts;
}

export interface ImItem {
  /** The line of the file: the address of the item for a change. */
  line: number;
  state: ImItemState;
  title: string;
  part: number | null;
  card: string | null;
}

/** One IM in full; `version` goes back with every write (409 when the file changed meanwhile). */
export interface ImDetail extends Omit<ImSummary, 'counts'> {
  version: string;
  items: ImItem[];
}

/** The items by column, in the order of the file. */
export function groupItems(items: readonly ImItem[]): Record<ImItemState, ImItem[]> {
  const groups: Record<ImItemState, ImItem[]> = { todo: [], doing: [], done: [], postponed: [], cancelled: [] };
  for (const item of items) groups[item.state].push(item);
  return groups;
}

export function countItems(items: readonly ImItem[]): ImCounts {
  const counts: ImCounts = { todo: 0, doing: 0, done: 0, postponed: 0, cancelled: 0 };
  for (const item of items) counts[item.state] += 1;
  return counts;
}

/** The entry of the list for an IM just read or written: the counts follow its items. */
export function summaryOf(im: ImDetail): ImSummary {
  return { number: im.number, date: im.date, call: im.call, status: im.status, label: im.label, path: im.path, counts: countItems(im.items) };
}

/** The list with `im` in its place (added when new), ordered by number. */
export function withSummary(ims: readonly ImSummary[], im: ImDetail): ImSummary[] {
  return [...ims.filter((entry) => entry.number !== im.number), summaryOf(im)].sort((a, b) => a.number - b.number);
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/;

function parts(stamp: string): { day: string; time: string | undefined } | undefined {
  const match = STAMP.exec(stamp);
  if (match === null) return undefined;
  const [, year, month, date, hour, minute] = match;
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(date)));
  if (at.getUTCMonth() !== Number(month) - 1 || at.getUTCDate() !== Number(date)) return undefined;
  return {
    day: `${WEEKDAYS[at.getUTCDay()] ?? ''} ${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? ''}`,
    time: hour === undefined || minute === undefined ? undefined : `${hour}:${minute}`,
  };
}

export const NO_DATE_TEXT = 'senza data';

/** "2026-10-15 10:00" → "gio 15 ott, 10:00"; a stamp it does not understand stays as it is; no date → "senza data". */
export function imDateText(stamp: string | null): string {
  if (stamp === null) return NO_DATE_TEXT;
  const read = parts(stamp);
  if (read === undefined) return stamp;
  return read.time === undefined ? read.day : `${read.day}, ${read.time}`;
}

/** "2026-10-15 10:00" → "gio 15 ott"; no date → "senza data". */
export function imDayText(stamp: string | null): string {
  if (stamp === null) return NO_DATE_TEXT;
  return parts(stamp)?.day ?? stamp;
}

/** The entry of the IM menu: "IM-33 · gio 15 ott · Previsto". */
export function imOptionText(im: Pick<ImSummary, 'number' | 'date' | 'status'>): string {
  return `IM-${String(im.number)} · ${imDayText(im.date)} · ${IM_STATUS_TEXT[im.status]}`;
}

/** The moved call (D-167): "call spostata a ven 16 ott, 10:00"; nothing when it was not moved. */
export function callText(call: string | null): string | undefined {
  return call === null ? undefined : `call spostata a ${imDateText(call)}`;
}

/** The header of an IM: "IM-33 · gio 15 ott, 10:00", "IM-3 · senza data". */
export function imTitleText(im: Pick<ImSummary, 'number' | 'date'>): string {
  return `IM-${String(im.number)} · ${imDateText(im.date)}`;
}

/**
 * "Nuovo IM" asks a day and hour when the core cannot count from the last IM:
 * the project has none, or the last one (highest number) has no date.
 */
export function needsFirstDate(ims: readonly Pick<ImSummary, 'number' | 'date'>[]): boolean {
  if (ims.length === 0) return true;
  const last = ims.reduce((top, entry) => (entry.number > top.number ? entry : top));
  return last.date === null;
}

/** The IM shown at first: the first one not closed, else the last; undefined when there is none. */
export function defaultIm(ims: readonly Pick<ImSummary, 'number' | 'status'>[]): number | undefined {
  return (ims.find((im) => im.status !== 'chiuso') ?? ims.at(-1))?.number;
}

/** The IM to show: the one chosen before when it still exists, else the default. */
export function pickIm(ims: readonly Pick<ImSummary, 'number' | 'status'>[], saved: number | undefined): number | undefined {
  return saved !== undefined && ims.some((im) => im.number === saved) ? saved : defaultIm(ims);
}

/** The value of an `<input type="datetime-local">` ("2026-10-15T10:00") as the core wants it ("2026-10-15 10:00"); undefined when not valid. */
export function fromDateTimeInput(value: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (match === null) return undefined;
  const stamp = `${match[1] ?? ''} ${match[2] ?? ''}`;
  if (parts(stamp) === undefined) return undefined;
  const [hour, minute] = (match[2] ?? '').split(':').map(Number);
  return hour !== undefined && minute !== undefined && hour < 24 && minute < 60 ? stamp : undefined;
}

export const IM_CHANGED_TEXT = 'L’IM è cambiato nel file: ricaricato';

/** The file changed on disk since it was read (edited in Obsidian, for example): read it again. */
export function isStale(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409;
}

export function imErrorText(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404) return 'Questo IM non c’è più: ricarica la pagina.';
  return errorText(cause);
}

// The user's choice, a convenience of this browser (localStorage): the project, and the IM chosen in each project.
const KEY = 'arianna.cardwall.im';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ImPrefs {
  project: string | null;
  ims: Record<string, number>;
}

const PROJECT = /^[A-Za-z0-9._-]{1,120}$/;

export function loadImPrefs(storage: StorageLike | undefined): ImPrefs {
  const prefs: ImPrefs = { project: null, ims: {} };
  try {
    const raw = storage?.getItem(KEY);
    if (raw === null || raw === undefined) return prefs;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return prefs;
    const saved = value as Record<string, unknown>;
    if (typeof saved.project === 'string' && PROJECT.test(saved.project)) prefs.project = saved.project;
    if (typeof saved.ims === 'object' && saved.ims !== null) {
      for (const [project, number] of Object.entries(saved.ims as Record<string, unknown>)) {
        if (PROJECT.test(project) && typeof number === 'number' && Number.isSafeInteger(number) && number > 0) prefs.ims[project] = number;
      }
    }
    return prefs;
  } catch {
    return { project: null, ims: {} };
  }
}

export function saveImPrefs(storage: StorageLike | undefined, prefs: ImPrefs): void {
  try {
    storage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private window or blocked storage: the choice lasts until the page closes.
  }
}
