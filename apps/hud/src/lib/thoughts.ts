import { MAX_NOTE_BYTES, noteTitle } from './capture.ts';
import { groupItemsByDay, type DaySection } from './day-groups.ts';
import { matchesFilter } from './graph.ts';
import { THOUGHT_EMPTY_TEXT, THOUGHT_TOO_LARGE_TEXT } from './italian.ts';
import type { Label } from './types.ts';

/**
 * The "Pensieri" page (D-090): thoughts saved in kb/inbox (POST /api/capture)
 * and organized in the background by the local model (D-086). Pure helpers;
 * the page is components/ThoughtsPage.vue.
 */

/** A note as GET /api/notes lists it: header fields only, never the text. */
export interface NoteSummary {
  path: string;
  name: string;
  title: string | null;
  capturedAt: string | null;
  status: string | null;
  kind: string | null;
  capturedKind: string | null;
  label: Label;
  tags: string[];
}

/** A note as GET /api/notes/:name gives it, with its text. */
export interface Note extends NoteSummary {
  organizedAt: string | null;
  url: string | null;
  /** When the link was downloaded and summarized (D-154). Optional: an older core sends none. */
  fetchedAt?: string | null;
  /** Why the last download failed, a code of the core (D-154). */
  fetchFailed?: string | null;
  body: string;
}

/** "Scarica e riassumi" (D-154): a note with a link whose content is not in it yet (never downloaded, or failed). */
export function canFetch(note: Pick<Note, 'url' | 'fetchedAt'> | null): boolean {
  return note !== null && note.url !== null && (note.fetchedAt ?? null) === null;
}

/** A download asked from the panel is over: the note was organized again, or its outcome changed. */
export function fetchSettled(before: Pick<Note, 'organizedAt' | 'fetchedAt' | 'fetchFailed'>, after: Pick<Note, 'organizedAt' | 'fetchedAt' | 'fetchFailed' | 'status'>): boolean {
  if (after.status !== 'organized') return false;
  return after.organizedAt !== before.organizedAt || (after.fetchedAt ?? null) !== (before.fetchedAt ?? null) || (after.fetchFailed ?? null) !== (before.fetchFailed ?? null);
}

export interface NoteListing {
  notes: NoteSummary[];
  /** Notes above L2: counted, never shown. */
  hidden: number;
}

/** The kinds of a note: given by the organizer (organize.ts) or at capture (capture.ts). */
export const KIND_TEXT: Record<string, string> = {
  pensiero: 'Pensiero',
  idea: 'Idea',
  promemoria: 'Promemoria',
  link: 'Link',
  appunto: 'Appunto',
  thought: 'Pensiero',
  note: 'Nota',
};

export function kindText(note: Pick<NoteSummary, 'kind'>): string {
  return note.kind === null ? 'Nota' : (KIND_TEXT[note.kind] ?? note.kind);
}

/**
 * A new note not organized after this long is taken as stuck (the model
 * failed, or the core restarted): "Riordina di nuovo" appears.
 */
export const STUCK_AFTER_MS = 10 * 60 * 1000;

export type ThoughtState = 'organizing' | 'stuck' | 'organized';

/** What this page knows about a note beyond its header: re-queued at, or queueing refused. */
export interface LocalMark {
  queuedAt?: number;
  failed?: boolean;
}

