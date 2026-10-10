import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, openSync, closeSync, writeSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import type { Label } from '@arianna/policy';

import { CardError, loadCard } from './cardwall.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';

/**
 * The card in full (I-13, D-152): body and criteria (cardwall.ts), links, a
 * checklist, attached files and the history of what happened to it. All of
 * it is the user's and stays on this machine: the web chat is local, events
 * carry ids only, and a file is a private copy in data/cards (outside git).
 * Anything the user writes here raises the card's label to L2 at least.
 */

export const MAX_LINKS = 30;
export const MAX_CHECKLIST = 50;
export const MAX_FILES = 20;
/** Largest attached file (the user's choice: 20 MB). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Most events in the history of one card. */
export const MAX_HISTORY = 100;

export interface CardLink {
  id: string;
  url: string;
  title: string | null;
  createdAt: string;
}

export interface ChecklistItem {
  id: string;
  body: string;
  done: boolean;
}

export interface CardFile {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  label: Label;
  createdAt: string;
}

/** One line of the history: what happened, from the event log (ids and names only, no text). */
export interface HistoryEntry {
  at: string;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * What an agent reported on its card (D-159): the report of the card's last
 * delegation that ended well, with the files it changed in the project; or
 * the last answer of the local model when the card ran there.
 */
export interface CardReport {
  text: string;
  label: Label;
  /** `claude`, `codex` or `local`; null when not recorded. */
  executor: string | null;
  model: string | null;
  /** Paths in the project, relative to its folder. */
  files: string[];
  at: string;
}

export interface CardDetail {
  id: string;
  title: string;
  goal: string | null;
  criteria: string | null;
  links: CardLink[];
  checklist: ChecklistItem[];
  files: CardFile[];
  history: HistoryEntry[];
  report: CardReport | null;
  /** Where the user chose the card runs, the last time it was asked (D-159); null when never. */
  executor: string | null;
}

/** The event kinds the history shows. */
const HISTORY_KINDS = ['task.created', 'task.status', 'task.blocked', 'task.unblocked', 'card.changed', 'task.retried'];

/** The report of the card's agent, from its last delegation that ended well or its last answer on the local model. */
async function reportOf(sql: Queryable, id: string): Promise<CardReport | null> {
  const [delegation] = await sql<{ text: string; label: Label; executor: string | null; model: string | null; files: { path?: unknown }[] | null; at: Date }[]>`
    SELECT result AS text, coalesce(result_label, label) AS label, executor, model, files, coalesce(ended_at, created_at) AS at
    FROM task_delegations WHERE task_id = ${id} AND status = 'ok' AND result IS NOT NULL ORDER BY step DESC, id DESC LIMIT 1`;
  const [turn] = await sql<{ text: string | null; label: Label; at: Date }[]>`
    SELECT coalesce(answer ->> 'text', answer ->> 'reason') AS text, label, created_at AS at
    FROM task_turns WHERE task_id = ${id} AND answer ->> 'action' IN ('reply', 'refuse') ORDER BY step DESC LIMIT 1`;
  const local = turn !== undefined && turn.text !== null ? { text: turn.text, label: turn.label, executor: 'local', model: null, files: [], at: turn.at } : undefined;
  const cloud =
    delegation === undefined
      ? undefined
      : {
          ...delegation,
          files: (delegation.files ?? []).map((file) => file.path).filter((path): path is string => typeof path === 'string'),
        };
  // The latest of the two: a card retried on another way shows its last work.
  const latest = cloud === undefined ? local : local === undefined || cloud.at >= local.at ? cloud : local;
  return latest === undefined ? null : { ...latest, at: latest.at.toISOString() };
}

export async function cardDetail(sql: Queryable, id: string): Promise<CardDetail> {
  const card = await loadCard(sql, id);
  const [links, checklist, files, history, report, executor] = await Promise.all([
    sql<CardLink[]>`
      SELECT id::text, url, title, created_at AS "createdAt" FROM card_links WHERE task_id = ${id} AND removed_at IS NULL ORDER BY created_at, id`,
    sql<ChecklistItem[]>`
      SELECT id::text, body, done FROM card_checklist WHERE task_id = ${id} AND removed_at IS NULL ORDER BY position, created_at, id`,
    sql<CardFile[]>`
      SELECT id::text, name, media_type AS "mediaType", size, label, created_at AS "createdAt"
      FROM card_files WHERE task_id = ${id} AND removed_at IS NULL ORDER BY created_at, id`,
    sql<{ at: Date; kind: string; payload: Record<string, unknown> }[]>`
      SELECT ts AS at, kind, payload FROM events WHERE task_id = ${id} AND kind = ANY (${HISTORY_KINDS})
      ORDER BY id DESC LIMIT ${MAX_HISTORY}`,
    reportOf(sql, id),
    sql<{ choice: string }[]>`
      SELECT choice FROM approvals WHERE task_id = ${id} AND kind = 'executor' AND state = 'approved' ORDER BY decided_at DESC, id DESC LIMIT 1`,
  ]);
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
  return {
    id: card.id,
    title: card.title,
    goal: card.goal,
    criteria: card.doneCriteria,
    links: links.map((link) => ({ ...link, createdAt: iso(link.createdAt) })),
    checklist: [...checklist],
    files: files.map((file) => ({ ...file, createdAt: iso(file.createdAt) })),
    history: history.map((entry) => ({ at: entry.at.toISOString(), kind: entry.kind, payload: entry.payload })),
    report,
    executor: executor[0]?.choice ?? null,
  };
}

/**
 * Records a change of a card. `written`: the user wrote text or attached a
 * file, which is private: the card's label goes up to L2, never down. A tick
 * or a removal writes nothing new.
 */
async function touch(tx: Queryable, id: string, payload: Record<string, string>, written = true): Promise<void> {
  await tx`UPDATE tasks SET label = CASE WHEN ${written} THEN GREATEST(label, 'L2'::privacy_label) ELSE label END, updated_at = now() WHERE id = ${id}`;
  await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload });
}

