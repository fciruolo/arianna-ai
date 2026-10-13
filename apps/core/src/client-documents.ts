import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { IssueCode } from './clients-format.ts';
import { clientFolder, ClientError, loadRow, openClient } from './clients.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';

/**
 * The documents of a client (I-16 tappa C2, D-171): contracts, signed
 * quotes, NDA, orders (the legal ones, a fixed list) and other files with a
 * free type, in the private folder of the client on this machine
 * (`data/clients/<client>/documenti/<id>.<ext>`, folders 0700, files 0600).
 * The table holds name, type, project, dates and the sha256 of the bytes;
 * every read checks the hash, and neither folder nor file may be a link.
 * PDF and images are shown in the page (served sandboxed); "Apri" and
 * "Mostra nel Finder" run `open` of macOS on the file, locally. A document
 * with a due date is named in the secretary's morning message 30 days before,
 * by client and type only. Private (L2): never to the Coder, Claude, Codex or
 * Telegram, never indexed; the events carry ids and names of fields only.
 * The core never deletes (D-046): a document is archived.
 */

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_NAME = 200;
const MAX_OTHER_TYPE = 60;
export const REMINDER_DAYS = 30;

export const DOCUMENT_KINDS = ['contract', 'signed_quote', 'nda', 'order', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface ClientDocument {
  id: string;
  kind: DocumentKind;
  /** The free type of an `other` document; null for the legal ones. */
  otherType: string | null;
  name: string;
  project: string | null;
  documentOn: string | null;
  expiresOn: string | null;
  extension: string;
  mediaType: string;
  sizeBytes: number;
  /** PDF and images: shown in the page. */
  preview: boolean;
  createdAt: string;
  archivedAt: string | null;
}

/** What a file may be: by its extension, confirmed by its first bytes where it has a signature. */
interface Format {
  type: string;
  preview: boolean;
  /** The first bytes, or null for plain text (no NUL byte, valid UTF-8). */
  magic: readonly (readonly number[])[] | null;
}

const ZIP = [[0x50, 0x4b, 0x03, 0x04]] as const;
const OLE = [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]] as const;
const FORMATS: Record<string, Format> = {
  pdf: { type: 'application/pdf', preview: true, magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },
  png: { type: 'image/png', preview: true, magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  jpg: { type: 'image/jpeg', preview: true, magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { type: 'image/jpeg', preview: true, magic: [[0xff, 0xd8, 0xff]] },
  gif: { type: 'image/gif', preview: true, magic: [[0x47, 0x49, 0x46, 0x38]] },
  webp: { type: 'image/webp', preview: true, magic: [[0x52, 0x49, 0x46, 0x46]] },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', preview: false, magic: ZIP },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', preview: false, magic: ZIP },
  pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', preview: false, magic: ZIP },
  odt: { type: 'application/vnd.oasis.opendocument.text', preview: false, magic: ZIP },
  ods: { type: 'application/vnd.oasis.opendocument.spreadsheet', preview: false, magic: ZIP },
  odp: { type: 'application/vnd.oasis.opendocument.presentation', preview: false, magic: ZIP },
  doc: { type: 'application/msword', preview: false, magic: OLE },
  xls: { type: 'application/vnd.ms-excel', preview: false, magic: OLE },
  ppt: { type: 'application/vnd.ms-powerpoint', preview: false, magic: OLE },
  txt: { type: 'text/plain', preview: false, magic: null },
  csv: { type: 'text/csv', preview: false, magic: null },
  md: { type: 'text/markdown', preview: false, magic: null },
};

export const DOCUMENT_EXTENSIONS = Object.keys(FORMATS);

/** The format of a file named `name` with these bytes; undefined when the extension is unknown or the bytes say otherwise. */
export function formatOf(name: string, bytes: Uint8Array): { extension: string; type: string; preview: boolean } | undefined {
  const extension = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase();
  const format = extension === undefined ? undefined : FORMATS[extension];
  if (extension === undefined || format === undefined) return undefined;
  if (format.magic === null) {
    if (bytes.includes(0)) return undefined;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  } else if (!format.magic.some((magic) => magic.every((byte, index) => bytes[index] === byte))) {
    return undefined;
  }
  // A WebP is a RIFF with WEBP at byte 8.
  if (extension === 'webp' && String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return undefined;
  return { extension, type: format.type, preview: format.preview };
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const invalid = (field: string, code: IssueCode, message: string): ClientError => new ClientError('invalid', message, [{ field, code }]);

function checkName(value: unknown): string {
  if (typeof value !== 'string') throw invalid('name', 'type', 'the name is required');
  // A name to show and to suggest on download, never a path.
  const name = Array.from(value.trim(), (char) => (char < ' ' || char === '/' || char === '\\' || char === '\u007f' ? '_' : char)).join('');
  if (name === '' || name === '.' || name === '..') throw invalid('name', 'required', 'the name is required');
  if (name.length > MAX_NAME) throw invalid('name', 'too-long', `the name is at most ${String(MAX_NAME)} characters`);
  return name;
}

function checkKind(kind: unknown, otherType: unknown): { kind: DocumentKind; otherType: string | null } {
  const found = DOCUMENT_KINDS.find((item) => item === kind);
  if (found === undefined) throw invalid('kind', 'type', 'the kind is one of contract, signed_quote, nda, order, other');
  if (found !== 'other') {
    if (otherType !== undefined && otherType !== null && otherType !== '') throw invalid('otherType', 'type', 'only an other document has a free type');
    return { kind: found, otherType: null };
  }
  const text = typeof otherType === 'string' ? otherType.trim() : '';
  if (text === '') throw invalid('otherType', 'required', 'an other document needs its type');
  if (text.length > MAX_OTHER_TYPE || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)) throw invalid('otherType', 'too-long', `the type is one line of at most ${String(MAX_OTHER_TYPE)} characters`);
  return { kind: found, otherType: text };
}

function checkDay(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !isDay(value)) throw invalid(field, 'format', `${field} must be YYYY-MM-DD`);
  return value;
}

/** A project of the client (linked now), or none. */
async function checkProject(tx: Queryable, clientId: string, value: unknown): Promise<string | null> {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw invalid('project', 'type', 'the project must be a name');
  const [row] = await tx`SELECT 1 FROM client_projects WHERE client_id = ${clientId} AND project = ${value} AND removed_at IS NULL`;
  if (row === undefined) throw invalid('project', 'unknown', 'the project is not one of the client');
  return value;
}

interface DocumentRow extends Omit<ClientDocument, 'preview' | 'sizeBytes'> {
  sizeBytes: string;
  sha256: string;
}

const SELECT = (sql: Queryable) => sql`
  SELECT id::text, kind, other_type AS "otherType", name, project, document_on::text AS "documentOn", expires_on::text AS "expiresOn",
    extension, media_type AS "mediaType", size_bytes::text AS "sizeBytes", sha256, created_at::text AS "createdAt", archived_at::text AS "archivedAt"
  FROM client_documents`;

function documentOf(row: DocumentRow): ClientDocument {
  return {
    id: row.id,
    kind: row.kind,
    otherType: row.otherType,
    name: row.name,
    project: row.project,
    documentOn: row.documentOn,
    expiresOn: row.expiresOn,
    extension: row.extension,
    mediaType: row.mediaType,
    sizeBytes: Number(row.sizeBytes),
    preview: FORMATS[row.extension]?.preview ?? false,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

/** The documents of the client, newest first; the archived ones too (the chat filters them). */
export async function listDocuments(sql: Queryable, clientId: string): Promise<ClientDocument[]> {
  await loadRow(sql, clientId);
  const rows = await sql<DocumentRow[]>`${SELECT(sql)} WHERE client_id = ${clientId} ORDER BY created_at DESC`;
  return rows.map(documentOf);
}

async function loadDocument(sql: Queryable, clientId: string, id: string, lock = false): Promise<DocumentRow> {
  const [row] = lock
    ? await sql<DocumentRow[]>`${SELECT(sql)} WHERE id = ${id} AND client_id = ${clientId} FOR UPDATE`
    : await sql<DocumentRow[]>`${SELECT(sql)} WHERE id = ${id} AND client_id = ${clientId}`;
  if (row === undefined) throw new ClientError('not-found', 'no such document');
  return row;
}

function documentsFolder(dir: string, clientId: string): string {
  const folder = join(clientFolder(dir, clientId), 'documenti');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!lstatSync(folder).isDirectory()) throw new Error('the folder of the documents is not a folder');
  return folder;
}

const fileOf = (dir: string, clientId: string, id: string, extension: string): string => join(dir, clientId, 'documenti', `${id}.${extension}`);

/**
 * A new document from the chat, as base64: written first (new name, O_EXCL,
 * O_NOFOLLOW, 0600), then recorded; a row that does not commit takes its
 * file away.
 */
export async function addDocument(sql: Sql, dir: string, clientId: string, input: Record<string, unknown>): Promise<ClientDocument> {
  const name = checkName(input.name);
  const { kind, otherType } = checkKind(input.kind, input.otherType);
  const documentOn = checkDay(input.documentOn, 'documentOn');
  const expiresOn = checkDay(input.expiresOn, 'expiresOn');
  if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw invalid('file', 'type', 'data must be base64');
  if (input.data.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4) throw invalid('file', 'too-long', 'a document is 25 MB at most');
  const bytes = Buffer.from(input.data, 'base64');
  if (bytes.length > MAX_DOCUMENT_BYTES) throw invalid('file', 'too-long', 'a document is 25 MB at most');
  // The format from the name of the file as it was on the computer: the name shown may lose its extension.
  const format = formatOf(typeof input.fileName === 'string' ? input.fileName : name, bytes);
  if (format === undefined) throw invalid('file', 'format', `the file must be one of ${DOCUMENT_EXTENSIONS.join(', ')}, and be what its name says`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await openClient(sql, clientId);
  const id = randomUUID();
  const path = join(documentsFolder(dir, clientId), `${id}.${format.extension}`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  try {
    await sql.begin(async (tx) => {
      await openClient(tx, clientId);
      const project = await checkProject(tx, clientId, input.project);
      await tx`
        INSERT INTO client_documents (id, client_id, kind, other_type, name, project, document_on, expires_on, extension, media_type, size_bytes, sha256)
        VALUES (${id}, ${clientId}, ${kind}, ${otherType}, ${name}, ${project}, ${documentOn}, ${expiresOn}, ${format.extension}, ${format.type}, ${bytes.length}, ${sha256})`;
      await appendEvent(tx, { kind: 'client.document.added', payload: { clientId, documentId: id } });
    });
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  return documentOf(await loadDocument(sql, clientId, id));
}

const FIELDS = { name: 'name', kind: 'kind', otherType: 'other_type', project: 'project', documentOn: 'document_on', expiresOn: 'expires_on' } as const;

/** Name, type, project and dates of a document not archived; a new due date is reminded again. */
export async function updateDocument(sql: Sql, clientId: string, id: string, input: Record<string, unknown>): Promise<ClientDocument> {
  await sql.begin(async (tx) => {
    await openClient(tx, clientId);
    const row = await loadDocument(tx, clientId, id, true);
    if (row.archivedAt !== null) throw new ClientError('conflict', 'the document is archived: restore it first');
    const fields: Record<string, unknown> = {};
    if (input.name !== undefined) fields.name = checkName(input.name);
    if (input.kind !== undefined || input.otherType !== undefined) {
      // A legal kind drops the free type; an other document keeps its type unless a new one comes.
      const wanted = input.kind ?? row.kind;
      const kind = checkKind(wanted, wanted === 'other' ? (input.otherType ?? row.otherType) : input.otherType);
      fields.kind = kind.kind;
      fields.other_type = kind.otherType;
    }
    if (input.project !== undefined) fields.project = await checkProject(tx, clientId, input.project);
    if (input.documentOn !== undefined) fields.document_on = checkDay(input.documentOn, 'documentOn');
    if (input.expiresOn !== undefined) {
      fields.expires_on = checkDay(input.expiresOn, 'expiresOn');
      if (fields.expires_on !== row.expiresOn) fields.reminded_on = null;
    }
    if (Object.keys(fields).length === 0) throw new ClientError('invalid', 'nothing to change');
    await tx`UPDATE client_documents SET ${tx(fields)}, updated_at = now() WHERE id = ${id}`;
    const names = Object.entries(FIELDS).filter(([, column]) => column in fields).map(([field]) => field);
    await appendEvent(tx, { kind: 'client.document.changed', payload: { clientId, documentId: id, fields: names } });
  });
  return documentOf(await loadDocument(sql, clientId, id));
}

/** Archived out of the list (never deleted), or back. */
export async function archiveDocument(sql: Sql, clientId: string, id: string, archived: boolean): Promise<ClientDocument> {
  await sql.begin(async (tx) => {
    await openClient(tx, clientId);
    const row = await loadDocument(tx, clientId, id, true);
    if ((row.archivedAt !== null) === archived) return;
    await tx`UPDATE client_documents SET archived_at = CASE WHEN ${archived} THEN now() END, updated_at = now() WHERE id = ${id}`;
    await appendEvent(tx, { kind: archived ? 'client.document.archived' : 'client.document.restored', payload: { clientId, documentId: id } });
  });
  return documentOf(await loadDocument(sql, clientId, id));
}

/** The path of the file of a document, checked: no link on the way, the bytes still those recorded. */
async function checkedFile(sql: Queryable, dir: string, clientId: string, id: string): Promise<{ row: DocumentRow; path: string; bytes: Buffer }> {
  const row = await loadDocument(sql, clientId, id);
  const path = fileOf(dir, clientId, id, row.extension);
  let bytes: Buffer;
  try {
    for (const folder of [dir, join(dir, clientId), join(dir, clientId, 'documenti')]) if (!lstatSync(folder).isDirectory()) throw new Error('not a folder');
    // O_NOFOLLOW: a link put in place of the file after the checks above is refused at open, not followed.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('not a file');
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new ClientError('not-found', 'the file of the document is missing');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new ClientError('conflict', 'the file of the document has changed on disk');
  return { row, path, bytes };
}

export async function readDocument(sql: Queryable, dir: string, clientId: string, id: string): Promise<{ document: ClientDocument; bytes: Buffer }> {
  const { row, bytes } = await checkedFile(sql, dir, clientId, id);
  return { document: documentOf(row), bytes };
}

/** Runs `open` of macOS on a file; the second form shows it selected in the Finder. Injected in the tests. */
export type Opener = (path: string, reveal: boolean) => Promise<void>;

export const macOpener: Opener = (path, reveal) =>
  new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new ClientError('conflict', 'opening a file works on macOS only'));
      return;
    }
    // execFile, never a shell: the path is one argument.
    execFile('open', reveal ? ['-R', path] : [path], { timeout: 10_000 }, (error) => {
      if (error === null) resolve();
      else reject(new Error(`open failed: ${error.message}`));
    });
  });

/** "Apri" or "Mostra nel Finder": only a file of the client's folder, checked as for reading. */
export async function openDocument(sql: Queryable, dir: string, clientId: string, id: string, reveal: boolean, opener: Opener = macOpener): Promise<void> {
  const { path } = await checkedFile(sql, dir, clientId, id);
  await opener(path, reveal);
}

const KIND_TEXT: Record<DocumentKind, string> = { contract: 'Il contratto', signed_quote: 'Il preventivo firmato', nda: 'L’NDA', order: 'L’ordine', other: 'Il documento' };
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'] as const;

function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** "31 dicembre 2026". */
export function longDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return `${String(date)} ${MONTHS[month - 1] ?? ''} ${String(year)}`;
}

/** The line of the morning message: client and type only, never the name or the content. */
export function expiryLine(kind: DocumentKind, otherType: string | null, client: string, expiresOn: string): string {
  const what = kind === 'other' && otherType !== null ? `${KIND_TEXT.other} «${otherType}»` : KIND_TEXT[kind];
  return `${what} di ${client} scade il ${longDay(expiresOn)}.`;
}

/**
 * The documents not archived, of clients not archived, whose due date falls
 * within 30 days of `day` and that were not reminded yet, with their lines;
 * locked until `markReminded` in the transaction of the message. A document
 * raised above Privato (L2) is never named in the secretary's conversation.
 */
export async function expiringDocuments(tx: Queryable, day: string): Promise<{ id: string; text: string }[]> {
  const until = addDays(day, REMINDER_DAYS);
  const rows = await tx<{ id: string; kind: DocumentKind; otherType: string | null; client: string; expiresOn: string }[]>`
    SELECT d.id::text, d.kind, d.other_type AS "otherType", c.display_name AS client, d.expires_on::text AS "expiresOn"
    FROM client_documents d JOIN clients c ON c.id = d.client_id
    WHERE d.archived_at IS NULL AND c.status <> 'archived' AND d.reminded_on IS NULL AND d.label <= 'L2'::privacy_label
      AND d.expires_on >= ${day}::date AND d.expires_on <= ${until}::date
    ORDER BY d.expires_on, c.display_name
    FOR UPDATE OF d`;
  return rows.map((row) => ({ id: row.id, text: expiryLine(row.kind, row.otherType, row.client, row.expiresOn) }));
}

/** The documents named by the morning message of `day`: never again, unless their due date changes. */
export async function markReminded(tx: Queryable, ids: readonly string[], day: string): Promise<void> {
  if (ids.length === 0) return;
  await tx`UPDATE client_documents SET reminded_on = ${day}::date, updated_at = now() WHERE id = ANY(${ids}::uuid[])`;
}

/** The lines of `day`, marked at once: for the tests and for a caller that shows them all. */
export async function takeExpiryLines(tx: Queryable, day: string): Promise<string[]> {
  const found = await expiringDocuments(tx, day);
  await markReminded(tx, found.map((item) => item.id), day);
  return found.map((item) => item.text);
}
