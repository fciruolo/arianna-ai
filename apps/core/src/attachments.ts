import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';

/**
 * Images and files attached in the chat (D-247, idea 9 of OpenWork, the
 * user's choice): pasted with ⌘V, dropped on the field, or chosen with
 * «Allega file» of the «+» menu. Every attachment is Privato (L2) and goes
 * only into a private conversation answered on this Mac (Arianna or the
 * local model): never to Claude, Codex, the gateway towards the cloud or a
 * channel. The bytes live in data/attachments/<id>.<ext> (0600, out of git),
 * the row in message_attachments (migration 0075) says what the file is and
 * what the local model may read of it: the text of a text file at once, the
 * reading of the `vision` model for an image (orchestrator/attachment-reading.ts).
 * Events carry ids only; the name and the reading are the user's data.
 */

/** Largest image: 10 MB. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Largest text file: 256 KiB. Longer text belongs in a note of the knowledge base. */
export const MAX_TEXT_BYTES = 256 * 1024;
/** Attachments of one message at most. */
export const MAX_ATTACHMENTS = 4;
/** Longest name kept, in characters. */
export const MAX_ATTACHMENT_NAME = 200;
/** A pending attachment (pasted, never sent) is pruned after a day. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** A file younger than this is never swept: its row may still be on its way. */
const SWEEP_GRACE_MS = 60 * 1000;

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export type TextType = (typeof TEXT_TYPES)[number];
export type AttachmentType = ImageType | TextType;
export type AttachmentKind = 'image' | 'text';

const EXTENSION: Readonly<Record<AttachmentType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
};

/** A text file by the extension of its name; anything else is not a text file we take. */
const TEXT_EXTENSIONS: Readonly<Record<string, TextType>> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};

/** What the chat shows of an attachment: never its reading. */
export interface AttachmentInfo {
  id: string;
  kind: AttachmentKind;
  name: string;
  mediaType: AttachmentType;
  size: number;
}

export type AttachmentErrorCode = 'invalid' | 'too-large' | 'type' | 'not-found' | 'conflict' | 'no-vision';

