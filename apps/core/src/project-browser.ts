import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { Project } from '@arianna/config';
import { commitChanges, committedFiles, MAX_LOG, repositoryBranches, repositoryChanges, repositoryLog, WorkspaceError, type FileChange, type RepositoryBranch, type RepositoryCommit } from '@arianna/executors';

import type { Queryable, Sql } from './db/client.ts';
import {
  approvedRoot,
  DelegationFileError,
  extensionOf,
  isSecretPath,
  MAX_DIFF_CELLS,
  MAX_DIFF_CHARS,
  MAX_DIFF_FILES,
  MAX_PREVIEW_BYTES,
  OPENABLE,
  openPathProblem,
  readOpenBytes,
  readProjectBytesAt,
  shownText,
  type DelegationFileErrorCode,
  type OpenLinks,
} from './delegation-view.ts';
import { appendEvent } from './events.ts';
import { diffLines, MAX_CELLS, splitLines, type LineDiff } from './line-diff.ts';
import { listening, listServices, type ListedService, type ServiceManager, type ServiceRun } from './project-services.ts';

/**
 * The page "Progetti" (D-134): an approved project read on this computer,
 * nothing written. Files with the checks of D-117 (inside the project after
 * links, never `.git` nor hidden parts, a size limit, vault values refused),
 * git with the commands of `@arianna/executors` that run no hook, filter or
 * network. Nothing here goes out: no executor, no model, no channel.
 */

/** An approved project as the page lists it: the folder too, for "Apri in VS Code"; `hidden` is the consent of D-135. */
export interface BrowsableProject {
  name: string;
  absolute: string;
  hidden: boolean;
}

/** The approved projects the page may read (a project is L0 or L1 by construction, D-058). */
export function browsableProjects(projects: readonly Project[], consents: ReadonlyMap<string, string> = new Map()): BrowsableProject[] {
  return projects.map(({ name, absolute }) => ({ name, absolute, hidden: consents.get(name) === absolute }));
}

/** The consents of D-135: project name → the folder it was given for. */
export async function hiddenConsents(sql: Queryable): Promise<Map<string, string>> {
  const rows = await sql.unsafe<{ project: string; folder: string }[]>('SELECT project, folder FROM project_hidden_consents WHERE shown');
  return new Map(rows.map((row) => [row.project, row.folder]));
}

/**
 * Whether the user allowed this project to show its hidden entries (D-135):
 * a consent given for this very folder. The core decides, never the request.
 */
export async function hiddenShown(sql: Queryable, projects: readonly Project[], name: string): Promise<boolean> {
  const project = projects.find((candidate) => candidate.name === name);
  if (project === undefined) return false;
  const [row] = await sql.unsafe<{ folder: string }[]>('SELECT folder FROM project_hidden_consents WHERE project = $1 AND shown', [name]);
  return row?.folder === project.absolute;
}

/** Turns the consent of D-135 on or off for an approved project, with its event in the chain. */
export async function setHiddenShown(sql: Sql, projects: readonly Project[], name: string, on: boolean): Promise<void> {
  const root = await rootOf(projects, name);
  const label = approvedLabel(projects, name);
  await sql.begin(async (tx) => {
    if (on) {
      await tx.unsafe(
        `INSERT INTO project_hidden_consents (project, folder) VALUES ($1, $2)
         ON CONFLICT (project) DO UPDATE SET folder = EXCLUDED.folder, shown = true, changed_at = now()`,
        [name, root],
      );
    } else await tx.unsafe('UPDATE project_hidden_consents SET shown = false, changed_at = now() WHERE project = $1 AND shown', [name]);
    await appendEvent(tx, { kind: on ? 'project.hidden_shown' : 'project.hidden_closed', label, payload: { project: name } });
  });
}

