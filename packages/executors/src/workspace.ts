// Workspace per run for cloud executors (docs/PRIVACY-POLICY-SPEC.md,
// "Confinamento", points 1-3): allowlist, a dedicated folder in
// data/worktrees/, and the pre-flight scan before anything is launched.
//
// Not a `git worktree`: its `.git` file points to the source repository, whose
// whole history (deleted secrets included) and writable `.git` (hooks, config)
// an executor could then reach. The files of one commit are written out raw
// from the object database (no filters, no hooks run) and a new repository
// with a single commit is created on them, so the executor can still diff.
import { execFile, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { checkWorkspace, isAllowlisted, type LabelRules, type WorkspaceDecision, type WorkspaceEntry } from '@arianna/policy';

const run = promisify(execFile);

export const WORKTREES_DIR = 'worktrees';
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/;

export class WorkspaceError extends Error {
  override name = 'WorkspaceError';
}

export interface WorkspaceOptions {
  /** Absolute `data/` folder. */
  data: string;
  /** Names the folder: `data/worktrees/<runId>`. */
  runId: string;
}

export interface PrepareOptions extends WorkspaceOptions {
  /** Absolute ARIANNA_HOME. */
  home: string;
  /** The repository, relative to ARIANNA_HOME. */
  repo: string;
  allowlist: readonly string[];
  rules: LabelRules;
  /** The commit to write out; HEAD of the repository by default. */
  ref?: string;
}

export interface PreparedWorkspace {
  decision: WorkspaceDecision;
  /** Absolute path of the workspace; only when allowed. It is the working directory of the executor. */
  path?: string;
}

/** True when `inner` is `outer` or inside it. */
function within(inner: string, outer: string): boolean {
  const fromOuter = relative(outer, inner);
  return fromOuter === '' || (fromOuter !== '..' && !fromOuter.startsWith(`..${sep}`) && !isAbsolute(fromOuter));
}

/**
 * Git with as little inherited as possible: no GIT_* variables, no system or
 * global configuration (filters, includes, credential helpers of the user), no
 * hooks, no fsmonitor, no network. The configuration of the source repository
 * itself stays: it is the user's, and executors never reach it.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}

const GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', [...GIT_FLAGS, '-C', cwd, ...args], { env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** `git cat-file --batch`: the raw content of each blob, in order. */
function readBlobs(cwd: string, oids: readonly string[]): Promise<Buffer[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...GIT_FLAGS, '-C', cwd, 'cat-file', '--batch'], { env: gitEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new WorkspaceError(`git cat-file exited with ${String(code)}`));
        return;
      }
      const output = Buffer.concat(chunks);
      const blobs: Buffer[] = [];
      let at = 0;
      for (const oid of oids) {
        const end = output.indexOf(0x0a, at);
        const header = output.subarray(at, end).toString('utf8').split(' ');
        if (end === -1 || header[0] !== oid || header[1] !== 'blob') {
          reject(new WorkspaceError(`unexpected object for ${oid}`));
          return;
        }
        const size = Number(header[2]);
        blobs.push(output.subarray(end + 1, end + 1 + size));
        at = end + 1 + size + 1;
      }
      resolvePromise(blobs);
    });
    child.stdin.end(oids.map((oid) => `${oid}\n`).join(''));
  });
}

interface TreeEntry {
  mode: string;
  oid: string;
  path: string;
}

/**
 * Paths from a tree object are not trusted: a crafted tree may hold `..`,
 * `.git` or absolute names, which git itself refuses to check out.
 */
function safeTreePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git');
}

async function listTree(repo: string, ref: string): Promise<TreeEntry[]> {
  const out = await git(repo, ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', ref]);
  return out
    .split('\0')
    .filter((line) => line !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode = '', , oid = ''] = line.slice(0, tab).split(' ');
      return { mode, oid, path: line.slice(tab + 1) };
    });
}

/** Writes the files of the tree into `target`, refusing anything git would refuse. */
async function writeTree(repo: string, target: string, entries: readonly TreeEntry[]): Promise<void> {
  for (const entry of entries) {
    if (!safeTreePath(entry.path)) throw new WorkspaceError(`unsafe path in the tree: ${JSON.stringify(entry.path)}`);
  }
  // A file below a symbolic link would be written through it, anywhere on disk.
  const links = new Set(entries.filter((entry) => entry.mode === '120000').map((entry) => entry.path));
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (links.has(parts.slice(0, index).join('/'))) throw new WorkspaceError(`path below a symbolic link in the tree: ${entry.path}`);
    }
  }
  // Submodules (160000) are not checked out: their content is another repository.
  const blobs = entries.filter((entry) => entry.mode === '100644' || entry.mode === '100755' || entry.mode === '120000');
  const contents = await readBlobs(repo, blobs.map((entry) => entry.oid));
  const ordered = blobs.map((entry, index) => ({ entry, content: contents[index] ?? Buffer.alloc(0) }));
  // Regular files first, links last: nothing is ever written through a link.
  for (const { entry, content } of ordered.filter(({ entry }) => entry.mode !== '120000')) {
    const file = join(target, ...entry.path.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, { flag: 'wx' });
    if (entry.mode === '100755') await chmod(file, 0o755);
  }
  for (const { entry, content } of ordered.filter(({ entry }) => entry.mode === '120000')) {
    const file = join(target, ...entry.path.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await symlink(content.toString('utf8'), file);
  }
}

