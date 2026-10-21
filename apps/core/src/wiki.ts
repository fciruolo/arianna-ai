import { randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isWikiFolderPath,
  isWikiPagePath,
  MAX_PAGE_POINTS,
  MAX_WIKI_CANDIDATES,
  MAX_WIKI_DEPTH,
  MAX_WIKI_FOLDERS,
  MAX_WIKI_TITLE,
  proposeWiki,
  WIKI_MODEL,
  wikiIndexLines,
  wikiInputLines,
  writeWikiIndexSummary,
  type LocalModel,
  type WikiDecision,
  type WikiFailure,
  type WikiInput,
  type WikiPageInput,
} from '@arianna/executors';
import { createContext, isAtMost, KB_WIKI, labelForPath, maxLabel, type Label, type LabelRules } from '@arianna/policy';

import { relinkPages } from './archivist.ts';
import { localTimestamp } from './capture.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { passGateway } from './gateway.ts';
import { enqueueJob } from './jobs.ts';
import { listPageIds, readKnowledgePage, resolveWikilink } from './knowledge.ts';
import { diffLines, type LineDiff } from './line-diff.ts';
import { headerFields, NoteError, sha256 } from './notes.ts';
import { KB_DIR, KB_PROJECT_NOTES, parsePage, type Kb } from './orchestrator/kb.ts';
import { bodyText, filterLinks, ORGANIZE_MAX_ATTEMPTS, ORGANIZE_QUEUE } from './organize.ts';
import { unlinkPlainFile } from './plain-file.ts';

/**
 * The Wiki proposed by the local model (D-280, tappa B of D-273). From a note
 * of the user (a video summarized, a note filed by the Archivist, or the
 * button «Proponi per la Wiki»), the local model proposes to create a page of
 * kb/wiki, to update one (adding or rewriting points, never removing one) or
 * nothing. The model writes plain text only; the code composes the page, and
 * every citation `[[nota]]` comes from an enum of the notes the model was
 * given. The page changes only when the user approves the proposal in the
 * chat, and only if it is still the page the proposal was made for (sha256).
 *
 * kb/wiki is out of git, always L2 (the policy floors it, D-280) and never
 * seen by Codex (DEV_ALWAYS_DENIED). A tree of at most 3 levels: topic,
 * sub-topic, article (`kb/wiki/laravel/octane/swoole.md`); each folder has
 * an `_indice.md` the code composes (the list) with an «In breve» the model
 * writes. Proposals are JSON files in kb/wiki/.proposte, the versions a page
 * had in kb/wiki/.storia: hidden folders, never pages of the graph or the
 * search. Nothing leaves the Mac; events carry counts and codes only.
 */

/** kb/wiki as an id relative to kb/. */
export const WIKI_ID = KB_WIKI.slice(KB_DIR.length + 1);
export const INDEX_NAME = '_indice.md';
const PROPOSALS_DIR = '.proposte';
const HISTORY_DIR = '.storia';
/** Largest file read under kb/wiki. */
const MAX_WIKI_BYTES = 200_000;
/** Pages and folders walked at most. */
const MAX_WIKI_ENTRIES = 2_000;
/** Proposals kept at most: a new one beyond it is refused. */
export const MAX_PROPOSALS = 200;
/** Old versions of one page kept at most. */
export const MAX_VERSIONS = 20;
/** Open questions of a page at most. */
const MAX_PAGE_QUESTIONS = 12;
const MAX_PAGE_RELATED = 12;
/** Related notes offered as citations besides the note itself. */
const MAX_SOURCES = 4;
const MAX_QUERY = 1_000;
/** One proposal call at most this long. */
export const WIKI_TIMEOUT_MS = 180_000;

const PROPOSAL_ID = /^[0-9a-f]{16}$/;
const VERSION_ID = /^\d{8}-\d{6}-\d{3}(-\d)?$/;
const SHA = /^[0-9a-f]{64}$/;

export type WikiErrorCode = 'invalid' | 'not-found' | 'changed' | 'expired' | 'exists' | 'edited' | 'full' | 'unavailable';

/** Messages name fixed reasons, never page content. */
export class WikiError extends Error {
  override name = 'WikiError';
  readonly code: WikiErrorCode;

  constructor(code: WikiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const WIKI_STATUS: Record<WikiErrorCode, number> = {
  invalid: 400,
  'not-found': 404,
  changed: 409,
  expired: 409,
  exists: 409,
  edited: 409,
  full: 409,
  unavailable: 503,
};

// ---------------------------------------------------------------------------
// Files under kb/wiki: real folders only, never a link, nothing overwritten by surprise

/** kb/ of this home as its real path, when it is a real folder. */
function kbReal(home: string): string | undefined {
  try {
    const base = join(realpathSync(home), KB_DIR);
    if (lstatSync(base, { throwIfNoEntry: false })?.isDirectory() !== true || realpathSync(base) !== base) return undefined;
    return base;
  } catch {
    return undefined;
  }
}

/**
 * The real folder kb/wiki/<segments>, walked one segment at a time without
 * following a link; with `create`, the missing folders are made (private to
 * the user). Undefined when a segment is a link, a file or cannot be made.
 */
function wikiFolder(home: string, segments: readonly string[], create: boolean): string | undefined {
  const kb = kbReal(home);
  if (kb === undefined) return undefined;
  let dir = kb;
  for (const segment of [WIKI_ID, ...segments]) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return undefined;
    dir = join(dir, segment);
    if (create) {
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'EEXIST') return undefined;
      }
    }
    if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return undefined;
  }
  try {
    return realpathSync(dir) === join(kb, WIKI_ID, ...segments) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** A plain file under kb/wiki, opened without following a link, within MAX_WIKI_BYTES. */
function readWikiFile(home: string, segments: readonly string[]): { raw: string; mtimeMs: number } | undefined {
  const dir = wikiFolder(home, segments.slice(0, -1), false);
  const name = segments.at(-1);
  if (dir === undefined || name === undefined || name === '' || name.includes('/') || name.includes('..')) return undefined;
  const file = join(dir, name);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_WIKI_BYTES) return undefined;
    if (realpathSync(file) !== file) return undefined;
    return { raw: readFileSync(fd, 'utf8'), mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** A temporary file beside `name` in `dir` with `content`, synced; its path, or undefined. */
function tempFile(dir: string, name: string, content: string): string | undefined {
  const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    return undefined;
  }
  let written = false;
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
    written = true;
  } catch {
    // Disk full, I/O error: the temporary file goes below.
  } finally {
    closeSync(fd);
  }
  if (!written) {
    removeQuietly(temp);
    return undefined;
  }
  return temp;
}

/** Writes the new file kb/wiki/<segments>; a file already there is never overwritten (`exists`). */
function writeNewFile(home: string, segments: readonly string[], content: string): void {
  const folder = segments.slice(0, -1);
  const name = segments.at(-1) ?? '';
  const dir = wikiFolder(home, folder, true);
  if (dir === undefined) throw new WikiError('unavailable', 'cannot write in the wiki');
  const temp = tempFile(dir, name, content);
  if (temp === undefined) throw new WikiError('unavailable', 'cannot write in the wiki');
  try {
    // Last look at the folder: swapped for a link since the walk, it is refused.
    if (wikiFolder(home, folder, false) !== dir) throw new WikiError('unavailable', 'cannot write in the wiki');
    linkSync(temp, join(dir, name));
  } catch (error) {
    if (error instanceof WikiError) throw error;
    if ((error as { code?: unknown }).code === 'EEXIST') throw new WikiError('exists', 'a page with that path exists already');
    throw new WikiError('unavailable', 'cannot write in the wiki');
  } finally {
    removeQuietly(temp);
  }
}

/** Replaces kb/wiki/<segments> with `content`, only if it is still `expectedSha256` (`changed` otherwise). */
function replaceFile(home: string, segments: readonly string[], content: string, expectedSha256: string): void {
  const folder = segments.slice(0, -1);
  const name = segments.at(-1) ?? '';
  const dir = wikiFolder(home, folder, false);
  if (dir === undefined) throw new WikiError('changed', 'the page changed');
  const current = (): string | undefined => {
    const file = readWikiFile(home, segments);
    return file === undefined ? undefined : sha256(file.raw);
  };
  if (current() !== expectedSha256) throw new WikiError('changed', 'the page changed after it was shown');
  const temp = tempFile(dir, name, content);
  if (temp === undefined) throw new WikiError('unavailable', 'cannot write in the wiki');
  try {
    if (current() !== expectedSha256 || wikiFolder(home, folder, false) !== dir) throw new WikiError('changed', 'the page changed after it was shown');
    renameSync(temp, join(dir, name));
  } catch (error) {
    removeQuietly(temp);
    if (error instanceof WikiError) throw error;
    throw new WikiError('unavailable', 'cannot write in the wiki');
  }
}

/** Writes kb/wiki/<segments> whatever is there (the indexes, composed by the code). */
function putFile(home: string, segments: readonly string[], content: string): void {
  const file = readWikiFile(home, segments);
  if (file === undefined) writeNewFile(home, segments, content);
  else if (file.raw !== content) replaceFile(home, segments, content, sha256(file.raw));
}

function removeWikiFile(home: string, segments: readonly string[]): boolean {
  const kb = kbReal(home);
  return kb !== undefined && unlinkPlainFile(kb, [WIKI_ID, ...segments]);
}

