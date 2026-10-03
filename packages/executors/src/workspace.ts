// Where a cloud executor works (docs/PRIVACY-POLICY-SPEC.md, "Confinamento",
// points 1-3): the allowlist, the pre-flight scan, and the folder itself:
// the project folder for an allowlisted repository (`openRepository`, D-056),
// or a dedicated copy in data/worktrees/ (`prepareWorkspace`, D-041), used
// by the evals.
//
// Not a `git worktree`: its `.git` file points to the source repository, whose
// whole history (deleted secrets included) and writable `.git` (hooks, config)
// an executor could then reach. The files of one commit are written out raw
// from the object database (no filters, no hooks run) and a new repository
// with a single commit is created on them, so the executor can still diff.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { checkProject, checkWorkspace, isAllowlisted, type Label, type LabelRules, type WorkspaceDecision, type WorkspaceEntry } from '@arianna/policy';

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
 * Git with a minimal environment: no secret of the core (database passwords,
 * the age key), no GIT_* variables, no system or global configuration
 * (filters, includes, credential helpers of the user), no hooks, no
 * fsmonitor, no network, no optional locks. The configuration of the
 * repository itself (`.git/config`, `.gitattributes`) stays and, in the
 * project folder (D-056), a cloud executor can have written it: every
 * command run here is one that reads no file content through filters, and
 * `gitConfigFingerprint` tells when that configuration changed under a run.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, LANG } = process.env;
  return {
    ...(PATH === undefined ? {} : { PATH }),
    ...(HOME === undefined ? {} : { HOME }),
    LANG: LANG ?? 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
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
async function repoPath(options: { home: string; repo: string }): Promise<string> {
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

// Workspaces allowed here (prepared copies and opened project folders), and
// only these, can be the working directory of a cloud executor: a literal
// `{ path }` could point anywhere.
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

export interface OpenRepositoryOptions {
  /** Absolute ARIANNA_HOME. */
  home: string;
  /** A project of the user's approved list (`[[project]]` of arianna.toml, D-058). */
  project: { name: string; absolute: string; label: Label };
}

export interface OpenedRepository extends PreparedWorkspace {
  /** The branch the folder is on; absent when blocked. */
  branch?: string;
  /** Files changed or added and not committed (`git status`), ignored files left out; absent when blocked. */
  dirty?: string[];
}

/**
 * The folder must be exactly the top of its own repository: a `core.worktree`
 * or a `.git` file written by a run would point git elsewhere.
 */
async function checkedRepository(path: string): Promise<void> {
  let top: string;
  try {
    top = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new WorkspaceError('not the top folder of a git repository');
  }
  if ((await realpath(top)) !== path) throw new WorkspaceError('not the top folder of a git repository');
}

const zList = (out: string): string[] => out.split('\0').filter((item) => item !== '');

/**
 * The paths with changes the user has not committed, ignored files left out:
 * the work tree against the index by stat (`ls-files`, which converts no
 * content and so runs no filter), and the index against HEAD (`diff-index
 * --cached`, which reads no work tree file). Not `git status`: it hashes
 * modified files through the clean filters of the repository's own
 * configuration, which a run may have written.
 */
export async function repositoryStatus(path: string): Promise<string[]> {
  await checkedRepository(path);
  const paths = new Set(zList(await git(path, ['ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard', '--deduplicate'])));
  let hasHead = true;
  try {
    await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    hasHead = false;
  }
  const staged = hasHead ? await git(path, ['diff-index', '--cached', '--name-only', '-z', 'HEAD']) : await git(path, ['ls-files', '-z', '--cached']);
  for (const item of zList(staged)) paths.add(item);
  return [...paths].filter((item) => !item.endsWith('/')).sort();
}

/** Files git reads configuration and attributes from, as a relative list; all `.gitattributes` of the tree included. */
async function gitConfigFiles(root: string): Promise<string[]> {
  const files = ['.git', '.git/config', '.git/info/attributes', '.git/info/exclude'];
  try {
    for (const name of await readdir(join(root, '.git', 'hooks'))) if (!name.endsWith('.sample')) files.push(`.git/hooks/${name}`);
  } catch {
    // No hooks folder.
  }
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      if (rel === '' && name === '.git') continue;
      const absolute = join(dir, name);
      const path = rel === '' ? name : `${rel}/${name}`;
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) await walk(absolute, path);
      else if (name === '.gitattributes') files.push(path);
    }
  };
  await walk(root, '');
  return files;
}