/** The label of an approved project, for its events; `rootOf` has already said it is approved. */
function approvedLabel(projects: readonly Project[], name: string): Project['label'] {
  const project = projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new DelegationFileError('not-approved', `the project ${name} is no longer among the approved projects`);
  return project.label;
}

/**
 * "Mostra" on a covered secret (D-135): the file read with its text, after
 * the event (project, the path asked and the file really read, never the
 * text) is in the chain. A file that is not a secret writes nothing.
 */
export async function revealBrowsedFile(sql: Queryable, projects: readonly Project[], name: string, path: string): Promise<ProjectFile> {
  const { file, real } = await readBrowsed(projects, name, path, { showHidden: await hiddenShown(sql, projects, name), reveal: true });
  if (file.secret === true) {
    const payload = real === path ? { project: name, path } : { project: name, path, real };
    await appendEvent(sql, { kind: 'project.secret_revealed', label: approvedLabel(projects, name), payload });
  }
  return file;
}

export { isSecretPath };

/** One entry of a folder: `shut` says why it is listed but never opened; `secret` that its text comes covered. */
export interface TreeEntry {
  name: string;
  kind: 'dir' | 'file';
  size: number | null;
  shut?: 'hidden' | 'excluded' | 'outside';
  secret?: true;
}

/** Folders listed but never opened: heavy, and not the project's own code. */
export const EXCLUDED_DIRS = new Set(['node_modules']);
/** Entries of one folder the page receives; the others are counted. */
export const MAX_ENTRIES = 1000;

/** A path part the page opens only with the consent of D-135. */
const shutPart = (part: string): boolean => part.startsWith('.') || EXCLUDED_DIRS.has(part);

/** A folder path of the page: relative, `/`-separated, no empty or `..` part, no hidden one without consent ('' is the top). */
function dirProblem(dir: string, showHidden: boolean): string | undefined {
  if (dir === '') return undefined;
  if (isAbsolute(dir) || dir.includes('\0') || dir.includes('\\')) return 'the path is not a folder of the project';
  if (dir.split('/').some((part) => part === '' || part === '..' || part === '.')) return 'the path is not a folder of the project';
  if (!showHidden && dir.split('/').some(shutPart)) return 'this folder is not opened';
  return undefined;
}

const insideRoot = (path: string, root: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};

/**
 * Where a real path (links resolved) may not be opened from the page: out of
 * the project, or through a hidden part or an excluded folder. One rule for
 * the tree and the files, so that a link named `src2 -> .git` opens nothing.
 * With the consent of D-135 only "out of the project" stays.
 */
function shutReason(real: string, root: string, showHidden: boolean): 'outside' | 'hidden' | 'excluded' | undefined {
  if (!insideRoot(real, root)) return 'outside';
  if (showHidden) return undefined;
  const parts = relative(root, real).split(sep).filter((part) => part !== '');
  if (parts.some((part) => part.startsWith('.'))) return 'hidden';
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return 'excluded';
  return undefined;
}

/** The project's folder by name, approved and exactly its path, or 403. */
async function rootOf(projects: readonly Project[], name: string): Promise<string> {
  return approvedRoot(projects, name);
}

/**
 * One folder of the project (D-134): folders first, then files, by name.
 * Hidden entries (a dot in front: `.git`, `.env`, `.claude`) and
 * `node_modules` are listed shut, unless the user allowed them (D-135); a
 * link is followed only to see whether it stays inside the project.
 */
