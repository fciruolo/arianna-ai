import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Project } from '@arianna/config';
import { committedFiles, type CommittedFile, type FileChange } from '@arianna/executors';
import { isAtMost, isLabel } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import type { Queryable } from './db/client.ts';
import { diffLines, MAX_CELLS, splitLines, type LineDiff } from './line-diff.ts';

/**
 * "Who did what" and "Files changed" under the answers written in the cloud
 * (D-082). Metadata only: executor, alias and the model that actually ran
 * (event `executor.model`), time, cost, the files of the run. Never the text
 * of a brief or a report. A file is shown by reading the approved project
 * folder again, in read only, as it is now.
 */

/** Under one assistant message: who wrote it, on what, in how long. */
export interface MessageCredit {
  messageId: string;
  /** The delegation whose report this is; null for Claude answering directly (D-064). */
  delegationId: string | null;
  /** `coder` for a report; null when the message is Arianna's task answered by Claude. */
  agent: string | null;
  executor: string | null;
  /** The router alias (`sonnet`, `opus`, `fable`). */
  alias: string | null;
  /** The model the binary reported at start (`claude-sonnet-…`), when it did. */
  model: string | null;
  /** From start to end of the run; null while it runs. */
  durationMs: number | null;
  /** Euro beyond the subscription; null when zero. */
  cost: number | null;
  /** The project of the delegation. */
  repo: string | null;
  /** Null when not recorded. */
  files: FileChange[] | null;
}

interface CreditRow extends Omit<MessageCredit, 'durationMs' | 'cost'> {
  durationMs: string | number | null;
  cost: string | number | null;
}

const toNumber = (value: string | number | null): number | null => (value === null ? null : Number(value));
const toCost = (value: string | number | null): number | null => {
  const cost = toNumber(value);
  return cost === null || !Number.isFinite(cost) || cost <= 0 ? null : cost;
};

// The run of a message: the delegation's, or the run in the message.created event (Claude direct).
const RUN_FIELDS = `
  r.executor AS "runExecutor",
  (SELECT e.payload ->> 'model' FROM events e
    WHERE e.task_id = r.task_id AND e.run_id = r.id AND e.kind = 'executor.model'
    ORDER BY e.id DESC LIMIT 1) AS model,
  CASE WHEN r.ended_at IS NULL THEN NULL ELSE round(extract(epoch FROM r.ended_at - r.started_at) * 1000) END AS "durationMs",
  r.cost_estimate AS cost`;

const MAX_CREDITS = 500;
/** A delegation whose brief and result are at L1 or below: the only ones whose project and files are shown. */
const AT_MOST_L1 = `(d.label <= 'L1' AND (d.result_label IS NULL OR d.result_label <= 'L1'))`;

/** The credits of the latest assistant messages of a conversation written in the cloud. */
export async function listCredits(sql: Queryable, conversationId: string): Promise<MessageCredit[]> {
  const rows = await sql.unsafe<(CreditRow & { runExecutor: string | null })[]>(
    `WITH written AS (
       SELECT m.id, m.task_id, m.agent, m.model FROM messages m
       WHERE m.conversation_id = $1 AND m.role = 'assistant' AND (m.agent IS NOT NULL OR m.model IS NOT NULL)
       ORDER BY m.id DESC LIMIT $2
     )
     SELECT w.id::text AS "messageId", d.id::text AS "delegationId", w.agent,
       coalesce(d.executor, CASE WHEN w.model IS NOT NULL THEN 'claude' END) AS executor,
       coalesce(d.model, r.model, w.model) AS alias,
       ${RUN_FIELDS},
       CASE WHEN ${AT_MOST_L1} THEN d.repo END AS repo,
       CASE WHEN ${AT_MOST_L1} THEN d.files END AS files
     FROM written w
     LEFT JOIN task_delegations d ON d.message_id = w.id
     LEFT JOIN LATERAL (
       SELECT ev.run_id FROM events ev
       WHERE ev.task_id = w.task_id AND ev.kind = 'message.created' AND ev.payload ->> 'messageId' = w.id::text
       ORDER BY ev.id LIMIT 1
     ) created ON true
     LEFT JOIN runs r ON r.id = coalesce(d.run_id, created.run_id)
     ORDER BY w.id`,
    [conversationId, MAX_CREDITS],
  );
  return rows.map(({ runExecutor, durationMs, cost, executor, ...row }) => ({
    ...row,
    executor: executor ?? runExecutor,
    durationMs: toNumber(durationMs),
    cost: toCost(cost),
  }));
}

