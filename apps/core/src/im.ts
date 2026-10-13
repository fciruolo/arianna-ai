import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Project } from '@arianna/config';
import type { Label } from '@arianna/policy';

import { afterEnd, CALENDAR_FILE, firstCalendarDate, ImCalendarError, newCalendarText, nextCalendarDate, parseCalendar, setCalendar, setEnd, type CalendarIssue, type ImCalendar } from './im-calendar.ts';
import { addDays, addItem, imFileName, ImFormatError, imNumberOf, isImDate, localImDate, meetingTime, newImText, parseIm, raiseLabel, rewriteItem, setItemState, setStatus, type ImItem, type ImState, type ImStatus, type NewItem } from './im-format.ts';
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

export type ImErrorCode = 'invalid' | 'not-found' | 'changed' | 'refused' | 'unavailable' | 'ended';

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
  /** The text of the section `## Report` (D-167, P4c); empty when there is none. */
  report: string;
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
    report: parsed.report,
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

/** The text of the IM `number` as it is on the disk now. */
export function imText(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number): string {
  const folder = imFolder(projects, project, env, false);
  if (folder === null) throw new ImError('not-found', `IM-${String(number)} not found`);
  return loadIm(folder, number).text;
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

/**
 * Rewrites the IM `number` with `transform`, when the file is still `version`
 * (the web chat) or when `version` is a check that accepts its text (code that
 * read the file a moment ago, or an answer that names its item by line and title).
 */
export function changeIm(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number, version: string | ((text: string) => boolean), transform: (text: string) => string): ImView {
  const folder = imFolder(projects, project, env, false);
  if (folder === null) throw new ImError('not-found', `IM-${String(number)} not found`);
  const file = loadIm(folder, number);
  const same = typeof version === 'string' ? versionOf(file.text) === version : version(file.text);
  if (!same) throw new ImError('changed', `IM-${String(number)} changed in the file`);
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
  return changeIm(projects, project, env, number, version, (text) => setItemState(text, line, state));
}

/** A new item at the end of `## Lavori`, when the file is still `version`. */
export function addImItem(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number, title: string, version: string): ImView {
  return changeIm(projects, project, env, number, version, (text) => addItem(text, { title }));
}

/**
 * The date of the IM after the last one of `files`: from the calendar of the
 * project when it has one (P4d, D-169), else seven days after the last IM (a
 * moved call does not count); with `notBefore`, the first meeting not over at
 * that moment. Refused when there is no IM with a date and no calendar.
 */
function plannedDate(folder: ImFolder, files: Map<number, string>, notBefore?: Date): string {
  const last = Math.max(0, ...files.keys());
  const lastFile = last === 0 ? undefined : readImFile(folder, files.get(last) ?? '');
  const lastDate = lastFile === undefined ? null : parseIm(lastFile.text).date;
  const calendar = calendarOf(folder).calendar;
  if (lastDate === null) {
    if (calendar === null) throw new ImError('invalid', 'the date of the IM is needed: there is no IM with a date before it');
    return firstCalendarDate(localImDate(notBefore ?? new Date()), calendar);
  }
  let when = calendar === null ? addDays(lastDate, 7) : nextCalendarDate(lastDate, calendar);
  // Made by code after an old IM: the first meeting of the calendar that is not over yet.
  if (notBefore !== undefined) {
    const floor = localImDate(notBefore);
    const step = 7 * (calendar?.every ?? 1);
    for (let count = 0; when < floor && count < 520; count += 1) when = addDays(when, step);
  }
  return when;
}

/**
 * The number and date the next IM of the project would have, without
 * writing; `ended` when that date falls after the last day of the calendar
 * (`fine`, D-169), so no such IM will be made; null when it cannot be known yet.
 */
export function nextImPlan(projects: readonly Project[], project: string, env: KnowledgeEnv, notBefore?: Date): { number: number; date: string; ended: boolean } | null {
  const folder = imFolder(projects, project, env, false);
  if (folder === null) return null;
  const files = imFiles(folder);
  try {
    const date = plannedDate(folder, files, notBefore);
    return { number: Math.max(0, ...files.keys()) + 1, date, ended: afterEnd(date, calendarOf(folder).end) };
  } catch (error) {
    if (error instanceof ImError && error.code === 'invalid') return null;
    throw error;
  }
}

/** The IM of a project have ended (D-169): no IM after the last day of the calendar. */
export const IM_ENDED = 'the IM of the project have ended';

/**
 * The next IM: the number after the highest, seven days after the date of the
 * last one at the same time (D-167; a moved call does not count), or on
 * `date` when given; `date` is needed for the first IM of a project.
 */
export function createIm(projects: readonly Project[], project: string, env: KnowledgeEnv, date?: string, notBefore?: Date): ImView {
  if (date !== undefined && !isImDate(date)) throw new ImError('invalid', 'the date must be YYYY-MM-DD HH:MM');
  const folder = imFolder(projects, project, env, true);
  if (folder === null) throw new ImError('unavailable', 'cannot create the folder IM');
  const files = imFiles(folder);
  const last = Math.max(0, ...files.keys());
  const when = date ?? plannedDate(folder, files, notBefore);
  if (afterEnd(when, calendarOf(folder).end)) throw new ImError('ended', IM_ENDED);
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

export interface ImCalendarView {
  /** Null when the file is missing or wrong: new IM come seven days after the last one. */
  calendar: ImCalendar | null;
  /** The field that is wrong in a file that is there; null when it is fine or missing. */
  issue: CalendarIssue | null;
  /** The last day of the IM (`fine`, D-169): no IM after it; null when they go on. */
  end: string | null;
  exists: boolean;
  /** `IM/calendario.md`, relative to where the knowledge of the project is. */
  path: string;
  /** A digest of the file (empty when missing): a change is refused when the file is no longer this one. */
  version: string;
}

function calendarOf(folder: ImFolder): ImCalendarView {
  const path = `${folder.path}/${CALENDAR_FILE}`;
  let file: { text: string; mode: number } | undefined;
  try {
    file = readImFile(folder, CALENDAR_FILE);
  } catch (error) {
    // Too large: there, but not a calendar.
    if (error instanceof ImError) return { calendar: null, issue: 'intestazione', end: null, exists: true, path, version: 'too-large' };
    throw error;
  }
  if (file === undefined) return { calendar: null, issue: null, end: null, exists: false, path, version: '' };
  const parsed = parseCalendar(file.text);
  return { calendar: parsed.calendar, issue: parsed.issue, end: parsed.end, exists: true, path, version: versionOf(file.text) };
}

/** The calendar of the IM of the project (D-167 punto 3), as the file says it. */
export function readImCalendar(projects: readonly Project[], project: string, env: KnowledgeEnv): ImCalendarView {
  const folder = imFolder(projects, project, env, false);
  if (folder === null) return { calendar: null, issue: null, end: null, exists: false, path: 'IM/calendario.md', version: '' };
  if (!folder.sameFolder()) throw new ImError('refused', `the folder ${folder.path} is not a plain folder of the project`);
  return calendarOf(folder);
}

/**
 * The calendar written in the file, when the file is still `version` (empty:
 * when there is no file yet). Only the three fields change.
 */
export function writeImCalendar(projects: readonly Project[], project: string, env: KnowledgeEnv, calendar: ImCalendar, version: string): ImCalendarView {
  return writeCalendarFile(projects, project, env, version, (text) => (text === null ? newCalendarText(calendar) : setCalendar(text, calendar)));
}

/** The last day of the IM written in the calendar (`fine`), or taken away (null): the IM go on. */
export function writeImEnd(projects: readonly Project[], project: string, env: KnowledgeEnv, end: string | null, version: string): ImCalendarView {
  // No file and no end: nothing to write.
  if (end === null && version === '') return readImCalendar(projects, project, env);
  return writeCalendarFile(projects, project, env, version, (text) => setEnd(text ?? '# Calendario degli IM\n', end));
}

function writeCalendarFile(projects: readonly Project[], project: string, env: KnowledgeEnv, version: string, transform: (text: string | null) => string): ImCalendarView {
  const folder = imFolder(projects, project, env, true);
  if (folder === null) throw new ImError('unavailable', 'cannot create the folder IM');
  if (!folder.sameFolder()) throw new ImError('refused', `the folder ${folder.path} is not a plain folder of the project`);
  const current = readImFile(folder, CALENDAR_FILE);
  const now = current === undefined ? '' : versionOf(current.text);
  if (now !== version) throw new ImError('changed', 'the calendar changed in the file');
  let text: string;
  try {
    text = transform(current === undefined ? null : current.text);
  } catch (error) {
    if (error instanceof ImCalendarError) throw new ImError('invalid', error.message);
    throw error;
  }
  if (current === undefined) {
    let fd: number;
    try {
      fd = openSync(join(folder.dir, CALENDAR_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new ImError('changed', 'the calendar changed in the file');
      throw new ImError('unavailable', 'cannot write the calendar');
    }
    try {
      if (!folder.sameFolder()) throw new ImError('refused', `the folder ${folder.path} is not a plain folder of the project`);
      writeFileSync(fd, text);
    } catch (error) {
      closeSync(fd);
      try {
        unlinkSync(join(folder.dir, CALENDAR_FILE));
      } catch {
        // Already gone.
      }
      throw error instanceof ImError ? error : new ImError('unavailable', 'cannot write the calendar');
    }
    closeSync(fd);
  } else {
    replaceFile(folder, CALENDAR_FILE, text, current.mode, () => readImFile(folder, CALENDAR_FILE)?.text === current.text);
  }
  return calendarOf(folder);
}

/**
 * The IM being worked on: the first one not closed whose meeting (the moved
 * call, else the date) is not over at `now`; undefined when there is none.
 */
export function currentIm(projects: readonly Project[], project: string, env: KnowledgeEnv, now: Date): ImSummary | undefined {
  const at = localImDate(now);
  return listIms(projects, project, env).find((im) => {
    const when = meetingTime(im);
    return im.status !== 'chiuso' && when !== null && when >= at;
  });
}

/** True when the items of `next` already hold this title and part (an item is never copied twice). */
function holds(items: readonly ImItem[], title: string, part: number | null): boolean {
  const fold = (value: string): string => value.normalize('NFC').toLowerCase();
  return items.some((item) => fold(item.title) === fold(title) && item.part === part);
}

/**
 * The IM after `number`, created when it is not there yet: seven days after
 * the last one, and never in the past (a closing of an old IM does not make a
 * chain of IM already over).
 */
function followingIm(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number, now: Date): ImView {
  const following = followingOrEnd(projects, project, env, number, now);
  if (following === null) throw new ImError('ended', IM_ENDED);
  return following;
}

/** The IM after `number`, made when missing; null when the next one would fall after the last day of the calendar (D-169). */
function followingOrEnd(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number, now: Date): ImView | null {
  const after = listIms(projects, project, env).find((im) => im.number > number);
  // An IM made before the end was set and falling after it does not count: the user takes it away, its items would go with it.
  if (after !== undefined) return afterEnd(after.date ?? '', readImCalendar(projects, project, env).end) ? null : readIm(projects, project, env, after.number);
  if (nextImPlan(projects, project, env, now)?.ended === true) return null;
  return createIm(projects, project, env, undefined, now);
}

/**
 * True when `number` is the last IM of the project: no IM after it and the
 * next one would fall after the last day of the calendar (D-169).
 */
export function isLastIm(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number, now = new Date()): boolean {
  const after = listIms(projects, project, env).find((im) => im.number > number);
  if (after !== undefined) return afterEnd(after.date ?? '', readImCalendar(projects, project, env).end);
  return nextImPlan(projects, project, env, now)?.ended === true;
}

/**
 * `item` at the end of `target`, unless it is there already. An item from a
 * file with a higher label raises `target` first (D-145: a private title
 * never lands in an Interno file the Coder reads).
 */
function appendItem(projects: readonly Project[], project: string, env: KnowledgeEnv, target: ImView, item: NewItem, from: Label = 'L0'): ImView {
  if (holds(target.items, item.title, item.part ?? null)) return target;
  return changeIm(projects, project, env, target.number, target.version, (text) => addItem(raiseLabel(text, from, target.label), item));
}

export type ImWhich = 'current' | 'next';

/**
 * "Per il prossimo IM: le fatture" (D-167, P4b): an item in the current IM or
 * in the one after it (created seven days later when missing). A project
 * without an IM with a date has no calendar: the first IM is made in the
 * cardwall, never guessed.
 */
export function addItemTo(projects: readonly Project[], project: string, env: KnowledgeEnv, which: ImWhich, title: string, now: Date): ImView {
  const current = currentIm(projects, project, env, now);
  let target: ImView;
  if (current !== undefined) {
    target = which === 'current' ? readIm(projects, project, env, current.number) : followingIm(projects, project, env, current.number, now);
  } else {
    // Every IM is over or closed: the next meeting is a new IM after the last one (createIm refuses one after the end).
    const last = listIms(projects, project, env).at(-1);
    if (last === undefined || last.date === null) throw new ImError('not-found', 'the project has no IM with a date: make the first one in the cardwall');
    target = createIm(projects, project, env, undefined, now);
  }
  const after = appendItem(projects, project, env, target, { title });
  if (after === target) throw new ImError('invalid', `IM-${String(target.number)} has this item already`);
  return after;
}

export type ImOutcome = 'done' | 'part' | 'not-done';

/** An item named by its line and title: the answer refers to the file as it was when the question was asked. */
export interface ImItemRef {
  line: number;
  title: string;
  part: number | null;
}

function findItem(text: string, ref: ImItemRef): ImItem | undefined {
  return parseIm(text).items.find((item) => item.line === ref.line && item.title === ref.title && item.part === ref.part);
}

/**
 * The answer to "È finita?" for one open item at the closing of an IM
 * (D-167): done is `[x]`; in part closes it as done (as `— Parte 1` when it
 * had no part) and puts `— Parte N+1` in the next IM, with the same card;
 * not done is `[>]` and the same item in the next IM. The next IM is written
 * first (adding there twice does nothing), so a failure never loses an item.
 * At the last IM of the project (D-169) there is no next IM: in part closes
 * the part done, not done cancels the item (`[-]`); its card stays open in
 * the cardwall (the caller makes it when missing, with isLastIm).
 */
export function closeImItem(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number, ref: ImItemRef, outcome: ImOutcome, now = new Date()): { im: ImView; item: ImItem } {
  const open = (text: string): boolean => {
    const item = findItem(text, ref);
    return item !== undefined && (item.state === 'todo' || item.state === 'doing');
  };
  const current = readIm(projects, project, env, number);
  const item = current.items.find((candidate) => candidate.line === ref.line && candidate.title === ref.title && candidate.part === ref.part);
  if (item === undefined) throw new ImError('changed', 'the item changed in the file');
  if (item.state !== 'todo' && item.state !== 'doing') throw new ImError('changed', 'the item is not open any more');
  if (outcome === 'done') return { im: changeIm(projects, project, env, number, open, (text) => setItemState(text, ref.line, 'done')), item };
  const next = followingOrEnd(projects, project, env, number, now);
  if (next === null) {
    if (outcome === 'part') return { im: changeIm(projects, project, env, number, open, (text) => rewriteItem(text, ref.line, { title: item.title, state: 'done', part: item.part ?? 1, card: item.card })), item };
    return { im: changeIm(projects, project, env, number, open, (text) => setItemState(text, ref.line, 'cancelled')), item };
  }
  if (outcome === 'part') {
    const part = item.part ?? 1;
    appendItem(projects, project, env, next, { title: item.title, part: part + 1, card: item.card }, current.label);
    return { im: changeIm(projects, project, env, number, open, (text) => rewriteItem(text, ref.line, { title: item.title, state: 'done', part, card: item.card })), item };
  }
  appendItem(projects, project, env, next, { title: item.title, part: item.part, card: item.card }, current.label);
  return { im: changeIm(projects, project, env, number, open, (text) => setItemState(text, ref.line, 'postponed')), item };
}

/**
 * The end of the closing (D-167): when no item is to do or in progress, the
 * items postponed by hand go to the next IM too, the next IM is there (made
 * when missing, never in the past) and the IM becomes `chiuso`. Returns
 * false, writing nothing, while an item is still open. At the last IM of the
 * project (D-169) there is no next IM: the items postponed by hand stay `[>]`
 * in the file, where the user sees them (never cancelled without a card).
 */
export function finishImClosing(projects: readonly Project[], project: string, env: KnowledgeEnv, number: number, now = new Date()): boolean {
  const current = readIm(projects, project, env, number);
  if (current.status === 'chiuso') return true;
  if (current.items.some((item) => item.state === 'todo' || item.state === 'doing')) return false;
  const following = followingOrEnd(projects, project, env, number, now);
  if (following === null) {
    changeIm(projects, project, env, number, current.version, (text) => setStatus(text, 'chiuso'));
    return true;
  }
  let next = following;
  for (const item of current.items.filter((candidate) => candidate.state === 'postponed')) {
    next = appendItem(projects, project, env, next, { title: item.title, part: item.part, card: item.card }, current.label);
  }
  changeIm(projects, project, env, number, current.version, (text) => setStatus(text, 'chiuso'));
  return true;
}

/** True when an item still open in an IM not closed carries this card (Parte N+1 of a work going on). */
export function cardStillOpen(projects: readonly Project[], project: string, env: KnowledgeEnv, card: string): boolean {
  return listIms(projects, project, env)
    .filter((summary) => summary.status !== 'chiuso')
    .some((summary) => readIm(projects, project, env, summary.number).items.some((item) => item.card === card && (item.state === 'todo' || item.state === 'doing')));
}

/**
 * A card arrived in "Fatto" (D-167): its items in the IM not closed of its
 * project become `[x]`. `card` is the short id the items carry; the caller
 * makes sure it names one card only. Returns the IM changed.
 */
export function markCardItems(projects: readonly Project[], project: string, env: KnowledgeEnv, card: string): number[] {
  if (!/^[0-9a-f]{8}$/.test(card)) return [];
  const changed: number[] = [];
  for (const summary of listIms(projects, project, env)) {
    if (summary.status === 'chiuso') continue;
    const im = readIm(projects, project, env, summary.number);
    const lines = im.items.filter((item) => item.card === card && (item.state === 'todo' || item.state === 'doing')).map((item) => item.line);
    if (lines.length === 0) continue;
    changeIm(projects, project, env, im.number, im.version, (text) => lines.reduce((acc, line) => setItemState(acc, line, 'done'), text));
    changed.push(im.number);
  }
  return changed;
}