export async function listProjectDir(projects: readonly Project[], name: string, dir: string, showHidden = false): Promise<{ entries: TreeEntry[]; more: number }> {
  const problem = dirProblem(dir, showHidden);
  if (problem !== undefined) throw new DelegationFileError('refused', problem);
  const root = await rootOf(projects, name);
  const folder = dir === '' ? root : join(root, ...dir.split('/'));
  let real: string;
  try {
    real = await realpath(folder);
  } catch {
    throw new DelegationFileError('deleted', 'the folder is no longer there');
  }
  if (shutReason(real, root, showHidden) !== undefined) throw new DelegationFileError('refused', 'this folder is not opened');
  if ((await lstat(real).catch(() => undefined))?.isDirectory() !== true) throw new DelegationFileError('refused', 'not a folder');
  const found = await readdir(real, { withFileTypes: true }).catch(() => {
    throw new DelegationFileError('refused', 'the folder cannot be read');
  });
  const entries: TreeEntry[] = [];
  for (const item of found) {
    const path = join(real, item.name);
    if (!showHidden && item.name.startsWith('.')) {
      entries.push({ name: item.name, kind: item.isDirectory() ? 'dir' : 'file', size: null, shut: 'hidden' });
      continue;
    }
    let kind: 'dir' | 'file' | undefined;
    let size: number | null = null;
    let shut: TreeEntry['shut'];
    let target: string | undefined;
    if (item.isSymbolicLink()) {
      target = await realpath(path).catch(() => undefined);
      shut = target === undefined ? 'outside' : shutReason(target, root, showHidden);
      if (target !== undefined && shut === undefined) {
        const stats = await lstat(target).catch(() => undefined);
        kind = stats?.isDirectory() === true ? 'dir' : stats?.isFile() === true ? 'file' : undefined;
        size = stats?.isFile() === true ? stats.size : null;
      }
    } else if (item.isDirectory()) kind = 'dir';
    else if (item.isFile()) {
      kind = 'file';
      size = (await lstat(path).catch(() => undefined))?.size ?? null;
    }
    if (shut !== undefined) entries.push({ name: item.name, kind: kind ?? 'file', size: null, shut });
    else if (!showHidden && kind === 'dir' && EXCLUDED_DIRS.has(item.name)) entries.push({ name: item.name, kind, size: null, shut: 'excluded' });
    else if (kind === 'file' && (isSecretPath(dir === '' ? item.name : `${dir}/${item.name}`) || (target !== undefined && isSecretPath(relative(root, target))))) {
      entries.push({ name: item.name, kind, size, secret: true });
    }
    else if (kind !== undefined) entries.push({ name: item.name, kind, size });
  }
  entries.sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'dir' ? -1 : 1));
  return { entries: entries.slice(0, MAX_ENTRIES), more: Math.max(0, entries.length - MAX_ENTRIES) };
}

/**
 * A file of the project as the page shows it: text, and whether "Apri" serves
 * it. A secret (D-135) comes `covered`, without text, until "Mostra".
 */
export interface ProjectFile {
  path: string;
  size: number;
  text: string;
  openable: boolean;
  secret?: true;
  covered?: true;
}

/**
 * The text of one file (D-134): the checks of D-117, hidden parts refused as
 * for "Apri" unless the user allowed them (D-135). A secret, by its name or by
 * the name of the file a link leads to, is sent without text unless `reveal`.
 */
export async function readBrowsedFile(projects: readonly Project[], name: string, path: string, options: { showHidden?: boolean; reveal?: boolean } = {}): Promise<ProjectFile> {
  return (await readBrowsed(projects, name, path, options)).file;
}