/**
 * Files in the top folder that other tools run code from when the user opens
 * the project with them, often ignored by git and so missing from
 * `repositoryStatus`: Claude Code's own settings and hooks, direnv, editors,
 * dev containers, git hook managers (review of D-058).
 */
const TOOL_CONFIG = ['.claude', '.mcp.json', '.envrc', '.vscode', '.idea', '.devcontainer', '.husky', '.githooks', '.pre-commit-config.yaml'];
const TOOL_CONFIG_MAX_FILES = 5000;

/**
 * A sha256 for each file of the tool configuration of the folder (links by
 * their target text, never followed), by relative path. Taken before a run and
 * compared after it: what changed goes to Arianna with a warning, ignored by
 * git or not. Past `TOOL_CONFIG_MAX_FILES` the rest counts as one entry.
 */
export async function toolConfigFiles(path: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (rel: string): Promise<void> => {
    if (files.size >= TOOL_CONFIG_MAX_FILES) {
      files.set('(more files)', 'over the limit');
      return;
    }
    const absolute = join(path, ...rel.split('/'));
    let stats;
    try {
      stats = await lstat(absolute);
    } catch {
      return;
    }
    if (stats.isSymbolicLink()) files.set(rel, `link:${await readlink(absolute)}`);
    else if (stats.isDirectory()) for (const name of (await readdir(absolute)).sort()) await visit(`${rel}/${name}`);
    else if (stats.isFile()) files.set(rel, createHash('sha256').update(await readFile(absolute)).digest('hex'));
    else files.set(rel, 'other');
  };
  for (const name of TOOL_CONFIG) await visit(name);
  return files;
}

/** The paths whose tool configuration differs between two `toolConfigFiles`. */
export function changedToolConfig(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((rel) => before.get(rel) !== after.get(rel)).sort();
}

/**
 * A fingerprint of everything that makes git run code or read elsewhere in
 * this folder: `.git` itself (a file would point to another repository),
 * `.git/config`, hooks, `info/attributes`, `info/exclude` and every
 * `.gitattributes`. Taken before a run and compared after it (D-056): a
 * change means the run touched the repository's configuration, and no git
 * command of Arianna's runs there until the user has looked.
 */