export class AttachmentError extends Error {
  override name = 'AttachmentError';
  readonly code: AttachmentErrorCode;

  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The type of an image by its first bytes: PNG, JPEG, WebP or GIF; anything else (SVG included) is undefined. */
export function imageTypeOf(bytes: Uint8Array): ImageType | undefined {
  const starts = (prefix: readonly number[], at = 0): boolean => prefix.every((byte, index) => bytes[at + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  return undefined;
}

/**
 * The name as kept: the last part of a path, without control characters,
 * within MAX_ATTACHMENT_NAME; «allegato» when nothing is left.
 */
export function attachmentName(raw: string): string {
  const last = raw.split(/[/\\]/).at(-1) ?? '';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what goes
  const clean = last.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean === '' || clean === '.' || clean === '..' ? 'allegato' : clean);
  return chars.length <= MAX_ATTACHMENT_NAME ? chars.join('') : chars.slice(0, MAX_ATTACHMENT_NAME).join('');
}

/** A checked upload: what it is and, for a text file, its text. */
export interface CheckedUpload {
  kind: AttachmentKind;
  mediaType: AttachmentType;
  name: string;
  bytes: Buffer;
  /** The text of a text file (UTF-8, without a BOM); undefined for an image. */
  text?: string;
}

/**
 * An upload from the chat: `{ name, data }` with the bytes in base64. An
 * image by its first bytes (PNG, JPEG, WebP, GIF up to 10 MB), a text file by
 * the extension of its name (.txt, .md, .csv, .json up to 256 KiB) and only
 * when it is UTF-8 without NUL. Anything else is refused, SVG included.
 */
export function checkUpload(input: Record<string, unknown>): CheckedUpload {
  if (typeof input.name !== 'string') throw new AttachmentError('invalid', 'name must be a string');
  if (typeof input.data !== 'string' || input.data === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new AttachmentError('invalid', 'data must be base64');
  if (input.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new AttachmentError('too-large', 'an image is 10 MB at most');
  const bytes = Buffer.from(input.data, 'base64');
  const name = attachmentName(input.name);
  const image = imageTypeOf(bytes);
  if (image !== undefined) {
    if (bytes.length > MAX_IMAGE_BYTES) throw new AttachmentError('too-large', 'an image is 10 MB at most');
    return { kind: 'image', mediaType: image, name, bytes };
  }
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase();
  const textType = extension === undefined ? undefined : TEXT_EXTENSIONS[extension];
  if (textType === undefined) throw new AttachmentError('type', 'the file must be a PNG, JPEG, WebP or GIF image, or a .txt, .md, .csv or .json text');
  if (bytes.length > MAX_TEXT_BYTES) throw new AttachmentError('too-large', 'a text file is 256 KiB at most');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new AttachmentError('type', 'the text file is not UTF-8');
  }
  if (text.includes(String.fromCharCode(0))) throw new AttachmentError('type', 'the text file contains a NUL character');
  if (text.trim() === '') throw new AttachmentError('invalid', 'the text file is empty');
  return { kind: 'text', mediaType: textType, name, bytes, text };
}

/** data/attachments: created private, never a link. */
function folder(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error('data/attachments is not a folder');
  return dir;
}

const pathOf = (dir: string, id: string, type: AttachmentType): string => join(dir, `${id}.${EXTENSION[type]}`);

const INFO_COLUMNS = `id::text, kind, name, media_type AS "mediaType", size_bytes AS size`;

/**
 * Keeps an upload as a pending attachment: the file first (new name, O_EXCL,
 * O_NOFOLLOW, 0600), then its row; a row that does not commit takes its file
 * away. An image is refused while no model has the `vision` role: nothing
 * could read it.
 */
export async function saveAttachment(sql: Sql, dir: string, input: Record<string, unknown>, options: { vision: boolean }): Promise<AttachmentInfo> {
  const upload = checkUpload(input);
  if (upload.kind === 'image' && !options.vision) throw new AttachmentError('no-vision', 'no local model reads images: assign the vision role in the settings');
  const id = randomUUID();
  const path = pathOf(folder(dir), id, upload.mediaType);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, upload.bytes);
  } finally {
    closeSync(fd);
  }
  const sha256 = createHash('sha256').update(upload.bytes).digest('hex');
  try {
    // No event: a pending attachment belongs to no conversation yet, and «Elimina» must find every trace of one.
    const [row] = await sql<AttachmentInfo[]>`
      INSERT INTO message_attachments (id, kind, media_type, name, size_bytes, sha256, read_state, reading, read_at)
      VALUES (${id}, ${upload.kind}, ${upload.mediaType}, ${upload.name}, ${upload.bytes.length}, ${sha256},
        ${upload.kind === 'text' ? 'done' : 'pending'}, ${upload.text ?? null}, ${upload.kind === 'text' ? new Date() : null})
      RETURNING ${sql.unsafe(INFO_COLUMNS)}`;
    if (row === undefined) throw new Error('INSERT INTO message_attachments returned no row');
    return row;
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

interface FileRow {
  id: string;
  mediaType: AttachmentType;
  name: string;
  sha256: string;
}

/** The bytes of an attachment, checked: no link on the way, the bytes still those recorded. */
export async function readAttachment(sql: Queryable, dir: string, id: string): Promise<{ mediaType: AttachmentType; name: string; bytes: Buffer }> {
  const [row] = await sql<FileRow[]>`SELECT id::text, media_type AS "mediaType", name, sha256 FROM message_attachments WHERE id = ${id}`;
  if (row === undefined) throw new AttachmentError('not-found', 'attachment not found');
  let bytes: Buffer;
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error('not a folder');
    // O_NOFOLLOW: a link put in place of the file is refused at open, not followed.
    const fd = openSync(pathOf(dir, row.id, row.mediaType), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('not a file');
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new AttachmentError('not-found', 'the file of the attachment is missing');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new AttachmentError('conflict', 'the file of the attachment has changed on disk');
  return { mediaType: row.mediaType, name: row.name, bytes };
}

/** «×» on an attachment not sent yet: its row and its file go. One already sent stays with its message. */
export async function discardAttachment(sql: Sql, dir: string, id: string): Promise<void> {
  const [row] = await sql<{ mediaType: AttachmentType; bound: boolean }[]>`
    SELECT media_type AS "mediaType", message_id IS NOT NULL AS bound FROM message_attachments WHERE id = ${id}`;
  if (row === undefined) throw new AttachmentError('not-found', 'attachment not found');
  if (row.bound) throw new AttachmentError('conflict', 'the attachment was sent: it goes with its message');
  const [done] = await sql<{ discarded: boolean }[]>`SELECT message_attachment_discard(${id}::uuid) AS discarded`;
  if (done?.discarded !== true) throw new AttachmentError('conflict', 'the attachment was sent: it goes with its message');
  rmSync(pathOf(dir, id, row.mediaType), { force: true });
}

const FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|webp|gif|txt|md|csv|json)$/;

/**
 * The files of data/attachments whose row is gone (an erased conversation,
 * a pruned or discarded attachment), removed; younger ones wait, their row
 * may be on its way. Returns how many went. Only regular files with our
 * names: anything else in the folder is left alone.
 */
export async function sweepAttachmentFiles(sql: Queryable, dir: string, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return 0;
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const candidates = names.flatMap((name) => {
    const match = FILE_NAME.exec(name);
    return match?.[1] === undefined ? [] : [{ name, id: match[1] }];
  });
  if (candidates.length === 0) return 0;
  const rows = await sql<{ id: string }[]>`SELECT id::text FROM message_attachments WHERE id = ANY (${candidates.map((item) => item.id)}::uuid[])`;
  const kept = new Set(rows.map((row) => row.id));
  let removed = 0;
  for (const { name, id } of candidates) {
    if (kept.has(id)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || now - stat.mtimeMs < SWEEP_GRACE_MS) continue;
      rmSync(path, { force: true });
      removed += 1;
    } catch {
      // Gone meanwhile.
    }
  }
  return removed;
}

/** The files of the attachments of a conversation: read before «Elimina» (D-157), removed after it. */
export async function attachmentFilesOf(sql: Queryable, conversationId: string): Promise<{ id: string; mediaType: AttachmentType }[]> {
  return sql<{ id: string; mediaType: AttachmentType }[]>`
    SELECT id::text, media_type AS "mediaType" FROM message_attachments WHERE conversation_id = ${conversationId}`;
}

/** Removes these files when their row is gone; a row still there keeps its file. */
export async function removeAttachmentFiles(sql: Queryable, dir: string, files: readonly { id: string; mediaType: AttachmentType }[]): Promise<number> {
  if (files.length === 0) return 0;
  const rows = await sql<{ id: string }[]>`SELECT id::text FROM message_attachments WHERE id = ANY (${files.map((file) => file.id)}::uuid[])`;
  const kept = new Set(rows.map((row) => row.id));
  let removed = 0;
  for (const file of files) {
    if (kept.has(file.id)) continue;
    rmSync(pathOf(dir, file.id, file.mediaType), { force: true });
    removed += 1;
  }
  return removed;
}

/** data/attachments under the data folder of the installation. */
export function attachmentsDir(dataDir: string): string {
  return join(dataDir, 'attachments');
}

/** At start: the attachments pasted and never sent for a day go, and the files without a row. */
export async function pruneAttachments(sql: Sql, dir: string, now = Date.now()): Promise<{ rows: number; files: number }> {
  const [row] = await sql<{ count: number }[]>`SELECT message_attachments_prune(${new Date(now - PENDING_TTL_MS)}) AS count`;
  const files = await sweepAttachmentFiles(sql, dir, now);
  return { rows: row?.count ?? 0, files };
}

/** What decides whether a conversation takes attachments. */
export interface AttachmentTarget {
  mode: string;
  incognito: boolean;
  secretary: boolean;
  agent: string | null;
  finance: boolean;
  origin: string;
  sideOf: string | null;
}

/** The agent of «Con chi parli» that answers on the local model (LOCAL_CHAT_AGENT of conversations.ts). */
const LOCAL_ANSWERER = 'local-chat';

/**
 * Why this conversation takes no attachment, or undefined when it takes
 * them (D-247): only a private conversation of the user answered on the Mac
 * by Arianna or by the local model. Never a work conversation (Claude or
 * Codex may answer it), nor an incognito one (nothing of it may stay), nor
 * the secretary's, a side thread, a system chat, or a direct chat with an
 * agent (the Finances included): their answers take other roads.
 */
export function attachmentRefusal(target: AttachmentTarget): string | undefined {
  if (target.mode !== 'private') return 'attachments go only in a private conversation: they never leave the Mac';
  if (target.incognito) return 'attachments are off in incognito: nothing of it may stay';
  if (target.origin !== 'user' || target.secretary || target.sideOf !== null || target.finance || (target.agent !== null && target.agent !== LOCAL_ANSWERER)) {
    return 'attachments go only in a private conversation with Arianna or the local model';
  }
  return undefined;
}

/**
 * Binds the attachments to the user message that carries them, in the
 * transaction that writes it. Each must be pending (pasted, not sent yet),
 * at most MAX_ATTACHMENTS, each once; the conversation was checked by the
 * caller (attachmentRefusal) and the database checks it again (0075).
 */
export async function bindAttachments(tx: Queryable, conversationId: string, messageId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx<{ id: string }[]>`
    SELECT id::text FROM message_attachments WHERE id = ANY (${[...ids]}::uuid[]) AND message_id IS NULL FOR UPDATE`;
  if (rows.length !== ids.length) throw new AttachmentError('not-found', 'an attachment was already sent or removed: attach it again');
  await tx`UPDATE message_attachments SET message_id = ${messageId}::bigint, conversation_id = ${conversationId} WHERE id = ANY (${[...ids]}::uuid[])`;
  await appendEvent(tx, { kind: 'attachment.sent', label: 'L0', payload: { conversationId, messageId, count: ids.length } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `attachments` of a message from the wire: ids of attachments, once each, at most MAX_ATTACHMENTS. */
export function attachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string' && UUID.test(item))) {
    throw new AttachmentError('invalid', 'attachments must be ids of attachments');
  }
  const ids = value.map((item) => item.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new AttachmentError('invalid', 'an attachment is listed twice');
  if (ids.length > MAX_ATTACHMENTS) throw new AttachmentError('invalid', `a message carries ${String(MAX_ATTACHMENTS)} attachments at most`);
  return ids;
}