/** `readBrowsedFile` with the path of the file really read, relative to the project. */
async function readBrowsed(projects: readonly Project[], name: string, path: string, options: { showHidden?: boolean; reveal?: boolean }): Promise<{ file: ProjectFile; real: string }> {
  const showHidden = options.showHidden === true;
  if (!showHidden && path.split('/').some(shutPart)) throw new DelegationFileError('refused', 'this file is not shown');
  const root = await rootOf(projects, name);
  // The same rule as the tree on the real path: a link into node_modules or a hidden folder is not followed.
  const real = await realpath(join(root, path)).catch(() => undefined);
  if (real !== undefined && shutReason(real, root, showHidden) !== undefined) throw new DelegationFileError('refused', 'this file is not shown');
  // The file really read decides, not a path resolved before: a link swapped in between changes nothing.
  const { bytes, real: realPath } = await readProjectBytesAt(root, path, MAX_PREVIEW_BYTES, !showHidden, showHidden);
  const hiddenPart = [path, realPath].some((item) => item.split('/').some((part) => part.startsWith('.')));
  // "Apri" serves no hidden file and no secret, with or without the consent (D-135).
  const openable = OPENABLE.has(extensionOf(path)) && !hiddenPart;
  if (isSecretPath(path) || isSecretPath(realPath)) {
    if (options.reveal !== true) return { file: { path, size: bytes.length, text: '', openable: false, secret: true, covered: true }, real: realPath };
    return { file: { path, size: bytes.length, text: shownText(bytes), openable: false, secret: true }, real: realPath };
  }
  return { file: { path, size: bytes.length, text: shownText(bytes), openable }, real: realPath };
}

/** "Apri" on a page or an image of the project (D-134): the same link and checks as D-117, tappa 3. */
export async function openBrowsedFile(projects: readonly Project[], links: OpenLinks, name: string, path: string): Promise<{ url: string }> {
  if (!OPENABLE.has(extensionOf(path))) throw new DelegationFileError('refused', 'only a page or an image is opened');
  const problem = openPathProblem(path);
  if (problem !== undefined) throw new DelegationFileError('refused', problem);
  const root = await rootOf(projects, name);
  await readOpenBytes(root, path);
  const token = links.issue(name);
  return { url: `/api/open/${token}/${path.split('/').map(encodeURIComponent).join('/')}` };
}

/** git runs in the folder on request, never while the Coder may be rewriting its configuration (as the diff of D-117). */
export async function notBusy(sql: Queryable, name: string): Promise<void> {
  const [running] = await sql.unsafe<{ id: string }[]>(`SELECT id::text FROM task_delegations WHERE repo = $1 AND status = 'running' LIMIT 1`, [name]);
  if (running !== undefined) throw new DelegationFileError('busy', `the Coder is working on ${name}: git is shown when it ends`);
}

/** git said the folder is not the top of a repository: the page says "no git"; any other failure stays an error. */
async function gitOr<T>(fallback: T, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof WorkspaceError && /not the top folder/.test(error.message)) return fallback;
    throw error;
  }
}

/** The tab Git at a glance (D-134): branches, changes not committed, the last commits. */
export interface ProjectGit {
  repository: boolean;
  branches: RepositoryBranch[];
  changes: FileChange[];
  log: RepositoryCommit[];
}

export const LOG_SHOWN = 50;

export async function readProjectGit(sql: Queryable, projects: readonly Project[], name: string): Promise<ProjectGit> {
  const root = await rootOf(projects, name);
  await notBusy(sql, name);
  const none: ProjectGit = { repository: false, branches: [], changes: [], log: [] };
  return gitOr(none, async () => ({
    repository: true,
    branches: await repositoryBranches(root),
    changes: await repositoryChanges(root),
    log: await repositoryLog(root, Math.min(LOG_SHOWN, MAX_LOG)),
  }));
}

/** One file of a commit's diff, or why it is not shown (`covered`: a secret of D-135). */
export type CommitFileDiff = FileChange & (LineDiff | { error: DelegationFileErrorCode | 'too-many' | 'covered' });

/**
 * What a commit changed (D-134): the files against its first parent, each
 * side read from git without filters (`committedFiles`), text without vault
 * values and within MAX_PREVIEW_BYTES; hidden files are listed, shown only
 * with the consent of D-135; secrets are listed, never shown here.
 * The same limits as the diff of D-117.
 */
