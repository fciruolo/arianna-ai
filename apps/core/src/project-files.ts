import { link, lstat, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Project } from '@arianna/config';

import type { Queryable } from './db/client.ts';
import { approvedRoot, isSecretPath } from './delegation-view.ts';
import { EXCLUDED_DIRS } from './project-browser.ts';
import type { NewEvent } from './events.ts';

/**
 * Moving and deleting files and folders in the tab "File" of a project
 * (I-20, D-185): the page asks, the user confirms in a window, the core
 * does it with the checks of the tree (D-134) and writes the event. Only
 * inside the approved project, never through a link, a hidden part
 * (`.git`, `.env`) or `node_modules`, never while a run works on the
 * project; a move never replaces anything. Deleting is for good: the window
 * says so, and a folder holding a git repository is refused.
 */

export type ProjectFileErrorCode = 'invalid' | 'refused' | 'not-found' | 'exists' | 'busy' | 'too-large';

export class ProjectFileError extends Error {
  override name = 'ProjectFileError';
  readonly code: ProjectFileErrorCode;

  constructor(code: ProjectFileErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const PROJECT_FILE_STATUS: Readonly<Record<ProjectFileErrorCode, number>> = { invalid: 400, refused: 403, 'not-found': 404, exists: 409, busy: 409, 'too-large': 413 };

/** Entries a folder may hold to be deleted from the page: past this, the terminal is the place. */
export const MAX_DELETED_ENTRIES = 5000;

export interface ProjectFileDeps {
  projects: () => readonly Project[];
  record: (event: NewEvent) => Promise<unknown>;
  sql: Queryable;
}

/** A path of the page: relative, `/`-separated, no empty, `.` or `..` part, no hidden part, no `node_modules`, not the top. */
function checkedPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > 4096 || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) {
    throw new ProjectFileError('invalid', 'the path is not a file of the project');
  }
  const parts = raw.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new ProjectFileError('invalid', 'the path is not a file of the project');
  if (parts.some((part) => part.startsWith('.') || EXCLUDED_DIRS.has(part))) throw new ProjectFileError('refused', 'hidden parts and node_modules are not changed from the page');
  // A file that may hold a secret (D-135) is shown covered: it is not moved or deleted from the page either.
  if (isSecretPath(raw)) throw new ProjectFileError('refused', 'a file that may hold a secret is not changed from the page');
  return raw;
}

/** The folder holding `path` exactly where it should be: no link on the way, inside the project. */
async function realParent(root: string, path: string): Promise<string> {
  const parent = dirname(join(root, path));
  const real = await realpath(parent).catch(() => undefined);
  if (real === undefined) throw new ProjectFileError('not-found', 'the folder is no longer there');
  if (real !== parent) throw new ProjectFileError('refused', 'a link on the way: nothing is changed');
  return real;
}

/** A run on the project may be writing these files: the page waits for it to end (as git, D-117). */
async function notBusy(sql: Queryable, name: string): Promise<void> {
  const [running] = await sql.unsafe<{ id: string }[]>(`SELECT id::text FROM task_delegations WHERE repo = $1 AND status = 'running' LIMIT 1`, [name]);
  if (running !== undefined) throw new ProjectFileError('busy', `an agent is working on ${name}: try again when it ends`);
}

async function projectOf(deps: ProjectFileDeps, name: string): Promise<{ root: string; project: Project }> {
  const projects = deps.projects();
  const project = projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new ProjectFileError('not-found', 'no such project');
  return { root: await approvedRoot(projects, name), project };
}

