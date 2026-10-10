import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isAtMost, labelForKbPage, labelForPath, maxLabel, type Label, type LabelRules } from '@arianna/policy';

import { CAPTURE_CHANNELS, checkCaptureUrl, isCaptureKind, linkInText, sameInbox } from './capture.ts';
import { KB_INBOX, parsePage } from './orchestrator/kb.ts';

/**
 * The notes of kb/inbox as the web chat reads them (D-086): listed by their
 * header, read one at a time, and rewritten once organized. Only plain files
 * directly in kb/inbox, never through a link, and only up to L2, the
 * clearance of the private chat.
 */
export const NOTE_STATUSES = ['new', 'organized'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** A note larger than this is not listed nor read (a capture is at most 64 KiB, organized a few more). */
export const MAX_NOTE_BYTES = 200_000;
/** Notes looked at in one listing at most. */
const MAX_LISTED = 5_000;

export type NoteErrorCode = 'invalid' | 'not-found' | 'above-clearance' | 'conflict' | 'changed' | 'unavailable';

/** Messages name fixed reasons, never note content. */
export class NoteError extends Error {
  override name = 'NoteError';
  readonly code: NoteErrorCode;

  constructor(code: NoteErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** `source: message:<id>` (D-089): a note saved from a message of the chat. */
export const MESSAGE_SOURCE = /^message:([1-9]\d{0,18})$/;
/** A whole conversation saved in the inbox (I-7, D-131). */
export const CONVERSATION_SOURCE = /^conversation:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.md$/;

/** The file name of a note, as the routes take it: no folder, no `..`, no encoding. */
export function checkNoteName(name: string): string {
  if (!NAME.test(name) || name.includes('..')) throw new NoteError('not-found', 'note not found');
  return name;
}

/** `kb/inbox/<name>` checked: the only paths the organizer takes. */
export function checkNotePath(path: string): string {
  if (!path.startsWith(`${KB_INBOX}/`)) throw new NoteError('not-found', 'note not found');
  checkNoteName(path.slice(KB_INBOX.length + 1));
  return path;
}

export function isNoteStatus(value: unknown): value is NoteStatus {
  return NOTE_STATUSES.some((status) => status === value);
}

/** The `key: value` lines of the header, lowercase keys, first occurrence; empty without a header. */
export function headerFields(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!/^---[ \t]*\n/.test(text)) return fields;
  const start = text.indexOf('\n') + 1;
  const end = text.indexOf('\n---', start - 1);
  if (end < 0) return fields;
  for (const line of text.slice(start, end).split('\n')) {
    const match = /^\s*([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    const key = match?.[1]?.toLowerCase();
    if (key !== undefined && !fields.has(key)) fields.set(key, match?.[2]?.trim() ?? '');
  }
  return fields;
}

/**
 * The body of a page exactly as it is in the file: what follows the header
 * as parsePage finds it (its closing line and the blank lines after it), with
 * no new line normalized. The whole text without a header.
 */
export function rawBody(raw: string): string {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  if (!/^---[ \t]*\r?\n/.test(text)) return text;
  const first = text.indexOf('\n') + 1;
  const end = text.indexOf('\n---', first - 1);
  if (end < 0) return text;
  const lineEnd = text.indexOf('\n', end + 4);
  if (lineEnd < 0) return '';
  let at = lineEnd + 1;
  for (;;) {
    if (text[at] === '\n') at += 1;
    else if (text[at] === '\r' && text[at + 1] === '\n') at += 2;
    else break;
  }
  return text.slice(at);
}

/** A JSON string or list as the code writes them; anything else as it is (strings) or nothing (lists). */
function jsonString(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^".*"$/.test(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jsonList(value: string | undefined): string[] {
  if (value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
}

/** The label of a page as kb reads it: its `label:` lines only raise the folder's, an invalid one is L3. */
export function noteLabel(rules: LabelRules, path: string, raw: string): Label {
  const { labels } = parsePage(raw).header;
  return labels.length === 0 ? labelForPath(rules, path) : maxLabel(...labels.map((declared) => labelForKbPage(rules, path, declared)));
}

export interface NoteSummary {
  /** Relative to ARIANNA_HOME. */
  path: string;
  name: string;
  /** From the header; null for a new note without one (the body is never listed). */
  title: string | null;
  capturedAt: string | null;
  status: string | null;
  kind: string | null;
  /** The kind given at capture (thought, link, note) once the note is organized; null before. */
  capturedKind: string | null;
  label: Label;
  tags: string[];
}

export interface Note extends NoteSummary {
  organizedAt: string | null;
  url: string | null;
  /** When the link was downloaded and summarized (D-154); null when it was not. */
  fetchedAt: string | null;
  /** Why the last download of the link failed (a code of link-fetch.ts); null otherwise. */
  fetchFailed: string | null;
  body: string;
}

function summaryOf(rules: LabelRules, path: string, raw: string): NoteSummary {
  const fields = headerFields(raw);
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    title: jsonString(fields.get('title')) ?? null,
    capturedAt: fields.get('captured_at') ?? null,
    status: fields.get('status') ?? null,
    kind: fields.get('kind') ?? null,
    capturedKind: fields.get('captured_kind') ?? null,
    label: noteLabel(rules, path, raw),
    tags: jsonList(fields.get('tags')),
  };
}

/** home/kb/inbox when it is a real folder; undefined when missing, a link or not a folder. */
function inboxIfAny(home: string): string | undefined {
  let dir = home;
  for (const segment of KB_INBOX.split('/')) {
    dir = join(dir, segment);
    try {
      if (!lstatSync(dir).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  return sameInbox(home, dir) ? dir : undefined;
}

/** The content of a note file: a plain file opened without following a link, within MAX_NOTE_BYTES. */
export function readNoteFile(home: string, path: string): string {
  checkNotePath(path);
  const dir = inboxIfAny(home);
  if (dir === undefined) throw new NoteError('not-found', 'note not found');
  const file = join(dir, path.split('/').at(-1) ?? '');
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new NoteError('not-found', 'note not found');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new NoteError('not-found', 'note not found');
    if (stat.size > MAX_NOTE_BYTES) throw new NoteError('unavailable', 'the note is too large to read');
    // Still the inbox of this home: a folder swapped for a link after the check is refused.
    if (!sameInbox(home, dir) || realpathSync(file) !== join(realpathSync(home), ...path.split('/'))) throw new NoteError('not-found', 'note not found');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface ListOptions {
  status?: NoteStatus;
  limit: number;
}

/**
 * The notes of kb/inbox, newest first (the name starts with the time of
 * capture): header fields only, never the body. Notes above L2 are counted in
 * `hidden`, without their title or tags.
 */
export function listNotes(home: string, rules: LabelRules, options: ListOptions): { notes: NoteSummary[]; hidden: number } {
  const notes: NoteSummary[] = [];
  let hidden = 0;
  const { aboveByFolder } = eachInboxNote(home, rules, (path, raw) => {
    if (notes.length >= options.limit) return false;
    const note = summaryOf(rules, path, raw);
    if (!isAtMost(note.label, 'L2')) {
      hidden += 1;
      return true;
    }
    if (options.status === undefined || note.status === options.status) notes.push(note);
    return true;
  });
  return { notes, hidden: hidden + aboveByFolder };
}

/**
 * Visits the note files of kb/inbox, newest first (the name starts with the
 * time of capture), at most MAX_LISTED: plain files only, read as
 * readNoteFile reads them. A note above L2 by its folder is never opened,
 * only counted. `visit` returns false to stop.
 */
export function eachInboxNote(home: string, rules: LabelRules, visit: (path: string, raw: string) => boolean): { aboveByFolder: number } {
  const dir = inboxIfAny(home);
  if (dir === undefined) return { aboveByFolder: 0 };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { aboveByFolder: 0 };
  }
  const names = entries
    .filter((entry) => entry.isFile() && NAME.test(entry.name) && !entry.name.includes('..'))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, MAX_LISTED);
  let aboveByFolder = 0;
  for (const name of names) {
    const path = `${KB_INBOX}/${name}`;
    // Above L2 by its folder: the file is not opened.
    if (!isAtMost(labelForPath(rules, path), 'L2')) {
      aboveByFolder += 1;
      continue;
    }
    let raw: string;
    try {
      raw = readNoteFile(home, path);
    } catch {
      continue;
    }
    if (!visit(path, raw)) break;
  }
  return { aboveByFolder };
}

/** The summary of a note file, as the listing gives it: for the search (D-089). */
export function noteSummary(rules: LabelRules, path: string, raw: string): NoteSummary {
  return summaryOf(rules, path, raw);
}

/**
 * One note of kb/inbox with its body, only up to L2. A note above L2 answers
 * as a missing one: the answer does not tell that it exists.
 */
export function readNote(home: string, rules: LabelRules, name: string): Note {
  const path = `${KB_INBOX}/${checkNoteName(name)}`;
  const refuse = () => new NoteError('not-found', 'note not found');
  // The folder label first: above it the file is not touched, existing or not.
  if (!isAtMost(labelForPath(rules, path), 'L2')) throw refuse();
  const raw = readNoteFile(home, path);
  const note = summaryOf(rules, path, raw);
  if (!isAtMost(note.label, 'L2')) throw refuse();
  const fields = headerFields(raw);
  const fetchFailed = fields.get('fetch_failed');
  return {
    ...note,
    organizedAt: fields.get('organized_at') ?? null,
    // A link pasted as a thought has no `url` in its header: the first address of its text (D-154).
    // A link for the capture or for the model, as captureOf in organize.ts.
    url: fields.get('url') ?? (fields.get('captured_kind') === 'link' || fields.get('kind') === 'link' ? (linkInText(userText(raw, fields.get('status'))) ?? null) : null),
    fetchedAt: fields.get('fetched_at') ?? null,
    fetchFailed: fetchFailed !== undefined && /^[a-z-]{1,40}$/.test(fetchFailed) ? fetchFailed : null,
    body: parsePage(raw).body,
  };
}

/**
 * The text the user wrote: the whole body of a note not organized yet, only
 * the "Testo originale" section of an organized one (never the summary the
 * model wrote, which could name another address). Empty when it is missing.
 */
function userText(raw: string, status: string | undefined): string {
  const body = parsePage(raw).body;
  if (status !== 'organized') return body;
  const heading = '## Testo originale\n';
  const at = body.startsWith(heading) ? 0 : body.indexOf(`\n${heading}`);
  return at < 0 ? '' : body.slice(at + (at === 0 ? 0 : 1) + heading.length);
}

/** The header fields of a capture kept when the note is organized, each checked again: the file may have been edited. */
export function keptCaptureFields(raw: string): { source?: string; capturedAt?: string; capturedKind?: string; url?: string } {
  const fields = headerFields(raw);
  const kept: { source?: string; capturedAt?: string; capturedKind?: string; url?: string } = {};
  const source = fields.get('source');
  const channels = CAPTURE_CHANNELS.join('|');
  if (source !== undefined && (new RegExp(`^capture:(${channels}):[A-Za-z0-9_-]{1,64}$`).test(source) || MESSAGE_SOURCE.test(source) || CONVERSATION_SOURCE.test(source))) kept.source = source;
  const capturedAt = fields.get('captured_at');
  if (capturedAt !== undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(capturedAt)) kept.capturedAt = capturedAt;
  const kind = fields.get('kind');
  if (isCaptureKind(kind)) kept.capturedKind = kind;
  const url = fields.get('url');
  if (url !== undefined) {
    try {
      kept.url = checkCaptureUrl(url);
    } catch {
      // Not an http(s) address any more: left out.
    }
  }
  return kept;
}

function remove(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/**
 * Replaces a note with `content`, only if the file is still the one read
 * (`expectedSha256` of its content): written to a new file in the same
 * folder, synced, then renamed over the note, so a crash leaves the old note
 * or the new one, never half of it. A note changed meanwhile is left as it is.
 */
export function replaceNote(home: string, path: string, content: string, expectedSha256: string): void {
  checkNotePath(path);
  const dir = inboxIfAny(home);
  if (dir === undefined) throw new NoteError('not-found', 'note not found');
  const name = path.split('/').at(-1) ?? '';
  const changed = () => new NoteError('changed', 'the note changed while it was organized');
  const current = (): string => {
    try {
      return sha256(readNoteFile(home, path));
    } catch (error) {
      if (error instanceof NoteError && error.code === 'not-found') throw changed();
      throw error;
    }
  };
  if (current() !== expectedSha256) throw changed();
  // Hidden, so kb search and the listing skip it while it exists.
  const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new NoteError('unavailable', 'cannot write the note');
  }
  let written = false;
  try {
    if (sameInbox(home, dir)) {
      writeFileSync(fd, content);
      fsyncSync(fd);
      written = true;
    }
  } catch {
    // Disk full, I/O error: the temporary file goes below.
  } finally {
    closeSync(fd);
  }
  if (!written) {
    remove(temp);
    throw new NoteError('unavailable', 'cannot write the note');
  }
  try {
    // Last look before the swap: the window left is the rename itself.
    if (current() !== expectedSha256 || !sameInbox(home, dir)) throw changed();
    renameSync(temp, join(dir, name));
  } catch (error) {
    remove(temp);
    if (error instanceof NoteError) throw error;
    throw new NoteError('unavailable', 'cannot write the note');
  }
}