export async function readCommitDiff(sql: Queryable, projects: readonly Project[], name: string, commit: string, showHidden = false): Promise<{ commit: string; parent: string | null; files: CommitFileDiff[] }> {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit)) throw new DelegationFileError('not-found', 'no such commit');
  const root = await rootOf(projects, name);
  await notBusy(sql, name);
  let changed: { parent: string | null; files: FileChange[] };
  try {
    changed = await commitChanges(root, commit);
  } catch {
    throw new DelegationFileError('not-found', 'no such commit');
  }
  const shown = changed.files.slice(0, MAX_DIFF_FILES);
  const hidden = (path: string): boolean => !showHidden && path.split('/').some(shutPart);
  const secret = (entry: FileChange): boolean => isSecretPath(entry.path) || (entry.from !== undefined && isSecretPath(entry.from));
  const readable = shown.filter((entry) => !secret(entry) && !hidden(entry.path) && (entry.from === undefined || !hidden(entry.from)));
  const before = changed.parent === null ? [] : await committedFiles(root, changed.parent, readable.map((entry) => (entry.change === 'added' ? '' : (entry.from ?? entry.path))), MAX_PREVIEW_BYTES);
  const after = await committedFiles(root, commit, readable.map((entry) => (entry.change === 'deleted' ? '' : entry.path)), MAX_PREVIEW_BYTES);
  let chars = 0;
  let cells = MAX_DIFF_CELLS;
  const files: CommitFileDiff[] = [];
  for (const entry of changed.files) {
    const at = readable.indexOf(entry);
    if (files.length >= MAX_DIFF_FILES) {
      files.push({ ...entry, error: 'too-many' });
      continue;
    }
    if (at === -1) {
      files.push({ ...entry, error: secret(entry) ? 'covered' : 'refused' });
      continue;
    }
    if (chars >= MAX_DIFF_CHARS) {
      files.push({ ...entry, error: 'too-large' });
      continue;
    }
    try {
      const side = (file: (typeof after)[number] | undefined, wanted: boolean): string => {
        if (!wanted) return '';
        if (file === undefined || file.kind === 'missing') throw new DelegationFileError('not-found', 'not in the commit as a file');
        if (file.kind === 'too-large') throw new DelegationFileError('too-large', 'the file is too large');
        return shownText(file.bytes);
      };
      const old = side(before[at], changed.parent !== null && entry.change !== 'added');
      const now = side(after[at], entry.change !== 'deleted');
      const cost = Math.min(MAX_CELLS, (splitLines(old).length + 1) * (splitLines(now).length + 1));
      const diff = diffLines(old, now, { maxCells: cells });
      cells = Math.max(0, cells - cost);
      const size = diff.hunks.reduce((total, hunk) => total + hunk.lines.reduce((sum, line) => sum + line.text.length + 1, 0), 0);
      if (chars + size > MAX_DIFF_CHARS) {
        chars = MAX_DIFF_CHARS;
        files.push({ ...entry, error: 'too-large' });
        continue;
      }
      chars += size;
      files.push({ ...entry, ...diff });
    } catch (error) {
      if (!(error instanceof DelegationFileError)) throw error;
      files.push({ ...entry, error: error.code });
    }
  }
  return { commit, parent: changed.parent, files };
}

/** A service as the tab Servizi shows it: on when a port answers or a run of ours is alive. */
export type ServiceState = ListedService & { on: boolean; run: Pick<ServiceRun, 'running' | 'startedAt' | 'ended'> | null };

/** The services of a project, read now from its files, with their state (D-134, tappa 2). */
export async function serviceStates(projects: readonly Project[], name: string, manager: ServiceManager): Promise<{ root: string; list: ServiceState[] }> {
  const root = await rootOf(projects, name);
  const services = await listServices(root);
  const list = await Promise.all(
    services.map(async (service) => {
      const found = manager.run(name, service.id);
      const ports = await Promise.all(service.ports.map((item) => listening(item)));
      const run = found === undefined ? null : { running: found.running, startedAt: found.startedAt, ended: found.ended };
      return { ...service, on: ports.some(Boolean) || found?.running === true, run };
    }),
  );
  return { root, list };
}