/** Files and folders under a folder, links not followed; refused when it holds a git repository or too much. */
async function countEntries(folder: string): Promise<number> {
  let count = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 32) throw new ProjectFileError('too-large', 'the folder is too deep to delete from the page');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') throw new ProjectFileError('refused', 'the folder holds a git repository: it is not changed from the page');
      // Hidden files are never changed from the page, not even inside a folder (.env, .github).
      if (entry.name.startsWith('.')) throw new ProjectFileError('refused', 'the folder holds hidden files: it is not changed from the page');
      count += 1;
      if (count > MAX_DELETED_ENTRIES) throw new ProjectFileError('too-large', `the folder holds more than ${String(MAX_DELETED_ENTRIES)} entries`);
      if (entry.isDirectory()) await walk(join(dir, entry.name), depth + 1);
    }
  };
  await walk(folder, 0);
  return count;
}

/** Deletes a file or a folder of the project for good. Event `project.file.delete` with the path and how many entries went. */
export async function deleteProjectPath(deps: ProjectFileDeps, name: string, body: { path: unknown }): Promise<{ path: string; kind: 'file' | 'dir'; entries: number }> {
  const path = checkedPath(body.path);
  const { root, project } = await projectOf(deps, name);
  await notBusy(deps.sql, name);
  const parent = await realParent(root, path);
  const absolute = join(parent, path.split('/').at(-1) ?? '');
  const stats = await lstat(absolute).catch(() => undefined);
  if (stats === undefined) throw new ProjectFileError('not-found', 'the file is no longer there');
  if (stats.isSymbolicLink()) throw new ProjectFileError('refused', 'a link is not deleted from the page');
  let kind: 'file' | 'dir';
  let entries = 1;
  if (stats.isDirectory()) {
    kind = 'dir';
    entries += await countEntries(absolute);
    // rm does not follow the links inside: they go, their targets stay.
    await rm(absolute, { recursive: true, force: false });
  } else if (stats.isFile()) {
    kind = 'file';
    await unlink(absolute);
  } else throw new ProjectFileError('refused', 'only files and folders are deleted');
  await deps.record({ kind: 'project.file.delete', label: project.label, payload: { project: project.name, path, kind, entries } });
  return { path, kind, entries };
}

/**
 * Moves (or renames) a file or a folder inside the project. Nothing is ever
 * replaced: a name already there is 409. A file moves with a hard link and
 * the removal of the old name, so a file appearing meanwhile is never
 * overwritten. Event `project.file.move`.
 */
export async function moveProjectPath(deps: ProjectFileDeps, name: string, body: { from: unknown; to: unknown }): Promise<{ from: string; to: string; kind: 'file' | 'dir' }> {
  const from = checkedPath(body.from);
  const to = checkedPath(body.to);
  if (from === to) throw new ProjectFileError('invalid', 'the file is already there');
  if (to.startsWith(`${from}/`)) throw new ProjectFileError('invalid', 'a folder does not move inside itself');
  const { root, project } = await projectOf(deps, name);
  await notBusy(deps.sql, name);
  const source = join(await realParent(root, from), from.split('/').at(-1) ?? '');
  const target = join(await realParent(root, to), to.split('/').at(-1) ?? '');
  const stats = await lstat(source).catch(() => undefined);
  if (stats === undefined) throw new ProjectFileError('not-found', 'the file is no longer there');
  if (stats.isSymbolicLink()) throw new ProjectFileError('refused', 'a link is not moved from the page');
  if ((await lstat(target).catch(() => undefined)) !== undefined) throw new ProjectFileError('exists', 'a file with that name is already there');
  let kind: 'file' | 'dir';
  if (stats.isFile()) {
    kind = 'file';
    try {
      await link(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectFileError('exists', 'a file with that name is already there');
      throw error;
    }
    await unlink(source);
  } else if (stats.isDirectory()) {
    kind = 'dir';
    await countEntries(source);
    // Checked free just above; between the check and the rename only an agent could fill it, and none works now (notBusy).
    await rename(source, target);
  } else throw new ProjectFileError('refused', 'only files and folders are moved');
  await deps.record({ kind: 'project.file.move', label: project.label, payload: { project: project.name, from, to, kind } });
  return { from, to, kind };
}