/** A row of "Deleghe recenti": metadata of the delegation, never the brief or the report. */
export interface RecentDelegation {
  id: string;
  conversationId: string | null;
  /** Only for a conversation at L1 or below (a work one). */
  conversationTitle: string | null;
  agent: string;
  repo: string | null;
  status: string;
  executor: string | null;
  alias: string | null;
  model: string | null;
  createdAt: Date;
  durationMs: number | null;
  cost: number | null;
  /** How many files the run changed; null when not recorded. */
  files: number | null;
}

/**
 * The latest delegations at L1 or below (a brief above it waits for a
 * declassification and is not listed until lowered; a private conversation
 * has no cloud delegation anyway).
 */
export async function listRecentDelegations(sql: Queryable, limit: number): Promise<RecentDelegation[]> {
  const rows = await sql.unsafe<(Omit<RecentDelegation, 'durationMs' | 'cost'> & { durationMs: string | number | null; cost: string | number | null; runExecutor: string | null })[]>(
    `SELECT d.id::text, t.conversation_id::text AS "conversationId",
       CASE WHEN c.clearance <= 'L1' THEN c.title END AS "conversationTitle",
       d.agent, d.repo, d.status, d.executor, d.model AS alias,
       ${RUN_FIELDS},
       d.created_at AS "createdAt",
       CASE WHEN d.files IS NULL THEN NULL ELSE jsonb_array_length(d.files) END AS files
     FROM task_delegations d
     JOIN tasks t ON t.id = d.task_id
     LEFT JOIN conversations c ON c.id = t.conversation_id
     LEFT JOIN runs r ON r.id = d.run_id
     WHERE ${AT_MOST_L1}
     ORDER BY d.id DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map(({ runExecutor, durationMs, cost, executor, ...row }) => ({
    ...row,
    executor: executor ?? runExecutor,
    durationMs: toNumber(durationMs),
    cost: toCost(cost),
  }));
}

/** Largest file shown in the chat. */
export const MAX_PREVIEW_BYTES = 256 * 1024;

export type DelegationFileErrorCode = 'not-found' | 'deleted' | 'not-approved' | 'refused' | 'too-large' | 'binary' | 'archived' | 'busy';

export class DelegationFileError extends Error {
  override name = 'DelegationFileError';
  readonly code: DelegationFileErrorCode;

  constructor(code: DelegationFileErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the chat shows of a changed file: its current version, read only. */
export interface FilePreview {
  path: string;
  change: FileChange['change'];
  repo: string;
  size: number;
  /** The file as it is now: it may have changed after the run. */
  text: string;
}

const isGitName = (part: string): boolean => part.toLowerCase() === '.git';

function inside(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

interface DelegationRow {
  repo: string;
  files: FileChange[];
  baseCommit: string | null;
}

/** The delegation, its labels and its conversation checked: its project and files, or why not. */
async function loadDelegationRow(sql: Queryable, id: string): Promise<DelegationRow> {
  const [row] = await sql.unsafe<{ repo: string | null; files: FileChange[] | null; baseCommit: string | null; label: string; resultLabel: string | null; archived: boolean }[]>(
    `SELECT d.repo, d.files, d.base_commit AS "baseCommit", d.label, d.result_label AS "resultLabel", coalesce(c.archived_at IS NOT NULL, false) AS archived
     FROM task_delegations d JOIN tasks t ON t.id = d.task_id LEFT JOIN conversations c ON c.id = t.conversation_id
     WHERE d.id = $1::bigint`,
    [id],
  );
  if (row === undefined || row.files === null || row.repo === null) throw new DelegationFileError('not-found', 'no such file');
  // Like a retry (D-064): an archived conversation is history, restored before anything is done from it.
  if (row.archived) throw new DelegationFileError('archived', 'the conversation is archived: restore it to see the files');
  if (!isLabel(row.label) || !isAtMost(row.label, 'L1') || (row.resultLabel !== null && (!isLabel(row.resultLabel) || !isAtMost(row.resultLabel, 'L1')))) {
    throw new DelegationFileError('not-found', 'no such file');
  }
  return { repo: row.repo, files: row.files, baseCommit: row.baseCommit };
}

/** The folder of the delegation's project, still approved at L1 or below and exactly the approved path. */
export async function approvedRoot(projects: readonly Project[], repo: string): Promise<string> {
  const project = projects.find((candidate) => candidate.name === repo);
  if (project === undefined) throw new DelegationFileError('not-approved', `the project ${repo} is no longer among the approved projects`);
  if (!isAtMost(project.label, 'L1')) throw new DelegationFileError('not-approved', `the project ${repo} is above L1`);
  const { absolute } = project;
  let root: string;
  try {
    root = await realpath(absolute);
  } catch {
    throw new DelegationFileError('not-approved', `the folder of ${repo} does not exist`);
  }
  if (!isAbsolute(absolute) || resolve(absolute) !== absolute || root !== absolute || !(await lstat(root)).isDirectory()) {
    throw new DelegationFileError('not-approved', `the folder of ${repo} is not the approved path`);
  }
  return root;
}

/** Bytes shown as text: UTF-8 without NUL, without a value of the vault. */
export function shownText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new DelegationFileError('binary', 'not a text file');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new DelegationFileError('binary', 'not a UTF-8 text file');
  }
  if (knownSecrets.find(text).length > 0) throw new DelegationFileError('refused', 'the file holds a value of the vault');
  return text;
}

/**
 * The current text of `path` in the project folder `root`: inside it after
 * resolving links, not under `.git`, a regular file of at most
 * MAX_PREVIEW_BYTES, shown as text.
 */
async function readProjectText(root: string, path: string): Promise<{ text: string; size: number }> {
  const bytes = await readProjectBytes(root, path, MAX_PREVIEW_BYTES);
  return { text: shownText(bytes), size: bytes.length };
}

/**
 * The bytes of `path` in the project folder `root`: inside it after resolving
 * links, not under `.git`, a regular file of at most `max` bytes.
 */
export async function readProjectBytes(root: string, path: string, max: number, refuseHidden = false): Promise<Buffer> {
  if (path === '' || isAbsolute(path) || path.includes('\0') || path.split('/').some((part) => part === '..' || isGitName(part))) {
    throw new DelegationFileError('refused', 'the path is not a file of the project');
  }
  const candidate = join(root, path);
  if (!inside(candidate, root)) throw new DelegationFileError('refused', 'the path is not a file of the project');
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new DelegationFileError('deleted', 'the file is no longer there');
  }
  // A link may point anywhere: only what stays inside the project, and never into .git.
  // `.git` in any case: on a case-insensitive disk `.GIT/config` is the git configuration.
  if (!inside(real, root) || relative(root, real).split(sep).some(isGitName)) {
    throw new DelegationFileError('refused', 'the file leads out of the project');
  }
  // "Apri": a link named page.html must not lead to .env either.
  if (refuseHidden && relative(root, real).split(sep).some((part) => part.startsWith('.'))) {
    throw new DelegationFileError('refused', 'hidden files are not opened');
  }
  // A fifo or a device would block the read or never end: only a regular file is opened, without waiting.
  const before = await lstat(real).catch(() => undefined);
  if (before === undefined) throw new DelegationFileError('deleted', 'the file is no longer there');
  if (!before.isFile()) throw new DelegationFileError('refused', 'not a regular file');
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (handle === undefined) throw new DelegationFileError('refused', 'the file cannot be opened');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new DelegationFileError('refused', 'not a regular file');
    // Swapped between the checks and the open (a link, another file): refused.
    const now = await lstat(real).catch(() => undefined);
    const again = await realpath(real).catch(() => undefined);
    if (now === undefined || again !== real || now.dev !== stats.dev || now.ino !== stats.ino || before.dev !== stats.dev || before.ino !== stats.ino) {
      throw new DelegationFileError('refused', 'the file changed while it was opened');
    }
    if (stats.size > max) throw new DelegationFileError('too-large', `the file is larger than ${String(max / 1024)} KiB`);
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) throw new DelegationFileError('too-large', `the file is larger than ${String(max / 1024)} KiB`);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Reads the file `index` of a delegation from its project folder (D-082): the
 * project must still be approved (D-058) at L1 or below, its folder exactly
 * the approved path (no link on the way); the file inside it after resolving
 * links, not under `.git`, a regular file of at most MAX_PREVIEW_BYTES, UTF-8
 * text without NUL, and without a value of the vault.
 */
export async function readDelegationFile(sql: Queryable, projects: readonly Project[], id: string, index: number): Promise<FilePreview> {
  const row = await loadDelegationRow(sql, id);
  const entry = row.files[index];
  if (entry === undefined) throw new DelegationFileError('not-found', 'no such file');
  if (entry.change === 'deleted') throw new DelegationFileError('deleted', 'the run deleted this file');
  const root = await approvedRoot(projects, row.repo);
  const { text, size } = await readProjectText(root, entry.path);
  return { path: entry.path, change: entry.change, repo: row.repo, size, text };
}

/** Largest file "Apri" serves (D-117, tappa 3). */
export const MAX_OPEN_BYTES = 5 * 1024 * 1024;
/** How long a link of "Apri" serves its project's files. */
export const OPEN_LINK_MS = 15 * 60_000;
const MAX_OPEN_LINKS = 100;

/**
 * What "Apri" serves, by extension: pages, their styles and classic scripts,
 * images. Text types are checked for vault values. Fonts and module scripts
 * are left out: the browser asks for them in CORS mode with `Origin: null`,
 * which the core refuses, and CORS is never opened to it.
 */
export const OPEN_TYPES: Readonly<Record<string, { type: string; text: boolean }>> = {
  html: { type: 'text/html; charset=utf-8', text: true },
  htm: { type: 'text/html; charset=utf-8', text: true },
  css: { type: 'text/css; charset=utf-8', text: true },
  js: { type: 'text/javascript; charset=utf-8', text: true },
  json: { type: 'application/json; charset=utf-8', text: true },
  txt: { type: 'text/plain; charset=utf-8', text: true },
  svg: { type: 'image/svg+xml', text: true },
  png: { type: 'image/png', text: false },
  jpg: { type: 'image/jpeg', text: false },
  jpeg: { type: 'image/jpeg', text: false },
  gif: { type: 'image/gif', text: false },
  webp: { type: 'image/webp', text: false },
  avif: { type: 'image/avif', text: false },
  ico: { type: 'image/x-icon', text: false },
};
/** The files "Apri" offers in the chat: a page or an image the run changed. */
export const OPENABLE = new Set(['html', 'htm', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);

export function extensionOf(path: string): string {
  const name = path.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * The links of "Apri" (D-117, tappa 3), in memory: a random token for one
 * project, valid OPEN_LINK_MS. The page opens sandboxed, with an opaque
 * origin, so its styles and images are loaded cross-origin: the token, which
 * only the chat received, is what keeps any other site from loading them.
 */
export interface OpenLinks {
  issue(repo: string): string;
  /** The project of a live token, or undefined. */
  repoOf(token: string): string | undefined;
}

export function createOpenLinks(now: () => number = Date.now): OpenLinks {
  const links = new Map<string, { repo: string; until: number }>();
  return {
    issue(repo) {
      const time = now();
      for (const [token, link] of links) if (link.until <= time) links.delete(token);
      // The oldest goes first when too many are open.
      while (links.size >= MAX_OPEN_LINKS) {
        const oldest = links.keys().next().value;
        if (oldest === undefined) break;
        links.delete(oldest);
      }
      const token = randomBytes(24).toString('base64url');
      links.set(token, { repo, until: time + OPEN_LINK_MS });
      return token;
    },
    repoOf(token) {
      const link = links.get(token);
      if (link === undefined) return undefined;
      if (link.until <= now()) {
        links.delete(token);
        return undefined;
      }
      return link.repo;
    },
  };
}

/** A path "Apri" may serve: relative, without hidden files or folders (.env, .git, .claude) and of a known type. */
export function openPathProblem(path: string): string | undefined {
  if (path === '' || isAbsolute(path) || path.includes('\0') || path.includes('\\')) return 'the path is not a file of the project';
  if (path.split('/').some((part) => part === '' || part.startsWith('.'))) return 'hidden files are not opened';
  if (OPEN_TYPES[extensionOf(path)] === undefined) return 'this kind of file is not opened';
  return undefined;
}

/**
 * "Apri" on the file `index` of a delegation (D-117, tappa 3): the same
 * checks as its preview, a page or an image, then a link for its project.
 */
export async function openDelegationFile(sql: Queryable, projects: readonly Project[], links: OpenLinks, id: string, index: number): Promise<{ url: string }> {
  const row = await loadDelegationRow(sql, id);
  const entry = row.files[index];
  if (entry === undefined) throw new DelegationFileError('not-found', 'no such file');
  if (entry.change === 'deleted') throw new DelegationFileError('deleted', 'the run deleted this file');
  if (!OPENABLE.has(extensionOf(entry.path))) throw new DelegationFileError('refused', 'only a page or an image is opened');
  const problem = openPathProblem(entry.path);
  if (problem !== undefined) throw new DelegationFileError('refused', problem);
  const root = await approvedRoot(projects, row.repo);
  // Read once now: a file that cannot be served is said in the chat, not in an empty tab.
  await readOpenBytes(root, entry.path);
  const token = links.issue(row.repo);
  return { url: `/api/open/${token}/${entry.path.split('/').map(encodeURIComponent).join('/')}` };
}

export async function readOpenBytes(root: string, path: string): Promise<{ body: Buffer; type: string }> {
  const kind = OPEN_TYPES[extensionOf(path)];
  if (kind === undefined) throw new DelegationFileError('refused', 'this kind of file is not opened');
  const body = await readProjectBytes(root, path, MAX_OPEN_BYTES, true);
  // A page, a style or a script with a value of the vault in it is not served.
  if (kind.text && knownSecrets.find(body.toString('utf8')).length > 0) throw new DelegationFileError('refused', 'the file holds a value of the vault');
  return { body, type: kind.type };
}

/** A file of the project behind a link of "Apri": the project still approved, the same checks as the preview. */
export async function readOpenFile(projects: readonly Project[], links: OpenLinks, token: string, path: string): Promise<{ body: Buffer; type: string }> {
  const repo = links.repoOf(token);
  if (repo === undefined) throw new DelegationFileError('not-found', 'the link has expired: open the file again from the chat');
  const problem = openPathProblem(path);
  if (problem !== undefined) throw new DelegationFileError('refused', problem);
  return readOpenBytes(await approvedRoot(projects, repo), path);
}

/** The headers of a file of "Apri": sandboxed, no network beyond the project's own files, loadable only through the token. */
export function openHeaders(host: string): Record<string, string> {
  // Not 'self': in a sandboxed page it is the opaque origin. The host is already one of allowedHosts (checkRequest).
  const self = `http://${host}`;
  return {
    'content-security-policy': [
      'sandbox allow-scripts',
      `default-src ${self} 'unsafe-inline' data: blob:`,
      "connect-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': 'no-store',
  };
}

/** Files diffed in one request; the others are listed with `too-many`. */
export const MAX_DIFF_FILES = 100;
/** Characters of diff lines in one answer; the files past it come with `too-large`. */
export const MAX_DIFF_CHARS = 2 * 1024 * 1024;
/** LCS cells over all the files of one request (see line-diff.ts): the time the event loop may spend. */
export const MAX_DIFF_CELLS = 20_000_000;

/** The diff of one file of a delegation, or why it is not shown (the codes of DelegationFileError, plus `too-many`, `no-base` and `unreadable`). */
export type FileDiff = FileChange & { index: number } & (LineDiff | { error: DelegationFileErrorCode | 'too-many' | 'no-base' | 'unreadable' });

export interface DelegationDiff {
  repo: string;
  /** The commit the files are compared against; null without one. */
  baseCommit: string | null;
  files: FileDiff[];
}

/**
 * The diff of every file of a delegation (D-117): the version in the commit
 * the changes were listed against, read from git without filters
 * (`committedFiles`), and the current one in the folder, read with the same
 * checks as `readDelegationFile`. Both sides must be text without vault
 * values and within MAX_PREVIEW_BYTES; a file that fails says why and the
 * others are still shown. Nothing is stored: it is computed on request.
 */
export async function readDelegationDiff(sql: Queryable, projects: readonly Project[], id: string): Promise<DelegationDiff> {
  const row = await loadDelegationRow(sql, id);
  const root = await approvedRoot(projects, row.repo);
  // git runs in the folder on request: never while a run may be rewriting its configuration.
  const [running] = await sql.unsafe<{ id: string }[]>(`SELECT id::text FROM task_delegations WHERE repo = $1 AND status = 'running' LIMIT 1`, [row.repo]);
  if (running !== undefined) throw new DelegationFileError('busy', `the Coder is working on ${row.repo}: the diff is shown when it ends`);
  const shown = row.files.slice(0, MAX_DIFF_FILES);
  // Old versions in one pass: the path before a rename, nothing for an added file.
  const oldPaths = shown.map((entry) => (entry.change === 'added' ? undefined : (entry.from ?? entry.path)));
  const wanted = oldPaths.flatMap((path, index) => (path === undefined ? [] : [{ path, index }]));
  const old = new Map<number, CommittedFile>();
  let unreadable = false;
  if (row.baseCommit !== null && wanted.length > 0) {
    try {
      const found = await committedFiles(
        root,
        row.baseCommit,
        wanted.map(({ path }) => path),
        MAX_PREVIEW_BYTES,
      );
      wanted.forEach(({ index }, at) => {
        const file = found[at];
        if (file !== undefined) old.set(index, file);
      });
    } catch {
      // Not the top of a repository any more, or the commit is gone: said apart from a missing file.
      unreadable = true;
    }
  }
  let chars = 0;
  let cells = MAX_DIFF_CELLS;
  const files: FileDiff[] = [];
  for (const [index, entry] of row.files.entries()) {
    const base = { ...entry, index };
    if (index >= MAX_DIFF_FILES) {
      files.push({ ...base, error: 'too-many' });
      continue;
    }
    // Past the limit nothing more is read.
    if (chars >= MAX_DIFF_CHARS) {
      files.push({ ...base, error: 'too-large' });
      continue;
    }
    try {
      let before = '';
      if (entry.change !== 'added') {
        if (unreadable) {
          files.push({ ...base, error: 'unreadable' });
          continue;
        }
        const file = old.get(index);
        // No commit recorded (a delegation from before D-117), or the old version is not in it as a file.
        if (row.baseCommit === null || file === undefined || file.kind === 'missing') {
          files.push({ ...base, error: 'no-base' });
          continue;
        }
        if (file.kind === 'too-large') throw new DelegationFileError('too-large', 'the old version is too large');
        before = shownText(file.bytes);
      }
      const after = entry.change === 'deleted' ? '' : (await readProjectText(root, entry.path)).text;
      // The LCS tables of one request share a budget: past it a file is shown as all removed, then all added.
      const cost = Math.min(MAX_CELLS, (splitLines(before).length + 1) * (splitLines(after).length + 1));
      const diff = diffLines(before, after, { maxCells: cells });
      cells = Math.max(0, cells - cost);
      const size = diff.hunks.reduce((total, hunk) => total + hunk.lines.reduce((sum, line) => sum + line.text.length + 1, 0), 0);
      if (chars + size > MAX_DIFF_CHARS) {
        chars = MAX_DIFF_CHARS;
        files.push({ ...base, error: 'too-large' });
        continue;
      }
      chars += size;
      files.push({ ...base, ...diff });
    } catch (error) {
      if (!(error instanceof DelegationFileError)) throw error;
      files.push({ ...base, error: error.code });
    }
  }
  return { repo: row.repo, baseCommit: row.baseCommit, files };
}