export async function gitConfigFingerprint(path: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await gitConfigFiles(path)) {
    const absolute = join(path, ...file.split('/'));
    let stats;
    try {
      stats = await lstat(absolute);
    } catch {
      continue;
    }
    hash.update(`${file}\0${stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'dir' : 'file'}\0`);
    if (stats.isFile()) hash.update(await readFile(absolute));
    if (stats.isSymbolicLink()) hash.update(await readlink(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** One entry of the scan for a path git lists, without following links. */
async function entryOf(root: string, realRoot: string, path: string): Promise<WorkspaceEntry> {
  const absolute = join(root, ...path.split('/'));
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
    return { path, kind: 'symlink', target };
  }
  if (stats.isDirectory()) return { path, kind: 'directory' };
  return { path, kind: stats.isFile() ? 'file' : 'other' };
}

/**
 * The folder of an approved project, checked on disk (D-058): an absolute,
 * normalized path that is exactly itself (no link anywhere on the way: a link
 * changed after the approval would move the executor elsewhere), not
 * ARIANNA_HOME nor around it, and inside it only as `repos/<name>`. The
 * configuration checked the path as written; this checks what is on disk.
 */
async function projectPath(options: OpenRepositoryOptions): Promise<string> {
  const { name, absolute } = options.project;
  if (!isAbsolute(absolute) || resolve(absolute) !== absolute) throw new WorkspaceError(`${name}: the project path must be absolute`);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    throw new WorkspaceError(`${name}: the folder ${absolute} does not exist`);
  }
  if (real !== absolute) throw new WorkspaceError(`${name}: the folder goes through a symbolic link`);
  if (!(await lstat(real)).isDirectory()) throw new WorkspaceError(`${name}: not a folder`);
  const home = await realpath(options.home);
  if (within(home, real)) throw new WorkspaceError(`${name}: the folder contains ARIANNA_HOME`);
  if (within(real, home) && real !== join(home, 'repos', name)) throw new WorkspaceError(`${name}: inside ARIANNA_HOME only as repos/${name}`);
  return real;
}

/**
 * Opens the project folder itself as the working directory of a cloud
 * executor (D-056, D-058): the user approved it to let the Coder work there
 * as they do with the CLI. The folder must be exactly the approved path (no
 * link), the top of a git repository; its files are scanned with the
 * project's label, but only the ones git tracks or does not ignore: an
 * ignored `.env` does not stop the launch (the user's choice), as it does not
 * stop their own use of Claude Code. Nothing is copied or created.
 */
export async function openRepository(options: OpenRepositoryOptions): Promise<OpenedRepository> {
  const repo = await projectPath(options);
  try {
    await checkedRepository(repo);
  } catch (error) {
    throw new WorkspaceError(`${options.project.name} is ${error instanceof Error ? error.message : 'not a git repository'}`);
  }
  const entries: WorkspaceEntry[] = [];
  const seen = new Set<string>();
  // Tracked files with their mode: a submodule (160000) is another repository, not scanned here, so it blocks.
  for (const line of zList(await git(repo, ['ls-files', '-z', '--stage']))) {
    const tab = line.indexOf('\t');
    const mode = line.slice(0, 6);
    const path = line.slice(tab + 1);
    if (tab === -1 || seen.has(path)) continue;
    seen.add(path);
    // A path git lists but that is not plain (a `.git` inside, a backslash): it blocks, it is not skipped.
    if (!safeTreePath(path)) {
      entries.push({ path, kind: 'other' });
      continue;
    }
    if (mode === '160000') {
      entries.push({ path, kind: 'other' });
      continue;
    }
    try {
      entries.push(await entryOf(repo, repo, path));
    } catch {
      // Tracked but gone from the work tree: nothing to scan.
    }
  }
  // Untracked, not ignored. A nested repository comes as `name/`: another repository git does not look into, so it blocks.
  for (const path of zList(await git(repo, ['ls-files', '-z', '--others', '--exclude-standard']))) {
    if (path.endsWith('/')) {
      entries.push({ path: path.slice(0, -1), kind: 'other' });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (!safeTreePath(path)) {
      entries.push({ path, kind: 'other' });
      continue;
    }
    try {
      entries.push(await entryOf(repo, repo, path));
    } catch {
      // Listed by git but gone meanwhile: nothing to scan.
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const decision = checkProject({ label: options.project.label, entries });
  if (decision.decision !== 'allow') return { decision };
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const dirty = await repositoryStatus(repo);
  const opened: OpenedRepository = Object.freeze({ decision, path: repo, branch, dirty });
  prepared.set(opened, repo);
  return opened;
}

export interface ReopenOptions extends WorkspaceOptions {
  /** The repository the workspace was prepared from, relative to ARIANNA_HOME. */
  repo: string;
  allowlist: readonly string[];
  rules: LabelRules;
}

/**
 * Opens again a workspace that `prepareWorkspace` made in an earlier process
 * (the core restarted while a cloud run was in progress, task 1.10): the
 * folder must still be a plain folder at that exact path, the top of the
 * repository the preparation created, and the repository must still be
 * allowlisted. Its files, which the executor may have changed, are scanned
 * again. Nothing is removed on a block: the folder belongs to the task.
 */
export async function reopenWorkspace(options: ReopenOptions): Promise<PreparedWorkspace> {
  const target = workspacePath(options);
  if (!isAllowlisted(options.repo, options.allowlist)) {
    return { decision: checkWorkspace({ repo: options.repo, allowlist: options.allowlist, entries: [], rules: options.rules }) };
  }
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new WorkspaceError(`workspace ${options.runId} is gone`);
  }
  if (real !== target) throw new WorkspaceError(`workspace ${options.runId} goes through a symbolic link`);
  if (!(await lstat(target)).isDirectory()) throw new WorkspaceError(`workspace ${options.runId} is not a folder`);
  let top: string;
  try {
    top = (await git(target, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new WorkspaceError(`workspace ${options.runId} is not the repository prepareWorkspace made`);
  }
  if ((await realpath(top)) !== real) throw new WorkspaceError(`workspace ${options.runId} is not the repository prepareWorkspace made`);
  const decision = checkWorkspace({
    repo: options.repo,
    allowlist: options.allowlist,
    entries: await scanWorkspace(target),
    rules: options.rules,
  });
  if (decision.decision !== 'allow') return { decision };
  const workspace: PreparedWorkspace = Object.freeze({ decision, path: target });
  prepared.set(workspace, real);
  return workspace;
}

/** Removes the workspace of a run. It is a plain folder: no repository is involved. */
export async function removeWorkspace(options: WorkspaceOptions): Promise<void> {
  await rm(workspacePath(options), { recursive: true, force: true });
}