// ---------------------------------------------------------------------------
// The page: composed by the code from plain texts, read back the same way

export interface WikiPoint {
  /** Plain text, inert (bodyText). */
  text: string;
  /** Vault ids of the notes cited (`inbox/x`, `archivio/private/casa/y`), at least one. */
  sources: string[];
}

export interface WikiPageData {
  title: string;
  summary: string;
  points: WikiPoint[];
  questions: string[];
  /** Every note cited by the page, as vault ids. */
  sources: string[];
  /** Other pages of the wiki, relative to kb/wiki without `.md`. */
  related: string[];
}

const SECTION_SUMMARY = '## In breve';
const SECTION_POINTS = '## Punti';
const SECTION_QUESTIONS = '## Domande aperte';
const SECTION_SOURCES = '## Fonti';
const SECTION_RELATED = '## Pagine collegate';
const NONE = 'Nessuna.';

/** A text of the model as one inert line: no wikilink, no heading, image, link, address or HTML (D-086). */
export function inertLine(text: string): string {
  return bodyText(filterLinks(text.replace(/\s+/g, ' ').trim(), []).text)
    .replace(/\n/g, ' ')
    // Brackets left alone by the link filter (`x ]] y`) and a leading code fence: never a link or a block.
    .replace(/\[\[|\]\]/g, '')
    .replace(/^(\s*)`/, '$1\\`');
}

/** Whether a line of a page is inert as the code writes it: nothing a renderer or Obsidian would load or follow. */
function isInert(text: string): boolean {
  // An address is written `https[://]…` by bodyText: not clickable, so not one.
  return !/[<>\n\r]|(?<!\[):\/\/|!\[|\]\(|\[\[|\]\]/.test(text) && !/^\s*(#|---)/.test(text);
}

function wikilink(id: string): string {
  return `[[${id}]]`;
}

/** The body of a page, from its data. */
export function composeWikiBody(data: WikiPageData): string {
  const list = (items: readonly string[]): string => (items.length === 0 ? NONE : items.map((item) => `- ${item}`).join('\n'));
  return [
    SECTION_SUMMARY,
    data.summary,
    SECTION_POINTS,
    data.points.length === 0 ? NONE : data.points.map((point) => `- ${point.text} ${point.sources.map(wikilink).join(' ')}`).join('\n'),
    SECTION_QUESTIONS,
    list(data.questions),
    SECTION_SOURCES,
    list(data.sources.map(wikilink)),
    SECTION_RELATED,
    list(data.related.map((page) => wikilink(`${WIKI_ID}/${page}`))),
  ].join('\n\n') + '\n';
}

/** The whole page: a header written by the code (always L2), then the body. */
export function composeWikiPage(data: WikiPageData, now: Date, model: string = WIKI_MODEL): string {
  const header = ['---', 'label: L2', 'kind: wiki', `title: ${JSON.stringify(data.title)}`, `updated_at: ${localTimestamp(now)}`, `model: ${model}`, '---'].join('\n');
  return `${header}\n\n${composeWikiBody(data)}`;
}

/** The body of a page as written after its header. */
function bodyOf(raw: string): string | undefined {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return undefined;
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) return undefined;
  return text.slice(end + 5).replace(/^\n/, '');
}

function jsonTitle(value: string | undefined): string | undefined {
  if (value === undefined || !/^".*"$/.test(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const CITATIONS = /((?: \[\[[^[\]\n|#]{1,300}\]\])+)$/;

function listItems(text: string): string[] | undefined {
  if (text === NONE) return [];
  const lines = text.split('\n');
  if (!lines.every((line) => line.startsWith('- '))) return undefined;
  return lines.map((line) => line.slice(2));
}

function linkTarget(item: string): string | undefined {
  const match = /^\[\[([^[\]\n|#]{1,300})\]\]$/.exec(item);
  return match?.[1];
}

/**
 * The data of a page written by composeWikiPage, or undefined when the page
 * is not exactly in that form (edited by hand): such a page is never updated
 * by a proposal, which would otherwise lose what the user wrote.
 */
export function parseWikiPage(raw: string): WikiPageData | undefined {
  const fields = headerFields(raw);
  const title = jsonTitle(fields.get('title'));
  const body = bodyOf(raw);
  if (title === undefined || body === undefined || fields.get('kind') !== 'wiki') return undefined;
  const parts = body.replace(/\n$/, '').split('\n\n');
  const headings = [SECTION_SUMMARY, SECTION_POINTS, SECTION_QUESTIONS, SECTION_SOURCES, SECTION_RELATED];
  if (parts.length !== 10 || headings.some((heading, index) => parts[index * 2] !== heading)) return undefined;
  const [, summary = '', , pointsText = '', , questionsText = '', , sourcesText = '', , relatedText = ''] = parts;
  const pointItems = listItems(pointsText);
  const questions = listItems(questionsText);
  const sourceItems = listItems(sourcesText);
  const relatedItems = listItems(relatedText);
  if (pointItems === undefined || questions === undefined || sourceItems === undefined || relatedItems === undefined) return undefined;
  const points: WikiPoint[] = [];
  for (const item of pointItems) {
    const match = CITATIONS.exec(item);
    if (match === null) return undefined;
    const text = item.slice(0, item.length - (match[1] ?? '').length);
    const sources = [...(match[1] ?? '').matchAll(/\[\[([^[\]\n|#]{1,300})\]\]/g)].map((link) => link[1] ?? '');
    points.push({ text, sources });
  }
  const sources = sourceItems.map(linkTarget);
  const related = relatedItems.map((item) => linkTarget(item));
  if (sources.some((source) => source === undefined) || related.some((page) => page === undefined || !page.startsWith(`${WIKI_ID}/`))) return undefined;
  const data: WikiPageData = {
    title,
    summary,
    points,
    questions,
    sources: sources as string[],
    related: (related as string[]).map((page) => page.slice(WIKI_ID.length + 1)),
  };
  // Exactly the form of the code, so that nothing is lost when it is written again.
  return composeWikiBody(data) === body ? data : undefined;
}

/** Whether a whole page is one the code wrote: L2, composed, every text inert. */
export function isSafeWikiPage(raw: string): boolean {
  const data = parseWikiPage(raw);
  if (data === undefined) return false;
  const fields = headerFields(raw);
  if (fields.get('label') !== 'L2' || parsePage(raw).header.labels.length !== 1) return false;
  const texts = [data.title, data.summary, ...data.points.map((point) => point.text), ...data.questions];
  return texts.every(isInert) && data.title.length <= MAX_WIKI_TITLE && data.points.every((point) => point.sources.length > 0);
}

// ---------------------------------------------------------------------------
// The tree: folders, pages and their indexes

export interface WikiTreePage {
  /** Relative to kb/wiki, without `.md`: `laravel/octane/swoole`. */
  path: string;
  title: string;
  updatedAt: string;
}

export interface WikiTree {
  /** Relative to kb/wiki: `laravel`, `laravel/octane`. */
  folders: string[];
  pages: WikiTreePage[];
}

/** The folders and pages of kb/wiki, real folders only, not hidden, at most MAX_WIKI_DEPTH levels; sorted. */
export function wikiTree(home: string): WikiTree {
  const tree: WikiTree = { folders: [], pages: [] };
  const walk = (segments: string[]): void => {
    const dir = wikiFolder(home, segments, false);
    if (dir === undefined) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (tree.folders.length + tree.pages.length >= MAX_WIKI_ENTRIES || entry.name.startsWith('.')) continue;
      const path = [...segments, entry.name].join('/');
      if (entry.isDirectory() && segments.length < MAX_WIKI_DEPTH - 1 && isWikiFolderPath(path)) {
        tree.folders.push(path);
        walk([...segments, entry.name]);
      } else if (entry.isFile() && entry.name.endsWith('.md') && isWikiPagePath(path.slice(0, -3))) {
        const file = readWikiFile(home, [...segments, entry.name]);
        if (file === undefined) continue;
        const title = jsonTitle(headerFields(file.raw).get('title')) ?? entry.name.slice(0, -3);
        tree.pages.push({ path: path.slice(0, -3), title, updatedAt: new Date(file.mtimeMs).toISOString() });
      }
    }
  };
  walk([]);
  return tree;
}

/** Whether a folder or a page of the wiki (`laravel`, `laravel/octane/swoole.md`) is up to L2 by the folder rules: a higher rule on a sub-folder stays (D-280). */
function wikiPathUpToL2(rules: LabelRules, path: string): boolean {
  return isAtMost(labelForPath(rules, `${KB_WIKI}/${path}`), 'L2');
}

/** The tree without the folders and pages a rule raises above L2: what the chat shows and the local model reads. */
export function visibleWikiTree(home: string, rules: LabelRules): WikiTree {
  const tree = wikiTree(home);
  return {
    folders: tree.folders.filter((folder) => wikiPathUpToL2(rules, folder)),
    pages: tree.pages.filter((page) => wikiPathUpToL2(rules, `${page.path}.md`)),
  };
}

function pageSegments(path: string): string[] {
  const segments = path.split('/');
  return [...segments.slice(0, -1), `${segments.at(-1) ?? ''}.md`];
}

/** A page of the wiki with its version, or undefined. */
export function readWikiPageFile(home: string, path: string): { raw: string; version: string; mtimeMs: number } | undefined {
  if (!isWikiPagePath(path)) return undefined;
  const file = readWikiFile(home, pageSegments(path));
  return file === undefined ? undefined : { raw: file.raw, version: sha256(file.raw), mtimeMs: file.mtimeMs };
}

/** The display name of a folder: its last segment with spaces, or «Wiki» for the root. */
function folderTitle(folder: string): string {
  if (folder === '') return 'Wiki';
  const name = (folder.split('/').at(-1) ?? folder).replace(/-/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const INDEX_PENDING = 'In attesa del riassunto del modello locale.';
const INDEX_EMPTY = 'Cartella ancora vuota.';

/** An alias of a wikilink: no character that would end or split it. */
function alias(text: string): string {
  return text.replace(/[[\]|#\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The index of a folder: the «In breve» of the model, then the sub-folders and pages, composed by the code. */
export function composeIndex(folder: string, summary: string, tree: WikiTree): string {
  const depth = folder === '' ? 0 : folder.split('/').length;
  const inside = (path: string): boolean => (folder === '' ? !path.includes('/') : path.startsWith(`${folder}/`) && path.split('/').length === depth + 1);
  const subfolders = tree.folders.filter(inside);
  const pages = tree.pages.filter((page) => inside(page.path));
  const prefix = `${WIKI_ID}/`;
  const header = ['---', 'label: L2', 'kind: wiki-index', `title: ${JSON.stringify(folderTitle(folder))}`, '---'].join('\n');
  return [
    header,
    '',
    SECTION_SUMMARY,
    '',
    summary === '' ? (subfolders.length === 0 && pages.length === 0 ? INDEX_EMPTY : INDEX_PENDING) : summary,
    '',
    '## Sotto-argomenti',
    '',
    subfolders.length === 0 ? NONE : subfolders.map((sub) => `- [[${prefix}${sub}/_indice|${alias(folderTitle(sub))}]]`).join('\n'),
    '',
    '## Articoli',
    '',
    pages.length === 0 ? NONE : pages.map((page) => `- [[${prefix}${page.path}|${alias(page.title)}]]`).join('\n'),
    '',
  ].join('\n');
}

/** The «In breve» an index holds, '' when it holds none yet. */
export function indexSummary(raw: string | undefined): string {
  if (raw === undefined || headerFields(raw).get('kind') !== 'wiki-index') return '';
  const body = bodyOf(raw) ?? '';
  const start = body.indexOf(`${SECTION_SUMMARY}\n\n`);
  if (start < 0) return '';
  const rest = body.slice(start + SECTION_SUMMARY.length + 2);
  const end = rest.indexOf('\n\n## ');
  const summary = (end < 0 ? rest : rest.slice(0, end)).trim();
  return summary === INDEX_PENDING || summary === INDEX_EMPTY || !isInert(summary) ? '' : summary;
}

function indexSegments(folder: string): string[] {
  return folder === '' ? [INDEX_NAME] : [...folder.split('/'), INDEX_NAME];
}

/** Whether a folder holds a page, at any depth. */
function holdsPages(tree: WikiTree, folder: string): boolean {
  return tree.pages.some((page) => folder === '' || page.path.startsWith(`${folder}/`));
}

/**
 * Every index composed again from the tree, keeping its «In breve» (or
 * `summaries` given for a folder); a folder without pages loses its index and
 * goes when it is empty. Gives back the folders whose index is new.
 */
export function rebuildIndexes(home: string, rules: LabelRules, summaries: ReadonlyMap<string, string> = new Map()): string[] {
  // No folder goes by itself (the user's choice, 2026-10-21): an empty one stays, with an index that says so,
  // until the user removes it with «Elimina cartella».
  // Indexes list only what is up to L2: a folder or page a rule raises is neither named nor indexed.
  const tree = visibleWikiTree(home, rules);
  const created: string[] = [];
  for (const folder of ['', ...tree.folders]) {
    const segments = indexSegments(folder);
    const current = readWikiFile(home, segments);
    if (folder === '' && tree.folders.length === 0 && tree.pages.length === 0) {
      // An empty wiki: no index to name what is gone.
      if (headerFields(current?.raw ?? '').get('kind') === 'wiki-index') removeWikiFile(home, segments);
      continue;
    }
    const summary = summaries.get(folder) ?? indexSummary(current?.raw);
    if (current === undefined && holdsPages(tree, folder)) created.push(folder);
    try {
      putFile(home, segments, composeIndex(folder, summary, tree));
    } catch (error) {
      if (!(error instanceof WikiError)) throw error;
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Proposals

export type ProposalKind = 'create' | 'update' | 'move';

export interface StoredProposal {
  v: 1;
  id: string;
  kind: ProposalKind;
  /** The page (create, update) relative to kb/wiki without `.md`, or the folder that moves. */
  path: string;
  /** The folder it moves to (move only). */
  to?: string;
  /** sha256 of the page (update) or of the listing of the folder (move) the proposal was made for; null for a new page. */
  base: string | null;
  /** The whole page proposed (create, update); '' for a move. */
  content: string;
  title: string;
  /** The note it comes from, relative to kb/ (`inbox/x.md`); null for a move. */
  source: string | null;
  reason: string;
  model: string | null;
  createdAt: string;
  points: number;
  citations: number;
}

function readProposalFile(home: string, id: string): StoredProposal | undefined {
  if (!PROPOSAL_ID.test(id)) return undefined;
  const file = readWikiFile(home, [PROPOSALS_DIR, `${id}.json`]);
  if (file === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(file.raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const p = value as Record<string, unknown>;
  const kinds: readonly unknown[] = ['create', 'update', 'move'];
  if (p.v !== 1 || p.id !== id || !kinds.includes(p.kind) || typeof p.path !== 'string' || typeof p.content !== 'string' || typeof p.title !== 'string') return undefined;
  if (!(p.base === null || (typeof p.base === 'string' && SHA.test(p.base)))) return undefined;
  if (!(p.source === null || typeof p.source === 'string') || typeof p.reason !== 'string' || typeof p.createdAt !== 'string') return undefined;
  const kind = p.kind as ProposalKind;
  if (kind === 'move' ? !isWikiFolderPath(p.path) || typeof p.to !== 'string' || !isWikiFolderPath(p.to) : !isWikiPagePath(p.path)) return undefined;
  return {
    v: 1,
    id,
    kind,
    path: p.path,
    ...(kind === 'move' ? { to: p.to as string } : {}),
    base: p.base,
    content: p.content,
    title: p.title,
    source: p.source,
    reason: p.reason,
    model: typeof p.model === 'string' ? p.model : null,
    createdAt: p.createdAt,
    points: typeof p.points === 'number' ? p.points : 0,
    citations: typeof p.citations === 'number' ? p.citations : 0,
  };
}

/** The ids of the proposals, oldest first (as written: the id is random, the time is in the file). */
function proposalIds(home: string): string[] {
  const dir = wikiFolder(home, [PROPOSALS_DIR], false);
  if (dir === undefined) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[0-9a-f]{16}\.json$/.test(entry.name))
      .map((entry) => entry.name.slice(0, 16))
      .slice(0, MAX_PROPOSALS * 2);
  } catch {
    return [];
  }
}

export function allProposals(home: string): StoredProposal[] {
  return proposalIds(home)
    .flatMap((id) => {
      const proposal = readProposalFile(home, id);
      return proposal === undefined ? [] : [proposal];
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function saveProposal(home: string, proposal: StoredProposal): void {
  if (proposalIds(home).length >= MAX_PROPOSALS) throw new WikiError('full', 'too many proposals waiting: approve or discard some');
  writeNewFile(home, [PROPOSALS_DIR, `${proposal.id}.json`], `${JSON.stringify(proposal)}\n`);
}

function dropProposal(home: string, id: string): void {
  removeWikiFile(home, [PROPOSALS_DIR, `${id}.json`]);
}

/** The fingerprint of a folder's listing: what a move proposal is for. */
function folderFingerprint(home: string, folder: string): string {
  const tree = wikiTree(home);
  const inside = (path: string): boolean => path.startsWith(`${folder}/`);
  const pages = tree.pages.filter((page) => inside(page.path)).map((page) => `${page.path}\u0000${readWikiPageFile(home, page.path)?.version ?? ''}`);
  return sha256([...tree.folders.filter(inside), ...pages].join('\n'));
}

export type ProposalState = 'fresh' | 'expired';

export interface ProposalView {
  id: string;
  kind: ProposalKind;
  path: string;
  to: string | null;
  title: string;
  state: ProposalState;
  /** The note it comes from (relative to kb/) and its title now; null when gone or above L2. */
  source: { id: string; title: string } | null;
  reason: string;
  createdAt: string;
  /** The page now against the page proposed; for a move, the pages before and after. */
  diff: LineDiff;
  /** Pages a move takes along. */
  moves: { from: string; to: string }[];
}

/** Whether a proposal is still for the page (or folder) as it is now. */
function proposalState(home: string, proposal: StoredProposal): ProposalState {
  if (proposal.kind === 'move') return wikiFolder(home, proposal.path.split('/'), false) !== undefined && folderFingerprint(home, proposal.path) === proposal.base ? 'fresh' : 'expired';
  if (proposal.kind === 'update') return readWikiPageFile(home, proposal.path)?.version === proposal.base ? 'fresh' : 'expired';
  // A new page where the user (or another approval) put a page meanwhile.
  return readWikiPageFile(home, proposal.path) === undefined ? 'fresh' : 'expired';
}

/** Pages under `from` and where a move to `to` puts them. */
function movedPages(home: string, from: string, to: string): { from: string; to: string }[] {
  return wikiTree(home)
    .pages.filter((page) => page.path.startsWith(`${from}/`))
    .map((page) => ({ from: page.path, to: `${to}${page.path.slice(from.length)}` }));
}

/** The proposals as the chat shows them, newest first, with their diff. */
export function listWikiProposals(home: string, rules: LabelRules): ProposalView[] {
  return allProposals(home)
    .reverse()
    .filter((proposal) => proposalShown(rules, proposal))
    .map((proposal) => {
      let source: ProposalView['source'] = null;
      if (proposal.source !== null) {
        try {
          const found = currentNote(home, rules, proposal.source);
          if (found !== undefined) source = { id: found.id, title: found.title };
        } catch {
          // Gone or above L2: not named.
        }
      }
      const moves = proposal.kind === 'move' && proposal.to !== undefined ? movedPages(home, proposal.path, proposal.to) : [];
      const before = proposal.kind === 'move' ? moves.map((move) => `${WIKI_ID}/${move.from}`).join('\n') : (readWikiPageFile(home, proposal.path)?.raw ?? '');
      const after = proposal.kind === 'move' ? moves.map((move) => `${WIKI_ID}/${move.to}`).join('\n') : proposal.content;
      return {
        id: proposal.id,
        kind: proposal.kind,
        path: proposal.path,
        to: proposal.to ?? null,
        title: proposal.title,
        state: proposalState(home, proposal),
        source,
        reason: proposal.reason,
        createdAt: proposal.createdAt,
        diff: diffLines(before, after, { context: 2 }),
        moves,
      };
    });
}

export function countWikiProposals(home: string, rules: LabelRules): number {
  return allProposals(home).filter((proposal) => proposalShown(rules, proposal)).length;
}

/** A proposal for a place a rule raises above L2 is neither shown, counted nor approvable. */
function proposalShown(rules: LabelRules, proposal: StoredProposal): boolean {
  return proposal.kind === 'move' ? wikiPathUpToL2(rules, proposal.path) && (proposal.to === undefined || wikiPathUpToL2(rules, proposal.to)) : wikiPathUpToL2(rules, `${proposal.path}.md`);
}

// ---------------------------------------------------------------------------
// From a note to a proposal (the job)

/** A note of kb/ a proposal may come from: not in the wiki nor in the projects' knowledge. */
export function isWikiSource(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.endsWith('.md') && !lower.startsWith(`${WIKI_ID}/`) && !lower.startsWith(`${KB_PROJECT_NOTES.slice(KB_DIR.length + 1)}/`) && !id.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * The note `id` (relative to kb/) where it is now: a note moved by the
 * Archivist since (kb/inbox → kb/archivio) is found again by its file name
 * when only one page has it. Only up to L2.
 */
function currentNote(home: string, rules: LabelRules, id: string): { id: string; title: string; body: string; label: Label } | undefined {
  const read = (candidate: string): { id: string; title: string; body: string; label: Label } | undefined => {
    try {
      const page = readKnowledgePage(home, rules, candidate);
      return { id: candidate, title: page.title, body: page.body, label: page.label };
    } catch (error) {
      if (error instanceof NoteError) return undefined;
      throw error;
    }
  };
  if (!isWikiSource(id)) return undefined;
  const found = read(id);
  if (found !== undefined) return found;
  const kb = kbReal(home);
  if (kb === undefined) return undefined;
  const moved = resolveWikilink(id.split('/').at(-1) ?? id, listPageIds(kb).filter(isWikiSource));
  return moved === undefined ? undefined : read(moved);
}

/** kb id with `.md` → vault id without it, as citations are written. */
function vaultId(id: string): string {
  return id.replace(/\.md$/, '');
}

function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function wordsOf(text: string): string[] {
  return [...new Set(folded(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4))];
}

/** The pages of the wiki closest to a text: words of the text in the path and title (three times) and in the body. */
export function wikiCandidates(home: string, rules: LabelRules, text: string, limit = MAX_WIKI_CANDIDATES): { path: string; raw: string; data: WikiPageData }[] {
  const words = wordsOf(text).slice(0, 200);
  const scored: { path: string; raw: string; data: WikiPageData; score: number }[] = [];
  for (const page of visibleWikiTree(home, rules).pages) {
    const file = readWikiPageFile(home, page.path);
    const data = file === undefined ? undefined : parseWikiPage(file.raw);
    // A page edited by hand is never proposed for an update: its text would be lost; nor one whose header says more than L2.
    if (file === undefined || data === undefined || headerFields(file.raw).get('label') !== 'L2' || parsePage(file.raw).header.labels.length !== 1) continue;
    const head = folded(`${page.path} ${data.title}`);
    const body = folded(`${data.summary} ${data.points.map((point) => point.text).join(' ')}`);
    const score = words.reduce((sum, word) => sum + (head.includes(word) ? 3 : 0) + (body.includes(word) ? 1 : 0), 0);
    if (score > 0) scored.push({ path: page.path, raw: file.raw, data, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/**
 * The page a decision of the model makes: a new page, or the page `current`
 * with its points rewritten or added (none removed), its questions, sources
 * and related pages joined. `cite` maps the ids the model cited to vault ids.
 */
export function applyDecision(current: WikiPageData | undefined, decision: Exclude<WikiDecision, { action: 'none' }>, cite: (id: string) => string | undefined): WikiPageData {
  const points: WikiPoint[] = current === undefined ? [] : current.points.map((point) => ({ text: point.text, sources: [...point.sources] }));
  for (const point of decision.points) {
    const sources = [...new Set(point.sources.flatMap((source) => cite(source) ?? []))];
    if (sources.length === 0) continue;
    const text = inertLine(point.text);
    if (text === '') continue;
    const at = point.replaces - 1;
    const old = current !== undefined && point.replaces > 0 && at < Math.min(points.length, MAX_PAGE_POINTS) ? points[at] : undefined;
    // A rewritten point keeps the notes it cited and adds the new ones.
    if (old !== undefined) points[at] = { text, sources: [...new Set([...old.sources, ...sources])] };
    else points.push({ text, sources });
  }
  const questions = [...new Set([...(current?.questions ?? []), ...decision.questions.map(inertLine).filter((question) => question !== '')])].slice(0, MAX_PAGE_QUESTIONS);
  const cited = points.flatMap((point) => point.sources);
  const sources = [...new Set([...(current?.sources ?? []), ...cited])];
  const related = [...new Set([...(current?.related ?? []), ...decision.related])].filter((page) => page !== decision.path).slice(0, MAX_PAGE_RELATED);
  const summary = decision.summary === '' ? (current?.summary ?? '') : inertLine(decision.summary);
  const title = current?.title ?? inertLine(decision.title).slice(0, MAX_WIKI_TITLE);
  return { title, summary, points, questions, sources, related };
}

export interface WikiEnv {
  sql: Sql;
  home: string;
  rules: LabelRules;
  kb: Pick<Kb, 'search'>;
  model: () => LocalModel;
  timeoutMs?: number;
  now?: () => Date;
}

export type WikiProposeFailure = 'not-found' | 'above-clearance' | 'blocked' | 'changed' | 'full' | 'error' | WikiFailure;

export type WikiProposeOutcome =
  | { ok: true; action: 'create' | 'update' | 'none'; points: number; citations: number }
  | { ok: false; reason: WikiProposeFailure }
  /** A proposal from this note is waiting already. */
  | { ok: false; reason: 'skip' };

function newId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Asks the local model what the note `noteId` (relative to kb/: `inbox/x.md`,
 * `archivio/private/casa/y.md`) adds to the wiki, and stores its proposal.
 * `force` replaces a proposal from the same note waiting already («Proponi di
 * nuovo»). Every read passes the gateway towards the local model.
 */
export async function proposeFromNote(env: WikiEnv, noteId: string, signal: AbortSignal, force = false): Promise<WikiProposeOutcome> {
  const note = currentNote(env.home, env.rules, noteId);
  if (note === undefined) return { ok: false, reason: 'not-found' };
  const label = maxLabel('L2', note.label);
  if (!isAtMost(label, 'L2')) return { ok: false, reason: 'above-clearance' };
  const waiting = allProposals(env.home).filter((proposal) => proposal.source !== null && (proposal.source === note.id || proposal.source === noteId));
  if (!force && waiting.length > 0) return { ok: false, reason: 'skip' };

  const query = `${note.title} ${note.body}`.slice(0, MAX_QUERY);
  // Other notes of the user that may be cited: never pages of the wiki, never above L2.
  const hits = env.kb
    .search(query, createContext('L2'), MAX_SOURCES + 6, 'kb')
    .hits.filter((hit) => hit.path.startsWith(`${KB_DIR}/`) && isWikiSource(hit.path.slice(KB_DIR.length + 1)) && hit.path.slice(KB_DIR.length + 1) !== note.id && isAtMost(hit.label, 'L2'))
    .slice(0, MAX_SOURCES);
  const tree = visibleWikiTree(env.home, env.rules);
  const candidates = wikiCandidates(env.home, env.rules, `${note.title} ${note.body}`);
  const ids = new Map<string, string>([['nota-1', note.id]]);
  hits.forEach((hit, index) => ids.set(`nota-${String(index + 2)}`, hit.path.slice(KB_DIR.length + 1)));
  const input: WikiInput = {
    note: { id: 'nota-1', title: note.title, text: note.body },
    sources: hits.map((hit, index) => ({ id: `nota-${String(index + 2)}`, title: hit.title, text: hit.snippet })),
    folders: tree.folders.slice(0, MAX_WIKI_FOLDERS),
    pages: candidates.map((page): WikiPageInput => ({ path: page.path, title: page.data.title, summary: page.data.summary, points: page.data.points.map((point) => point.text) })),
  };
  const lines = wikiInputLines(input);
  const decision = await passGateway(
    env.sql,
    [
      { value: lines.note, label, source: `kb:${KB_DIR}/${note.id}` },
      ...lines.sources.map((value, index) => ({ value, label: hits[index]?.label ?? 'L2', source: `kb:${hits[index]?.path ?? 'kb'}` })),
      // The names of the folders and the pages of the wiki: as private as the notes they come from.
      ...lines.folders.map((value) => ({ value, label: 'L2' as const, source: `kb:${KB_WIKI}` })),
      ...lines.pages.map((value, index) => ({ value, label: 'L2' as const, source: `kb:${KB_WIKI}/${candidates[index]?.path ?? ''}` })),
    ],
    createContext('L2', label),
    { kind: 'executor', id: 'local', locality: 'local' },
  );
  if (decision.decision !== 'allow') return { ok: false, reason: 'blocked' };
  const answer = await proposeWiki(env.model(), input, decision.texts, { signal, timeoutMs: env.timeoutMs ?? WIKI_TIMEOUT_MS });
  if (!answer.ok) return { ok: false, reason: answer.reason };
  if (signal.aborted) return { ok: false, reason: 'interrupted' };
  const chosen = answer.decision;
  if (chosen.action === 'none') {
    if (force) for (const old of waiting) dropProposal(env.home, old.id);
    return { ok: true, action: 'none', points: 0, citations: 0 };
  }

  // A page where a rule says more than L2: never written nor read from a note (D-280).
  if (!wikiPathUpToL2(env.rules, `${chosen.path}.md`)) return { ok: false, reason: 'above-clearance' };
  // A new page where one exists already becomes an update of that page, its points all new.
  const existing = readWikiPageFile(env.home, chosen.path);
  const current = existing === undefined ? undefined : parseWikiPage(existing.raw);
  if (existing !== undefined && current === undefined) return { ok: false, reason: 'changed' };
  if (chosen.action === 'update' && existing === undefined) return { ok: false, reason: 'changed' };
  const kind: ProposalKind = existing === undefined ? 'create' : 'update';
  const fixed = kind === 'update' && chosen.action === 'create' ? { ...chosen, points: chosen.points.map((point) => ({ ...point, replaces: 0 })) } : chosen;
  const cite = (id: string): string | undefined => {
    const found = ids.get(id);
    return found === undefined ? undefined : vaultId(found);
  };
  const data = applyDecision(current, fixed, cite);
  const added = fixed.points.filter((point) => point.sources.some((source) => cite(source) !== undefined)).length;
  if (added === 0 && (kind === 'create' || data.summary === current?.summary)) return { ok: false, reason: 'bad-response' };
  if (kind === 'create' && (data.title === '' || data.summary === '')) return { ok: false, reason: 'bad-response' };
  const now = env.now?.() ?? new Date();
  const content = composeWikiPage(data, now);
  // Checked as the approval will check it: never a proposal that could not be approved.
  if (!isSafeWikiPage(content)) return { ok: false, reason: 'bad-response' };
  const proposal: StoredProposal = {
    v: 1,
    id: newId(),
    kind,
    path: chosen.path,
    base: existing?.version ?? null,
    content,
    title: data.title,
    source: note.id,
    reason: inertLine(chosen.reason),
    model: WIKI_MODEL,
    createdAt: localTimestamp(now),
    points: added,
    citations: fixed.points.reduce((sum, point) => sum + point.sources.length, 0),
  };
  try {
    if (force) for (const old of waiting) dropProposal(env.home, old.id);
    saveProposal(env.home, proposal);
  } catch (error) {
    if (error instanceof WikiError) return { ok: false, reason: error.code === 'full' ? 'full' : 'error' };
    throw error;
  }
  return { ok: true, action: kind, points: added, citations: proposal.citations };
}

// ---------------------------------------------------------------------------
// The «In breve» of an index (the job)

export type IndexOutcome = { ok: true } | { ok: false; reason: WikiFailure | 'not-found' | 'blocked' | 'changed' };

/** Asks the local model the «In breve» of a folder from the titles and summaries in it, and writes it in its index. */
export async function writeIndexSummary(env: WikiEnv, folder: string, signal: AbortSignal): Promise<IndexOutcome> {
  if (folder !== '' && !isWikiFolderPath(folder)) return { ok: false, reason: 'not-found' };
  if (folder !== '' && !wikiPathUpToL2(env.rules, folder)) return { ok: false, reason: 'not-found' };
  const tree = visibleWikiTree(env.home, env.rules);
  if (!holdsPages(tree, folder)) return { ok: false, reason: 'not-found' };
  const depth = folder === '' ? 0 : folder.split('/').length;
  const inside = (path: string): boolean => (folder === '' ? !path.includes('/') : path.startsWith(`${folder}/`) && path.split('/').length === depth + 1);
  const entries = [
    ...tree.folders.filter(inside).map((sub) => ({ title: folderTitle(sub), summary: indexSummary(readWikiFile(env.home, indexSegments(sub))?.raw) })),
    ...tree.pages.filter((page) => inside(page.path)).map((page) => {
      const file = readWikiPageFile(env.home, page.path);
      const data = file === undefined ? undefined : parseWikiPage(file.raw);
      return { title: page.title, summary: data?.summary ?? '' };
    }),
  ];
  const before = readWikiFile(env.home, indexSegments(folder))?.raw;
  const lines = wikiIndexLines(folder === '' ? 'wiki' : folder, entries);
  const decision = await passGateway(
    env.sql,
    lines.map((value) => ({ value, label: 'L2' as const, source: `kb:${KB_WIKI}` })),
    createContext('L2', 'L2'),
    { kind: 'executor', id: 'local', locality: 'local' },
  );
  if (decision.decision !== 'allow') return { ok: false, reason: 'blocked' };
  const answer = await writeWikiIndexSummary(env.model(), decision.texts, { signal, timeoutMs: env.timeoutMs ?? WIKI_TIMEOUT_MS });
  if (!answer.ok) return { ok: false, reason: answer.reason };
  if (signal.aborted) return { ok: false, reason: 'interrupted' };
  const summary = inertLine(answer.summary);
  // As the next rebuild reads it: a summary it would drop is not written.
  if (indexSummary(composeIndex(folder, summary, tree)) !== summary) return { ok: false, reason: 'bad-response' };
  // Changed meanwhile (an approval, a move): the next job writes it.
  if (readWikiFile(env.home, indexSegments(folder))?.raw !== before) return { ok: false, reason: 'changed' };
  rebuildIndexes(env.home, env.rules, new Map([[folder, summary]]));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Queueing, on the queue of the organizer (same waits for the model, same precedence to calls and tasks)

/** Queues a proposal from the note `noteId` (relative to kb/). */
export async function enqueueWikiNote(sql: Queryable, noteId: string, force = false): Promise<boolean> {
  if (!isWikiSource(noteId)) return false;
  const id = await enqueueJob(sql, ORGANIZE_QUEUE, { wiki: 'note', page: noteId, ...(force ? { force: true } : {}) }, { key: `${force ? 'wiki-note-again' : 'wiki-note'}:${noteId}`, maxAttempts: ORGANIZE_MAX_ATTEMPTS });
  return id !== undefined;
}

/** Queues the «In breve» of a folder index. */
export async function enqueueWikiIndex(sql: Queryable, folder: string): Promise<boolean> {
  if (folder !== '' && !isWikiFolderPath(folder)) return false;
  const id = await enqueueJob(sql, ORGANIZE_QUEUE, { wiki: 'index', folder }, { key: `wiki-index:${folder}`, maxAttempts: ORGANIZE_MAX_ATTEMPTS });
  return id !== undefined;
}

/** What a job of the wiki did, as its event carries it: codes and counts only, never a path or a title. */
export type WikiJobOutcome =
  | { ok: true; event: { kind: 'wiki.proposed'; payload: { action: string; points: number; citations: number } } | { kind: 'wiki.index_written'; payload: Record<string, never> } }
  | { ok: false; reason: WikiProposeFailure | Extract<IndexOutcome, { ok: false }>['reason'] | 'skip' };

/** Runs a job of the wiki (payload `{ wiki: 'note', page, force? }` or `{ wiki: 'index', folder }`). */
export async function runWikiJob(env: WikiEnv, payload: Record<string, unknown>, signal: AbortSignal): Promise<WikiJobOutcome> {
  if (payload.wiki === 'note' && typeof payload.page === 'string') {
    const outcome = await proposeFromNote(env, payload.page, signal, payload.force === true);
    if (!outcome.ok) return outcome;
    return { ok: true, event: { kind: 'wiki.proposed', payload: { action: outcome.action, points: outcome.points, citations: outcome.citations } } };
  }
  if (payload.wiki === 'index' && typeof payload.folder === 'string') {
    const outcome = await writeIndexSummary(env, payload.folder, signal);
    return outcome.ok ? { ok: true, event: { kind: 'wiki.index_written', payload: {} } } : outcome;
  }
  return { ok: false, reason: 'skip' };
}

// ---------------------------------------------------------------------------
// Approving, discarding, moving, restoring

function historySegments(path: string): string[] {
  return [HISTORY_DIR, path.split('/').join('__')];
}

/** A version id from a time: sortable, unique within the folder. */
function versionId(now: Date, taken: ReadonlySet<string>): string {
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  const base = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
  if (!taken.has(base)) return base;
  for (let n = 1; n <= 9; n += 1) if (!taken.has(`${base}-${String(n)}`)) return `${base}-${String(n)}`;
  return base;
}

export interface WikiVersion {
  id: string;
  at: string;
}

/** The old versions of a page, newest first. */
export function pageVersions(home: string, path: string): WikiVersion[] {
  if (!isWikiPagePath(path)) return [];
  const dir = wikiFolder(home, historySegments(path), false);
  if (dir === undefined) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && VERSION_ID.test(entry.name.slice(0, -3)))
      .map((entry) => entry.name.slice(0, -3))
      .sort((a, b) => b.localeCompare(a))
      .map((id) => ({ id, at: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}` }));
  } catch {
    return [];
  }
}

/** Keeps the version `raw` of a page in kb/wiki/.storia, at most MAX_VERSIONS per page. */
function keepVersion(home: string, path: string, raw: string, now: Date): void {
  const versions = pageVersions(home, path);
  const id = versionId(now, new Set(versions.map((version) => version.id)));
  writeNewFile(home, [...historySegments(path), `${id}.md`], raw);
  for (const old of versions.slice(MAX_VERSIONS - 1)) removeWikiFile(home, [...historySegments(path), `${old.id}.md`]);
}

/**
 * The citations of a page to notes the Archivist moved since the proposal
 * (kb/inbox → kb/archivio) point to them again, found by their file name
 * when only one page has it; the others stay as they are.
 */
function refreshCitations(home: string, data: WikiPageData): WikiPageData {
  const kb = kbReal(home);
  if (kb === undefined) return data;
  const ids = listPageIds(kb).filter(isWikiSource);
  const known = new Set(ids.map(vaultId));
  const fix = (id: string): string => {
    if (known.has(id)) return id;
    const moved = resolveWikilink(id.split('/').at(-1) ?? id, ids);
    return moved === undefined ? id : vaultId(moved);
  };
  return {
    ...data,
    points: data.points.map((point) => ({ ...point, sources: [...new Set(point.sources.map(fix))] })),
    sources: [...new Set(data.sources.map(fix))],
  };
}

export interface Approved {
  kind: ProposalKind;
  /** Where the page (or the folder) is now. */
  path: string;
  /** The user changed the path of a new page or of a move. */
  corrected: boolean;
  points: number;
  /** Pages whose links followed a move. */
  relinked: number;
  /** Folders whose index needs its «In breve» (new ones, or the page's folder). */
  folders: string[];
}

function proposalOrThrow(home: string, id: string): StoredProposal {
  if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) throw new WikiError('not-found', 'proposal not found');
  const proposal = readProposalFile(home, id);
  if (proposal === undefined) throw new WikiError('not-found', 'proposal not found');
  return proposal;
}

function parentFolder(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

/**
 * Approves a proposal. A new page goes where it was proposed or where the
 * user moved it (`path`), never over a page; an update only over the page it
 * was made for; a move only of the folder as it was listed. The old version
 * of an updated page is kept for «Ripristina».
 */
export function approveWikiProposal(home: string, rules: LabelRules, id: string, input: { path?: string } = {}, now = new Date()): Approved {
  const proposal = proposalOrThrow(home, id);
  if (proposal.kind === 'move') return approveMove(home, rules, proposal, input.path);
  if (input.path !== undefined && proposal.kind !== 'create') throw new WikiError('invalid', 'only the path of a new page can be changed');
  const path = input.path ?? proposal.path;
  if (typeof path !== 'string' || !isWikiPagePath(path)) throw new WikiError('invalid', 'the path must be topic/article or topic/subtopic/article, lowercase words joined by "-"');
  if (!wikiPathUpToL2(rules, `${path}.md`)) throw new WikiError('not-found', 'page not found');
  // The content is the code's: refused if it is not a page the code would write.
  if (!isSafeWikiPage(proposal.content)) throw new WikiError('edited', 'the proposal is not a page the code wrote');
  const data = parseWikiPage(proposal.content);
  if (data === undefined) throw new WikiError('edited', 'the proposal is not a page the code wrote');
  const fixed = refreshCitations(home, { ...data, related: data.related.filter((page) => page !== path) });
  const content = composeWikiPage(fixed, now, proposal.model ?? WIKI_MODEL);
  const before = wikiTree(home);
  if (proposal.kind === 'create') {
    if (readWikiPageFile(home, path) !== undefined) throw new WikiError('exists', 'a page with that path exists already: choose another path');
    writeNewFile(home, pageSegments(path), content);
  } else {
    const current = readWikiPageFile(home, path);
    if (current === undefined || current.version !== proposal.base) throw new WikiError('expired', 'the page changed after the proposal: ask for a new one');
    keepVersion(home, path, current.raw, now);
    replaceFile(home, pageSegments(path), content, current.version);
  }
  dropProposal(home, proposal.id);
  const created = rebuildIndexes(home, rules);
  const known = new Set(before.folders);
  const folders = [...new Set([parentFolder(path), ...created.filter((folder) => folder !== '' && !known.has(folder)), ...(created.includes('') ? [''] : [])])];
  return { kind: proposal.kind, path, corrected: path !== proposal.path, points: proposal.points, relinked: 0, folders };
}

/** «Scarta»: the proposal goes, the page stays as it is. */
export function discardWikiProposal(home: string, id: string): ProposalKind {
  const proposal = proposalOrThrow(home, id);
  dropProposal(home, proposal.id);
  return proposal.kind;
}

/** «Proponi di nuovo»: the note the proposal came from, where it is now; the proposal is replaced when the new one is written. */
export function proposalSource(home: string, rules: LabelRules, id: string): string {
  const proposal = proposalOrThrow(home, id);
  if (proposal.source === null) throw new WikiError('invalid', 'a move is not proposed again: ask for a new one');
  const note = currentNote(home, rules, proposal.source);
  if (note === undefined) throw new WikiError('not-found', 'the note of the proposal is gone');
  return note.id;
}

/**
 * «Sposta o rinomina»: a folder of the wiki to another place, as a proposal
 * the user approves in «Proposte». The destination must not exist, nor be
 * inside the folder, and every page must stay within MAX_WIKI_DEPTH levels.
 */
export function proposeMove(home: string, rules: LabelRules, from: string, to: string, now = new Date()): StoredProposal {
  if (!isWikiFolderPath(from) || wikiFolder(home, from.split('/'), false) === undefined) throw new WikiError('not-found', 'folder not found');
  checkMove(home, rules, from, to);
  const moves = movedPages(home, from, to);
  const proposal: StoredProposal = {
    v: 1,
    id: newId(),
    kind: 'move',
    path: from,
    to,
    base: folderFingerprint(home, from),
    content: '',
    title: folderTitle(to),
    source: null,
    reason: '',
    model: null,
    createdAt: localTimestamp(now),
    points: 0,
    citations: moves.length,
  };
  saveProposal(home, proposal);
  return proposal;
}

function checkMove(home: string, rules: LabelRules, from: string, to: string): void {
  if (typeof to !== 'string' || !isWikiFolderPath(to)) throw new WikiError('invalid', 'the new place must be topic or topic/subtopic, lowercase words joined by "-"');
  // Up to L2 on both sides and inside: a sub-folder a rule raises would lose its rule once moved.
  const tree = wikiTree(home);
  const under = [...tree.folders.filter((folder) => folder === from || folder.startsWith(`${from}/`)), ...tree.pages.filter((page) => page.path.startsWith(`${from}/`)).map((page) => `${page.path}.md`)];
  if (!wikiPathUpToL2(rules, from) || !wikiPathUpToL2(rules, to) || !under.every((path) => wikiPathUpToL2(rules, path))) throw new WikiError('not-found', 'folder not found');
  if (to === from || to.startsWith(`${from}/`)) throw new WikiError('invalid', 'a folder cannot go inside itself');
  if (wikiFolder(home, to.split('/'), false) !== undefined || readWikiPageFile(home, to) !== undefined) throw new WikiError('exists', 'a folder with that name exists already');
  const deepest = Math.max(0, ...movedPages(home, from, to).map((move) => move.to.split('/').length));
  if (deepest > MAX_WIKI_DEPTH) throw new WikiError('invalid', `the pages would go deeper than ${String(MAX_WIKI_DEPTH)} levels`);
}

function approveMove(home: string, rules: LabelRules, proposal: StoredProposal, path: string | undefined): Approved {
  const to = path ?? proposal.to ?? '';
  if (proposalState(home, proposal) !== 'fresh') throw new WikiError('expired', 'the folder changed after the proposal: ask for a new one');
  const moved = moveFolderNow(home, rules, proposal.path, to);
  dropProposal(home, proposal.id);
  return { kind: 'move', path: to, corrected: to !== proposal.to, points: 0, relinked: moved.relinked, folders: [parentFolder(to), to].filter((folder, index, all) => all.indexOf(folder) === index) };
}

export interface Moved {
  /** Where the page or folder is now. */
  path: string;
  /** Pages moved (one for a page). */
  pages: number;
  /** Pages of kb/ whose links followed. */
  relinked: number;
}

/** Moves a folder of the wiki with its pages, their old versions and the links to them; the indexes follow. */
function moveFolderNow(home: string, rules: LabelRules, from: string, to: string): Moved {
  checkMove(home, rules, from, to);
  const kb = kbReal(home);
  const fromDir = wikiFolder(home, from.split('/'), false);
  const parent = wikiFolder(home, to.split('/').slice(0, -1), true);
  if (kb === undefined || fromDir === undefined || parent === undefined) throw new WikiError('unavailable', 'cannot move the folder');
  const moves = movedPages(home, from, to);
  const target = join(parent, to.split('/').at(-1) ?? '');
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) throw new WikiError('exists', 'a folder with that name exists already');
  try {
    renameSync(fromDir, target);
  } catch {
    throw new WikiError('unavailable', 'cannot move the folder');
  }
  // Old versions follow their pages (best effort: a version left behind is only not offered).
  for (const move of moves) {
    const old = wikiFolder(home, historySegments(move.from), false);
    const history = wikiFolder(home, [HISTORY_DIR], false);
    if (old === undefined || history === undefined) continue;
    const next = join(history, move.to.split('/').join('__'));
    if (lstatSync(next, { throwIfNoEntry: false }) === undefined) {
      try {
        renameSync(old, next);
      } catch {
        // Left where it is.
      }
    }
  }
  // Links follow: in the pages of kb/ (the wiki's own included, now at their new place).
  const after = listPageIds(kb);
  let relinked = 0;
  for (const move of moves) {
    const fromId = `${WIKI_ID}/${move.from}.md`;
    const toId = `${WIKI_ID}/${move.to}.md`;
    const ids = [...after.filter((id) => id !== toId), fromId];
    relinked += relinkPages(home, rules, fromId, toId, ids, 'L2').pages;
  }
  // The indexes of the moved folder still name the old paths: composed again from the tree.
  rebuildIndexes(home, rules);
  return { path: to, pages: moves.length, relinked };
}

/** «Sposta o rinomina» a folder by the user, at once (D-280): no proposal; a move proposal waiting on it expires. */
export function moveWikiFolder(home: string, rules: LabelRules, from: string, to: string): Moved {
  if (!isWikiFolderPath(from) || wikiFolder(home, from.split('/'), false) === undefined) throw new WikiError('not-found', 'folder not found');
  return moveFolderNow(home, rules, from, to);
}

/**
 * «Sposta o rinomina» a page by the user, at once (D-280): the page as it
 * was shown (`base`), its old versions and the links to it follow; never over
 * a page or a folder, never deeper than three levels, never from or to a
 * place a rule raises above L2. An update proposal waiting on it expires.
 */
export function moveWikiPage(home: string, rules: LabelRules, from: string, to: string, base: string): Moved {
  if (!isWikiPagePath(from) || !wikiPathUpToL2(rules, `${from}.md`)) throw new WikiError('not-found', 'page not found');
  if (!isWikiPagePath(to)) throw new WikiError('invalid', 'the path must be topic/article or topic/subtopic/article, lowercase words joined by "-"');
  if (!wikiPathUpToL2(rules, `${to}.md`) || !wikiPathUpToL2(rules, parentFolder(to))) throw new WikiError('not-found', 'folder not found');
  if (!SHA.test(base)) throw new WikiError('invalid', 'base is required');
  const current = readWikiPageFile(home, from);
  if (current === undefined) throw new WikiError('not-found', 'page not found');
  if (current.version !== base) throw new WikiError('changed', 'the page changed after it was shown: reload it');
  if (to === from) return { path: to, pages: 0, relinked: 0 };
  if (readWikiPageFile(home, to) !== undefined || wikiFolder(home, to.split('/'), false) !== undefined) throw new WikiError('exists', 'a page or a folder with that path exists already');
  if (parentFolder(to).includes('/') && readWikiPageFile(home, parentFolder(to)) !== undefined) throw new WikiError('exists', 'a page with that path exists already');
  const kb = kbReal(home);
  if (kb === undefined) throw new WikiError('unavailable', 'cannot move the page');
  writeNewFile(home, pageSegments(to), current.raw);
  if (!removeWikiFile(home, pageSegments(from))) {
    removeWikiFile(home, pageSegments(to));
    throw new WikiError('unavailable', 'cannot move the page');
  }
  clearHistory(home, to);
  const old = wikiFolder(home, historySegments(from), false);
  const history = wikiFolder(home, [HISTORY_DIR], false);
  if (old !== undefined && history !== undefined) {
    const next = join(history, to.split('/').join('__'));
    if (lstatSync(next, { throwIfNoEntry: false }) === undefined) {
      try {
        renameSync(old, next);
      } catch {
        // Left where it is: only not offered.
      }
    }
  }
  const fromId = `${WIKI_ID}/${from}.md`;
  const toId = `${WIKI_ID}/${to}.md`;
  const ids = [...listPageIds(kb).filter((id) => id !== toId), fromId];
  const relinked = relinkPages(home, rules, fromId, toId, ids, 'L2').pages;
  rebuildIndexes(home, rules);
  return { path: to, pages: 1, relinked };
}

/** «Nuova cartella» by the user: an empty folder stays until a page goes in it or the user removes it. */
export function createWikiFolder(home: string, rules: LabelRules, path: string): void {
  if (!isWikiFolderPath(path)) throw new WikiError('invalid', 'the new place must be topic or topic/subtopic, lowercase words joined by "-"');
  if (!wikiPathUpToL2(rules, path)) throw new WikiError('not-found', 'folder not found');
  if (wikiFolder(home, path.split('/'), false) !== undefined || readWikiPageFile(home, path) !== undefined) throw new WikiError('exists', 'a folder with that name exists already');
  if (path.includes('/') && readWikiPageFile(home, parentFolder(path)) !== undefined) throw new WikiError('exists', 'a page with that path exists already');
  if (wikiFolder(home, path.split('/'), true) === undefined) throw new WikiError('unavailable', 'cannot write in the wiki');
}

// ---------------------------------------------------------------------------
// Pages written by the user (D-280): the header is the code's, the body is checked

/** Longest body the user may save, in characters. */
export const MAX_USER_BODY = 40_000;

/** The body a new page starts with: the sections of the code, to fill. */
export const NEW_PAGE_BODY = ['## In breve', '', 'Scrivi qui di cosa parla la pagina.', '', '## Punti', '', '- Un punto. Per citare una nota scrivi il suo percorso fra doppie parentesi quadre, come nelle pagine proposte.', ''].join('\n');

/**
 * Whether a target of a wikilink the user wrote is one of theirs: a note of
 * kb/ outside the wiki up to L2 that exists, or a page or index of the wiki
 * up to L2 that exists.
 */
function userLinkOk(home: string, rules: LabelRules, target: string): boolean {
  if (target.length === 0 || target.length > 300) return false;
  if (target.toLowerCase().startsWith(`${WIKI_ID}/`)) {
    const path = target.slice(WIKI_ID.length + 1).replace(/\.md$/, '');
    try {
      readWikiView(home, rules, path);
      return true;
    } catch {
      return false;
    }
  }
  const id = target.endsWith('.md') ? target : `${target}.md`;
  if (!isWikiSource(id)) return false;
  try {
    readKnowledgePage(home, rules, id);
    return true;
  } catch {
    return false;
  }
}

/**
 * The title and body the user wrote, checked as the approval checks a page
 * (D-280): citations `[[…]]` only to their notes and pages up to L2 that
 * exist, no link, image, address or HTML that a renderer would load or
 * follow, no header of their own. Errors name the line, never its text.
 */
export function checkUserPage(home: string, rules: LabelRules, title: string, body: string): { title: string; body: string } {
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  if (cleanTitle === '' || cleanTitle.length > MAX_WIKI_TITLE || /[<>[\]|#]/.test(cleanTitle)) throw new WikiError('invalid', 'title');
  const text = body.replace(/\r\n?/g, '\n');
  if (text.length > MAX_USER_BODY) throw new WikiError('invalid', 'too-long');
  const lines = text.split('\n');
  if ((lines.find((line) => line.trim() !== '') ?? '').trim() === '---') throw new WikiError('invalid', 'line 1: header');
  lines.forEach((line, index) => {
    if (line.includes('\0')) throw new WikiError('invalid', `line ${String(index + 1)}: link`);
    if (line.includes('![[')) throw new WikiError('invalid', `line ${String(index + 1)}: link`);
    // On the line as written: a `](` after a wikilink is a link too, and a scheme needs no slashes (`https:host`).
    if (/\]\(|\b(?:https?|mailto|ftp|file|javascript|vbscript|data|obsidian|tel):(?=\S)/i.test(line) || /^[\s>]*\[[^\]]+\]:/.test(line)) throw new WikiError('invalid', `line ${String(index + 1)}: link`);
    const rest = line.replace(/\[\[([^[\]\n]{1,400})\]\]/g, (_match, inner: string) => {
      const target = (inner.split('|')[0] ?? '').split('#')[0]?.trim() ?? '';
      if (!userLinkOk(home, rules, target)) throw new WikiError('invalid', `line ${String(index + 1)}: citation`);
      return ' ';
    });
    // An address the code wrote inert (`https[://]…`, as in the pages proposed) stays; any other `://` does not.
    if (/\[\[|\]\]|<|!\[|\]\(|\]\[|(?<!\[):\/\/|\bwww\./i.test(rest)) throw new WikiError('invalid', `line ${String(index + 1)}: link`);
  });
  return { title: cleanTitle, body: `${text.replace(/\s+$/, '')}\n` };
}

/** A page as the user wrote it: the header of the code (always L2), then their body. */
function composeUserPage(title: string, body: string, now: Date): string {
  const header = ['---', 'label: L2', 'kind: wiki', `title: ${JSON.stringify(title)}`, `updated_at: ${localTimestamp(now)}`, 'edited_by: user', '---'].join('\n');
  return `${header}\n\n${body}`;
}

/**
 * «Modifica» by the user, saved at once (D-280): only over the page as it was
 * shown (`base`); the version before is kept for «Ripristina». An update
 * proposal waiting on the page expires (it was made for the old text).
 */
export function editWikiPage(home: string, rules: LabelRules, path: string, base: string, title: string, body: string, now = new Date()): { version: string } {
  if (!isWikiPagePath(path) || !wikiPathUpToL2(rules, `${path}.md`)) throw new WikiError('not-found', 'page not found');
  if (!SHA.test(base)) throw new WikiError('invalid', 'base is required');
  const current = readWikiPageFile(home, path);
  if (current === undefined) throw new WikiError('not-found', 'page not found');
  if (current.version !== base) throw new WikiError('changed', 'the page changed after it was shown: reload it');
  const checked = checkUserPage(home, rules, title, body);
  const content = composeUserPage(checked.title, checked.body, now);
  replaceFile(home, pageSegments(path), content, current.version);
  keepVersion(home, path, current.raw, now);
  rebuildIndexes(home, rules);
  return { version: sha256(content) };
}

/** «Nuova pagina» by the user: never over a page or a folder; the folders above it are made. */
export function createUserWikiPage(home: string, rules: LabelRules, path: string, title: string, body: string = NEW_PAGE_BODY, now = new Date()): { path: string; version: string } {
  if (!isWikiPagePath(path)) throw new WikiError('invalid', 'the path must be topic/article or topic/subtopic/article, lowercase words joined by "-"');
  if (!wikiPathUpToL2(rules, `${path}.md`) || !wikiPathUpToL2(rules, parentFolder(path))) throw new WikiError('not-found', 'folder not found');
  if (readWikiPageFile(home, path) !== undefined || wikiFolder(home, path.split('/'), false) !== undefined) throw new WikiError('exists', 'a page or a folder with that path exists already');
  const parent = parentFolder(path);
  if (parent.includes('/') && readWikiPageFile(home, parent) !== undefined) throw new WikiError('exists', 'a page with that path exists already');
  const checked = checkUserPage(home, rules, title, body);
  const content = composeUserPage(checked.title, checked.body, now);
  writeNewFile(home, pageSegments(path), content);
  // Versions left by a page removed outside the chat are not this page's.
  clearHistory(home, path);
  rebuildIndexes(home, rules);
  return { path, version: sha256(content) };
}

/**
 * «Elimina cartella» (D-280), after the user's confirmation: only an empty
 * folder (no page, no sub-folder, nothing but its index), never one a rule
 * raises above L2; the indexes follow.
 */
export function deleteWikiFolder(home: string, rules: LabelRules, path: string): void {
  if (!isWikiFolderPath(path) || !wikiPathUpToL2(rules, path)) throw new WikiError('not-found', 'folder not found');
  const dir = wikiFolder(home, path.split('/'), false);
  if (dir === undefined) throw new WikiError('not-found', 'folder not found');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new WikiError('unavailable', 'cannot delete the folder');
  }
  if (names.some((name) => name !== INDEX_NAME)) throw new WikiError('invalid', 'not-empty');
  removeWikiFile(home, [...path.split('/'), INDEX_NAME]);
  try {
    rmdirSync(dir);
  } catch {
    throw new WikiError('unavailable', 'cannot delete the folder');
  }
  rebuildIndexes(home, rules);
}

/** Removes the old versions kept for `path` (and their folder when empty); gives how many went. */
function clearHistory(home: string, path: string): number {
  const versions = pageVersions(home, path);
  for (const version of versions) removeWikiFile(home, [...historySegments(path), `${version.id}.md`]);
  const history = wikiFolder(home, historySegments(path), false);
  if (history !== undefined) {
    try {
      rmdirSync(history);
    } catch {
      // Not empty (a file of the user): left as it is.
    }
  }
  return versions.length;
}

export interface Deleted {
  /** Old versions removed with the page. */
  versions: number;
  /** Proposals waiting on the page, discarded. */
  proposals: number;
}

/**
 * «Elimina» of a page, after the user's confirmation in the chat: the page
 * as it was shown (`base`, its sha256), its old versions in .storia and the
 * proposals waiting on it go; the indexes are composed again and folders
 * left without pages go. Never a page a rule raises above L2, never an index.
 */
export function deleteWikiPage(home: string, rules: LabelRules, path: string, base: string): Deleted {
  if (!isWikiPagePath(path) || !wikiPathUpToL2(rules, `${path}.md`)) throw new WikiError('not-found', 'page not found');
  if (!SHA.test(base)) throw new WikiError('invalid', 'base is required');
  const current = readWikiPageFile(home, path);
  if (current === undefined) throw new WikiError('not-found', 'page not found');
  if (current.version !== base) throw new WikiError('changed', 'the page changed after it was shown: reload it');
  if (!removeWikiFile(home, pageSegments(path))) throw new WikiError('unavailable', 'cannot delete the page');
  const versions = clearHistory(home, path);
  const waiting = allProposals(home).filter((proposal) => proposal.kind !== 'move' && proposal.path === path);
  for (const proposal of waiting) dropProposal(home, proposal.id);
  rebuildIndexes(home, rules);
  return { versions, proposals: waiting.length };
}

/**
 * «Ripristina»: the page goes back to an old version, only if it is still the
 * one the user saw (`base`); the version it had is kept in turn, so a restore
 * can be undone.
 */
export function restoreWikiVersion(home: string, rules: LabelRules, path: string, version: string, base: string, now = new Date()): void {
  if (!isWikiPagePath(path) || !wikiPathUpToL2(rules, `${path}.md`) || typeof version !== 'string' || !VERSION_ID.test(version)) throw new WikiError('not-found', 'version not found');
  if (typeof base !== 'string' || !SHA.test(base)) throw new WikiError('invalid', 'base is required');
  const old = readWikiFile(home, [...historySegments(path), `${version}.md`]);
  if (old === undefined) throw new WikiError('not-found', 'version not found');
  const current = readWikiPageFile(home, path);
  if (current === undefined || current.version !== base) throw new WikiError('changed', 'the page changed after it was shown: reload it');
  // Back to the version as it was, its label line included: never lower than L2.
  if (headerFields(old.raw).get('label') !== 'L2') throw new WikiError('edited', 'that version is not a page the code wrote');
  keepVersion(home, path, current.raw, now);
  replaceFile(home, pageSegments(path), old.raw, current.version);
  rebuildIndexes(home, rules);
}

export interface WikiPageView {
  path: string;
  title: string;
  kind: 'page' | 'index';
  body: string;
  version: string;
  updatedAt: string;
  versions: WikiVersion[];
}

/** A page or an index of the wiki to read: `laravel/octane/swoole`, `laravel/_indice`, `_indice`. */
export function readWikiView(home: string, rules: LabelRules, path: string): WikiPageView {
  if (typeof path !== 'string' || path.length > 200) throw new WikiError('not-found', 'page not found');
  const index = path === '_indice' || path.endsWith('/_indice');
  const folder = index ? path.slice(0, Math.max(0, path.length - '_indice'.length - 1)) : '';
  if (index ? folder !== '' && !isWikiFolderPath(folder) : !isWikiPagePath(path)) throw new WikiError('not-found', 'page not found');
  // A rule above L2 on a sub-folder: not read here, as Conoscenza does not.
  if (!wikiPathUpToL2(rules, `${path}.md`)) throw new WikiError('not-found', 'page not found');
  const file = index ? readWikiFile(home, indexSegments(folder)) : readWikiFile(home, pageSegments(path));
  if (file === undefined) throw new WikiError('not-found', 'page not found');
  const fields = headerFields(file.raw);
  // L2 always: a file whose header says more is not read here.
  if (!parsePage(file.raw).header.labels.every((label) => label === 'L2')) throw new WikiError('not-found', 'page not found');
  return {
    path,
    title: jsonTitle(fields.get('title')) ?? folderTitle(folder),
    kind: index ? 'index' : 'page',
    body: parsePage(file.raw).body,
    version: sha256(file.raw),
    updatedAt: new Date(file.mtimeMs).toISOString(),
    versions: index ? [] : pageVersions(home, path),
  };
}

// ---------------------------------------------------------------------------
// Events: counts and codes only, never a path, a title or a folder

export async function recordWikiEvent(sql: Queryable, kind: 'wiki.approved' | 'wiki.discarded' | 'wiki.restored' | 'wiki.move_proposed' | 'wiki.deleted' | 'wiki.edited' | 'wiki.created' | 'wiki.moved' | 'wiki.folder_deleted', payload: Record<string, string | number | boolean>): Promise<void> {
  await appendEvent(sql, { kind, label: 'L0', payload });
}
