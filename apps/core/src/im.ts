import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Project } from '@arianna/config';
import type { Label } from '@arianna/policy';

import { addDays, addItem, imFileName, ImFormatError, imNumberOf, isImDate, newImText, parseIm, setItemState, type ImItem, type ImState, type ImStatus } from './im-format.ts';
import { parsePage } from './orchestrator/kb.ts';
import { imFolder, MAX_NOTE_BYTES, type ImFolder, type KnowledgeEnv } from './project-knowledge.ts';

/**
 * The IM of a project (D-167, I-11 tappa P4a): the files `IM-<n>.md` of its
 * folder IM, read and changed by code for the web chat. The file is the only
 * source of the items: nothing is copied in the database, and a change is
 * written only when the file is still the one the user saw (`version`), so an
 * edit made by hand in Obsidian is never overwritten.
 */

const MAX_IMS = 1_000;

export type ImErrorCode = 'invalid' | 'not-found' | 'changed' | 'refused' | 'unavailable';

/** Messages name fixed reasons, never the text of an IM. */
export class ImError extends Error {
  override name = 'ImError';
  readonly code: ImErrorCode;

  constructor(code: ImErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type ImCounts = Record<ImState, number>;

export interface ImSummary {
  number: number;
  date: string | null;
  call: string | null;
  status: ImStatus;
  label: Label;
  /** Relative to where the knowledge of the project is (`IM/IM-32.md`). */
  path: string;
  counts: ImCounts;
}

export interface ImView extends Omit<ImSummary, 'counts'> {
  /** A digest of the file: a change is refused when the file is no longer this one. */
  version: string;
  items: ImItem[];
}

interface ImFile {
  number: number;
  fileName: string;
  text: string;
  mode: number;
}

function versionOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** A regular file of the folder, read whole, never through a link; undefined when it is not one, refused when too large. */
function readImFile(folder: ImFolder, fileName: string): { text: string; mode: number } | undefined {
  let fd: number;
  try {
    fd = openSync(join(folder.dir, fileName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_NOTE_BYTES) throw new ImError('refused', `${fileName} is too large`);
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const chunk = readSync(fd, buffer, read, stat.size - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
    return { text: buffer.subarray(0, read).toString('utf8'), mode: stat.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

/** The IM files of the folder by number; of two names for one number (`IM-3.md`, `im-3.md`) the first in order. */
function imFiles(folder: ImFolder): Map<number, string> {
  if (!folder.sameFolder()) throw new ImError('refused', `the folder ${folder.path} is not a plain folder of the project`);
  const files = new Map<number, string>();
  let names: string[];
  try {
    names = readdirSync(folder.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new ImError('unavailable', `cannot read the folder ${folder.path}`);
  }
  for (const name of names) {
    const number = imNumberOf(name);
    if (number !== null && !files.has(number)) files.set(number, name);
  }
  // The highest numbers count: the next IM is numbered after them.
  return new Map([...files].sort(([a], [b]) => b - a).slice(0, MAX_IMS));
}

function loadIm(folder: ImFolder, number: number): ImFile {
  const fileName = imFiles(folder).get(number);
  if (fileName === undefined) throw new ImError('not-found', `IM-${String(number)} not found`);
  const file = readImFile(folder, fileName);
  if (file === undefined) throw new ImError('not-found', `IM-${String(number)} not found`);
  return { number, fileName, ...file };
}

/** The label of an IM as the tab "Conoscenza" and the Coder read it (`parsePage`, D-166): a broken header is L3. */
function labelOf(folder: ImFolder, file: ImFile): Label {
  try {
    return folder.labelOf(file.fileName, parsePage(file.text).header.labels);
  } catch {
    return 'L3';
  }
}

function viewOf(folder: ImFolder, file: ImFile): ImView {
  const parsed = parseIm(file.text);
  return {
    number: file.number,
    date: parsed.date,
    call: parsed.call,
    status: parsed.status,
    label: labelOf(folder, file),
    path: `${folder.path}/${file.fileName}`,
    version: versionOf(file.text),
    items: parsed.items,
  };
}

/** The IM of the project in order of number, each with the count of its items by state. */
export function listIms(projects: readonly Project[], project: string, env: KnowledgeEnv): ImSummary[] {
  const folder = imFolder(projects, project, env, false);
  if (folder === null) return [];
  const list: ImSummary[] = [];
  for (const [number, fileName] of [...imFiles(folder)].sort(([a], [b]) => a - b)) {
    let file: { text: string; mode: number } | undefined;
    try {
      file = readImFile(folder, fileName);
    } catch (error) {
      // One IM too large leaves the others listed.
      if (error instanceof ImError) continue;
      throw error;
    }
    if (file === undefined) continue;
    const view = viewOf(folder, { number, fileName, ...file });
    const counts: ImCounts = { todo: 0, doing: 0, done: 0, postponed: 0, cancelled: 0 };
    for (const item of view.items) counts[item.state] += 1;
    list.push({ number: view.number, date: view.date, call: view.call, status: view.status, label: view.label, path: view.path, counts });
  }
  return list;
}

export function readIm(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number): ImView {
  const folder = imFolder(projects, project, env, false);
  if (folder === null) throw new ImError('not-found', `IM-${String(number)} not found`);
  return viewOf(folder, loadIm(folder, number));
}

/**
 * Writes `text` in place of the file through a new file and a rename in the
 * same folder: a reader never sees half a file, and a link put where the file
 * was is replaced, never followed. The file gets a new inode (a hard link to
 * the old one keeps the old text). `unchanged` is asked again right before the
 * rename, so an edit saved meanwhile (Obsidian) is not overwritten.
 */
function replaceFile(folder: ImFolder, fileName: string, text: string, mode: number, unchanged: () => boolean): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_NOTE_BYTES) throw new ImError('refused', 'the IM would be too large');
  const temp = join(folder.dir, `.${fileName}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new ImError('unavailable', 'cannot write the IM');
  }
  let written = false;
  try {
    writeFileSync(fd, text);
    fchmodSync(fd, mode);
    written = folder.sameFolder();
  } catch {
    // Disk full, I/O error: below, the temporary file goes.
  } finally {
    closeSync(fd);
  }
  try {
    if (!written) throw new ImError('unavailable', 'cannot write the IM');
    if (!unchanged()) throw new ImError('changed', 'the IM changed in the file');
    renameSync(temp, join(folder.dir, fileName));
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
    throw error instanceof ImError ? error : new ImError('unavailable', 'cannot write the IM');
  }
}

function change(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number, version: string, transform: (text: string) => string): ImView {
  const folder = imFolder(projects, project, env, false);
  if (folder === null) throw new ImError('not-found', `IM-${String(number)} not found`);
  const file = loadIm(folder, number);
  if (versionOf(file.text) !== version) throw new ImError('changed', `IM-${String(number)} changed in the file`);
  let text: string;
  try {
    text = transform(file.text);
  } catch (error) {
    if (error instanceof ImFormatError) throw new ImError('invalid', error.message);
    throw error;
  }
  replaceFile(folder, file.fileName, text, file.mode, () => readImFile(folder, file.fileName)?.text === file.text);
  return viewOf(folder, { ...file, text });
}

/** One item of the IM to another state, when the file is still `version`. */
export function setImItemState(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number, line: number, state: ImState, version: string): ImView {
  return change(projects, project, env, number, version, (text) => setItemState(text, line, state));
}

/** A new item at the end of `## Lavori`, when the file is still `version`. */
export function addImItem(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number, title: string, version: string): ImView {
  return change(projects, project, env, number, version, (text) => addItem(text, { title }));
}

/**
 * The next IM: the number after the highest, seven days after the date of the
 * last one at the same time (D-167; a moved call does not count), or on
 * `date` when given; `date` is needed for the first IM of a project.
 */
export function createIm(projects: readonly Project[], project: string, env: KnowledgeEnv, date?: string): ImView {
  if (date !== undefined && !isImDate(date)) throw new ImError('invalid', 'the date must be YYYY-MM-DD HH:MM');
  const folder = imFolder(projects, project, env, true);
  if (folder === null) throw new ImError('unavailable', 'cannot create the folder IM');
  const files = imFiles(folder);
  const last = Math.max(0, ...files.keys());
  let when = date;
  if (when === undefined) {
    const lastFile = last === 0 ? undefined : readImFile(folder, files.get(last) ?? '');
    const lastDate = lastFile === undefined ? null : parseIm(lastFile.text).date;
    if (lastDate === null) throw new ImError('invalid', 'the date of the IM is needed: there is no IM with a date before it');
    when = addDays(lastDate, 7);
  }
  const number = last + 1;
  const fileName = imFileName(number);
  const text = newImText(number, when);
  let fd: number;
  try {
    // O_EXCL: an IM written meanwhile (by hand or by another request) is never touched.
    fd = openSync(join(folder.dir, fileName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new ImError('changed', `IM-${String(number)} exists already`);
    throw new ImError('unavailable', 'cannot create the IM');
  }
  try {
    writeFileSync(fd, text);
  } catch {
    closeSync(fd);
    try {
      unlinkSync(join(folder.dir, fileName));
    } catch {
      // Already gone.
    }
    throw new ImError('unavailable', 'cannot create the IM');
  }
  closeSync(fd);
  return viewOf(folder, { number, fileName, text, mode: 0o600 });
}