function workspacePath(options: WorkspaceOptions): string {
  if (!RUN_ID.test(options.runId)) throw new WorkspaceError(`invalid run id ${JSON.stringify(options.runId)}`);
  return join(options.data, WORKTREES_DIR, options.runId);
}

/**
 * The repository folder, which must be exactly that path on disk: a link named
 * `repos/site` pointing to `kb/private` would be labeled as `repos/site`.
 */
async function repoPath(options: PrepareOptions): Promise<string> {
  if (isAbsolute(options.repo)) throw new WorkspaceError('repo must be relative to ARIANNA_HOME');
  const home = await realpath(options.home);
  const absolute = resolve(home, options.repo);
  if (absolute === home || !within(absolute, home)) throw new WorkspaceError('repo must be inside ARIANNA_HOME');
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    throw new WorkspaceError(`${options.repo} does not exist`);
  }
  if (real !== absolute) throw new WorkspaceError(`${options.repo} goes through a symbolic link`);
  return absolute;
}

/**
 * Every entry under `root`, without following links. A link's target is kept
 * only when its own text stays inside the workspace (relative, not escaping)
 * and it resolves inside: a link through a path outside could be changed after
 * the scan.
 */
export async function scanWorkspace(root: string): Promise<WorkspaceEntry[]> {
  const realRoot = await realpath(root);
  const entries: WorkspaceEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const absolute = join(dir, name);
      const path = relative(root, absolute).split(sep).join('/');
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        let target: string | null = null;
        try {
          const text = await readlink(absolute);
          const lexical = posix.normalize(posix.join(posix.dirname(path), text.split(sep).join('/')));
          const stays = !posix.isAbsolute(text) && lexical !== '..' && !lexical.startsWith('../') && lexical !== '.';
          const fromRoot = relative(realRoot, await realpath(absolute));
          if (stays && fromRoot !== '' && within(join(realRoot, fromRoot), realRoot)) target = fromRoot.split(sep).join('/');
        } catch {
          target = null;
        }
        entries.push({ path, kind: 'symlink', target });
      } else if (stats.isDirectory()) {
        entries.push({ path, kind: 'directory' });
        await walk(absolute);
      } else {
        entries.push({ path, kind: stats.isFile() ? 'file' : 'other' });
      }
    }
  };
  await walk(root);
  return entries;
}

// Workspaces allowed here, and only these, can be the working directory of a
// cloud executor: a literal `{ path }` could point anywhere.
const prepared = new WeakMap<PreparedWorkspace, string>();

/** The real path of a workspace that `prepareWorkspace` allowed; undefined for anything else. */
export function preparedPath(workspace: unknown): string | undefined {
  return typeof workspace === 'object' && workspace !== null ? prepared.get(workspace as PreparedWorkspace) : undefined;
}

/**
 * Checks the allowlist, writes the files of `ref` into `data/worktrees/<runId>`,
 * scans them and, when allowed, makes the folder a new git repository with one
 * commit. A blocked or failed workspace is removed before returning: nothing is
 * left for an executor to open. Throws when the repository is not a git
 * repository at that exact folder, the folder already exists, or git fails.
 */
export async function prepareWorkspace(options: PrepareOptions): Promise<PreparedWorkspace> {
  const target = workspacePath(options);
  if (!isAllowlisted(options.repo, options.allowlist)) {
    return { decision: checkWorkspace({ repo: options.repo, allowlist: options.allowlist, entries: [], rules: options.rules }) };
  }
  const repo = await repoPath(options);
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
  if ((await realpath(top)) !== repo) throw new WorkspaceError(`${options.repo} is not the top folder of a git repository`);
  const ref = options.ref ?? 'HEAD';
  if (!REF.test(ref)) throw new WorkspaceError(`invalid ref ${JSON.stringify(ref)}`);
  const commit = (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();

  await mkdir(join(options.data, WORKTREES_DIR), { recursive: true });
  // Not recursive: an existing folder belongs to another run and is never touched.
  try {
    await mkdir(target);
  } catch {
    throw new WorkspaceError(`workspace ${options.runId} already exists`);
  }
  try {
    await writeTree(repo, target, await listTree(repo, commit));
    const decision = checkWorkspace({
      repo: options.repo,
      allowlist: options.allowlist,
      entries: await scanWorkspace(target),
      rules: options.rules,
    });
    if (decision.decision !== 'allow') {
      await removeWorkspace(options);
      return { decision };
    }
    const identity = ['-c', 'user.name=Arianna', '-c', 'user.email=arianna@localhost', '-c', 'commit.gpgsign=false'];
    await git(target, ['init', '--quiet', '--initial-branch=arianna']);
    await git(target, ['add', '--all']);
    await git(target, [...identity, 'commit', '--quiet', '--allow-empty', '--message', `base ${commit}`]);
    const workspace: PreparedWorkspace = Object.freeze({ decision, path: target });
    // The real path: an executor later checks the folder was not replaced by a link.
    prepared.set(workspace, await realpath(target));
    return workspace;
  } catch (error) {
    await removeWorkspace(options).catch(() => undefined);
    throw error;
  }
}

/** Removes the workspace of a run. It is a plain folder: no repository is involved. */
export async function removeWorkspace(options: WorkspaceOptions): Promise<void> {
  await rm(workspacePath(options), { recursive: true, force: true });
}