function oneLine(value: unknown, max: number, field: string, optional = false): string | null {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'string') throw new CardError('invalid', `${field} must be text`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') {
    if (optional) return null;
    throw new CardError('invalid', `${field} must not be empty`);
  }
  if (Array.from(text).length > max) throw new CardError('invalid', `${field} is longer than ${String(max)} characters`);
  return text;
}

function checkUrl(value: unknown): string {
  if (typeof value !== 'string') throw new CardError('invalid', 'url must be text');
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CardError('invalid', 'url is not a web address');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || text.length > 2000) throw new CardError('invalid', 'url is not a web address');
  return url.toString();
}

async function countOf(tx: Queryable, table: 'card_links' | 'card_checklist' | 'card_files', id: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ${tx(table)} WHERE task_id = ${id} AND removed_at IS NULL`;
  return row?.n ?? 0;
}

export async function addLink(sql: Sql, id: string, input: { url?: unknown; title?: unknown }): Promise<CardLink> {
  const url = checkUrl(input.url);
  const title = oneLine(input.title, 200, 'title', true);
  return sql.begin(async (tx) => {
    await loadCard(tx, id, true);
    if ((await countOf(tx, 'card_links', id)) >= MAX_LINKS) throw new CardError('conflict', `a card holds ${String(MAX_LINKS)} links at most`);
    const [row] = await tx<CardLink[]>`
      INSERT INTO card_links (task_id, url, title) VALUES (${id}, ${url}, ${title}) RETURNING id::text, url, title, created_at AS "createdAt"`;
    if (row === undefined) throw new Error('INSERT INTO card_links returned no row');
    await touch(tx, id, { link: 'added' });
    return { ...row, createdAt: new Date(row.createdAt).toISOString() };
  });
}

/** Takes a link, an item or a file away: it gets `removed_at`, the core never deletes (D-046). */
async function removePart(sql: Sql, table: 'card_links' | 'card_checklist' | 'card_files', id: string, partId: string, what: string): Promise<void> {
  await sql.begin(async (tx) => {
    await loadCard(tx, id, true);
    const removed = await tx`UPDATE ${tx(table)} SET removed_at = now() WHERE id = ${partId} AND task_id = ${id} AND removed_at IS NULL RETURNING id`;
    if (removed.length === 0) throw new CardError('not-found', `no such ${what}`);
    await touch(tx, id, { [what]: 'removed' }, false);
  });
}

export async function removeLink(sql: Sql, id: string, linkId: string): Promise<void> {
  await removePart(sql, 'card_links', id, linkId, 'link');
}

export async function addChecklistItem(sql: Sql, id: string, input: { body?: unknown }): Promise<ChecklistItem> {
  const body = oneLine(input.body, 300, 'body') as string;
  return sql.begin(async (tx) => {
    await loadCard(tx, id, true);
    if ((await countOf(tx, 'card_checklist', id)) >= MAX_CHECKLIST) throw new CardError('conflict', `a card holds ${String(MAX_CHECKLIST)} items at most`);
    const [row] = await tx<ChecklistItem[]>`
      INSERT INTO card_checklist (task_id, body, position)
      VALUES (${id}, ${body}, (SELECT COALESCE(max(position), 0) + 1 FROM card_checklist WHERE task_id = ${id}))
      RETURNING id::text, body, done`;
    if (row === undefined) throw new Error('INSERT INTO card_checklist returned no row');
    await touch(tx, id, { item: 'added' });
    return row;
  });
}

export async function updateChecklistItem(sql: Sql, id: string, itemId: string, input: { body?: unknown; done?: unknown }): Promise<ChecklistItem> {
  const body = 'body' in input ? (oneLine(input.body, 300, 'body') as string) : undefined;
  if ('done' in input && typeof input.done !== 'boolean') throw new CardError('invalid', 'done must be true or false');
  const done = typeof input.done === 'boolean' ? input.done : undefined;
  if (body === undefined && done === undefined) throw new CardError('invalid', 'nothing to change');
  return sql.begin(async (tx) => {
    await loadCard(tx, id, true);
    const [row] = await tx<ChecklistItem[]>`
      UPDATE card_checklist SET body = COALESCE(${body ?? null}, body), done = COALESCE(${done ?? null}::boolean, done)
      WHERE id = ${itemId} AND task_id = ${id} AND removed_at IS NULL RETURNING id::text, body, done`;
    if (row === undefined) throw new CardError('not-found', 'no such item');
    await touch(tx, id, { item: body !== undefined ? 'changed' : done === true ? 'ticked' : 'unticked' }, body !== undefined);
    return row;
  });
}

export async function removeChecklistItem(sql: Sql, id: string, itemId: string): Promise<void> {
  await removePart(sql, 'card_checklist', id, itemId, 'item');
}

/** Where the files of a card live: <dir>/<card>/<file id>, no extension, never a path the user gave. */
function fileOf(dir: string, id: string, fileId: string): string {
  return join(dir, id, fileId);
}

/**
 * Only what a browser shows safely inline under `Content-Security-Policy:
 * sandbox`; everything else is downloaded. Not a PDF: its viewer does not run
 * in a sandboxed document. The chat holds the same list (apps/hud/src/lib/cardwall.ts).
 */
export const INLINE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain'];

export function isInline(mediaType: string): boolean {
  return INLINE_TYPES.includes(mediaType);
}

function checkMediaType(value: unknown): string {
  const type = typeof value === 'string' ? value.toLowerCase().split(';')[0]?.trim() ?? '' : '';
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : 'application/octet-stream';
}

function checkName(value: unknown): string {
  const name = oneLine(value, 200, 'name') as string;
  // A name to show and to suggest on download, never a path.
  const plain = Array.from(name, (char) => (char < ' ' || char === '/' || char === '\\' ? '_' : char)).join('');
  if (plain === '.' || plain === '..') throw new CardError('invalid', 'name is not a file name');
  return plain;
}

/**
 * Attaches a file: written first (new name, O_EXCL, mode 0600, folder 0700),
 * then recorded. A file written whose row did not commit is left as an orphan
 * nobody serves; the reverse never happens.
 */
export async function addFile(sql: Sql, dir: string, id: string, input: { name?: unknown; type?: unknown; data?: unknown }): Promise<CardFile> {
  const name = checkName(input.name);
  const mediaType = checkMediaType(input.type);
  if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new CardError('invalid', 'data must be base64');
  const bytes = Buffer.from(input.data, 'base64');
  if (bytes.length > MAX_FILE_BYTES) throw new CardError('invalid', `a file is ${String(MAX_FILE_BYTES / 1024 / 1024)} MB at most`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return sql.begin(async (tx) => {
    await loadCard(tx, id, true);
    if ((await countOf(tx, 'card_files', id)) >= MAX_FILES) throw new CardError('conflict', `a card holds ${String(MAX_FILES)} files at most`);
    const fileId = randomUUID();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const folder = join(dir, id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (!lstatSync(folder).isDirectory()) throw new Error('the folder of a card is not a folder');
    const fd = openSync(fileOf(dir, id, fileId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    const [row] = await tx<CardFile[]>`
      INSERT INTO card_files (id, task_id, name, media_type, size, sha256)
      VALUES (${fileId}, ${id}, ${name}, ${mediaType}, ${bytes.length}, ${sha256})
      RETURNING id::text, name, media_type AS "mediaType", size, label, created_at AS "createdAt"`;
    if (row === undefined) throw new Error('INSERT INTO card_files returned no row');
    await touch(tx, id, { file: 'added' });
    return { ...row, createdAt: new Date(row.createdAt).toISOString() };
  });
}

/** The bytes of a file still on the card, checked against its sha256. */
export async function readCardFile(sql: Queryable, dir: string, id: string, fileId: string): Promise<{ file: CardFile; bytes: Buffer }> {
  await loadCard(sql, id);
  const [file] = await sql<(CardFile & { sha256: string })[]>`
    SELECT id::text, name, media_type AS "mediaType", size, label, created_at AS "createdAt", sha256
    FROM card_files WHERE id = ${fileId} AND task_id = ${id} AND removed_at IS NULL`;
  if (file === undefined) throw new CardError('not-found', 'no such file');
  const path = fileOf(dir, id, fileId);
  let bytes: Buffer;
  try {
    // Neither the folder of the card nor the file may be a link.
    if (!lstatSync(join(dir, id)).isDirectory() || !lstatSync(path).isFile()) throw new Error('not a file');
    bytes = readFileSync(path);
  } catch {
    throw new CardError('not-found', 'the file is missing');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new CardError('conflict', 'the file has changed on disk');
  const shown: CardFile = { id: file.id, name: file.name, mediaType: file.mediaType, size: file.size, label: file.label, createdAt: new Date(file.createdAt).toISOString() };
  return { file: shown, bytes };
}

export async function removeFile(sql: Sql, id: string, fileId: string): Promise<void> {
  await removePart(sql, 'card_files', id, fileId, 'file');
}