/** The time a note was captured: its header, or the start of its name (`2026-10-05-081244-…`). */
export function noteDate(note: Pick<NoteSummary, 'capturedAt' | 'name'>): string | null {
  if (note.capturedAt !== null && !Number.isNaN(new Date(note.capturedAt).getTime())) return note.capturedAt;
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(note.name);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const date = new Date(y ?? 0, (mo ?? 1) - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function thoughtState(note: Pick<NoteSummary, 'status' | 'capturedAt' | 'name'>, now: number, mark: LocalMark = {}): ThoughtState {
  if (note.status === 'organized') return 'organized';
  if (mark.failed === true) return 'stuck';
  const captured = noteDate(note);
  const since = Math.max(captured === null ? 0 : new Date(captured).getTime(), mark.queuedAt ?? 0);
  return now - since < STUCK_AFTER_MS ? 'organizing' : 'stuck';
}

export type StatusFilter = 'all' | 'new' | 'organized';

/** The notes matching the text (title, #tag, kind, file name) and the status, in their order. */
export function filterThoughts(notes: readonly NoteSummary[], query: string, status: StatusFilter): NoteSummary[] {
  return notes.filter((note) => {
    if (status === 'new' && note.status === 'organized') return false;
    if (status === 'organized' && note.status !== 'organized') return false;
    return matchesFilter({ id: `${note.name} ${kindText(note)}`, title: note.title ?? '', tags: note.tags }, query);
  });
}

/** Newest first (the core lists them so), in the sections of the conversations. */
export function groupThoughts(notes: readonly NoteSummary[], now: Date): DaySection<NoteSummary>[] {
  return groupItemsByDay(notes, noteDate, now);
}

/** The title to show: the header's, or the file name without date and extension. */
export function displayTitle(note: Pick<NoteSummary, 'title' | 'name'>): string {
  const title = note.title?.trim();
  if (title !== undefined && title !== '') return title;
  return note.name.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-\d{6}-?/, '').replace(/[-_]+/g, ' ').trim() || note.name;
}

/** How long the page keeps reloading after a save, at most. */
export const POLL_LIMIT_MS = 5 * 60 * 1000;
export const POLL_EVERY_MS = 5_000;

/** True while some note is still being organized and the time cap since the last save is not over. */
export function shouldPoll(notes: readonly NoteSummary[], startedAt: number | null, now: number, marks: Readonly<Record<string, LocalMark>> = {}): boolean {
  if (startedAt === null || now - startedAt >= POLL_LIMIT_MS) return false;
  return notes.some((note) => thoughtState(note, now, marks[note.name]) === 'organizing');
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "12,3 / 64 KiB": shown once the text passes a quarter of the limit. */
export function sizeCounter(text: string): string | undefined {
  const bytes = byteLength(text);
  if (bytes < MAX_NOTE_BYTES / 4) return undefined;
  return `${(bytes / 1024).toFixed(1).replace('.', ',')} / ${String(MAX_NOTE_BYTES / 1024)} KiB`;
}

export interface ThoughtCapture {
  text: string;
  kind: 'thought';
  title?: string;
}

/** The body of POST /api/capture for a thought, or why it is not sent (in Italian). */
export function thoughtCapture(text: string): { capture: ThoughtCapture } | { error: string } {
  if (text.trim() === '') return { error: THOUGHT_EMPTY_TEXT };
  if (byteLength(text) > MAX_NOTE_BYTES) return { error: THOUGHT_TOO_LARGE_TEXT };
  const title = noteTitle(text);
  return { capture: { text, kind: 'thought', ...(title === undefined ? {} : { title }) } };
}

/** The file name of a note path (`kb/inbox/x.md` → `x.md`). */
export function noteName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

/**
 * Where a `[[wikilink]]` of a note leads: another note of kb/inbox (opened on
 * this page) or any other page of kb/ (opened in the graph, by its id there).
 */
export function wikilinkTarget(target: string): { note: string } | { graph: string } | undefined {
  let key = target.split('|')[0]?.split('#')[0]?.trim() ?? '';
  key = key.replace(/^\.\//, '').replace(/^\/+/, '');
  if (key.startsWith('kb/')) key = key.slice(3);
  if (key === '' || key.split('/').includes('..')) return undefined;
  if (!key.toLowerCase().endsWith('.md')) key += '.md';
  const inbox = /^inbox\/([^/]+)$/.exec(key);
  if (inbox?.[1] !== undefined) return { note: inbox[1] };
  return { graph: key };
}

/** The id of a note of kb/inbox in the graph of the knowledge page (D-087): relative to kb/. */
export function graphId(path: string): string {
  return path.startsWith('kb/') ? path.slice(3) : path;
}
