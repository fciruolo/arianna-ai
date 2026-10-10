import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { parseYamlText, sanitizeForTerminal } from '@arianna/agents';

/**
 * A catalog of text downloaded from a public git repository (D-160, D-161):
 * the mechanism shared by the catalog of Open Design and the sources of
 * skills. One source lives in a folder of `data/catalogs` under a prefix:
 *
 *   <prefix>/                 the adopted checkout (text files only, no .git)
 *   <prefix>.index.json       its index (names, descriptions, sha256; never bodies)
 *   <prefix>.lock.json        the adopted commit
 *   <prefix>.next/ + .next.index.json   a version downloaded, waiting for the user
 *   <prefix>.old/             the mark of a swap under way
 *   <prefix>.busy             the one process (core or command) that changes the folders
 *   <prefix>.git-home/        the empty HOME of git
 *
 * "Aggiorna" downloads the newest commit with git (shallow, without blobs,
 * then only the files the source plans from the names of the tree), indexes
 * it and compares it with the adopted version; "Usa questa versione" swaps
 * the folders and writes the lock; "Scarta" deletes the new one. Nothing of
 * the clone ever runs: git is called with fixed arguments, no hooks, no
 * global or system configuration, symbolic links written as plain files,
 * and the `.git` folder is deleted once the commit is read.
 */

/** The refusal while the other process (core or command) holds the catalog. */
export const BUSY_MESSAGE = 'Il catalogo è occupato da un altro processo: riprova quando ha finito.';
/** The refusal of a download while a version downloaded waits for the user. */
export const PENDING_MESSAGE = 'Prima usa o scarta la versione scaricata.';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const COMMIT = /^[0-9a-f]{40}$/;
/** The whole checkout, a guard against a repository that changed shape. */
export const MAX_TREE_FILES = 6000;
export const MAX_TREE_BYTES = 64 * 1024 * 1024;
/** The names of the whole tree listed before any content is fetched. */
const MAX_LISTING_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60_000;
/** The slugs listed for each change, the counts are whole. */
const LISTED_CHANGES = 40;

export class CatalogError extends Error {
  override name = 'CatalogError';
  readonly code: 'invalid' | 'not-found' | 'conflict' | 'blocked' | 'failed';

  constructor(code: CatalogError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** Decides whether the address of the repository may be requested; throws when not (the gateway). */
export type CatalogGateway = (repository: string) => Promise<void>;

export interface CatalogRejection {
  path: string;
  reason: string;
}

/** What every entry of an index has: compared by kind, slug and sha256. */
export interface CatalogEntry {
  kind: string;
  slug: string;
  sha256: string;
}

export interface CatalogIndex<E extends CatalogEntry = CatalogEntry> {
  version: 1;
  repository: string;
  commit: string;
  committedAt: string | null;
  fetchedAt: string;
  entries: E[];
  rejected: CatalogRejection[];
}

export interface CatalogLock {
  repository: string;
  commit: string;
  committedAt: string | null;
  adoptedAt: string;
}

export interface KindChanges {
  added: number;
  removed: number;
  changed: number;
  /** The first slugs of each change, sorted. */
  addedSlugs: string[];
  removedSlugs: string[];
  changedSlugs: string[];
}

export interface JobView {
  status: 'running' | 'done' | 'failed';
  phase: 'download' | 'index' | null;
  startedAt: string;
  finishedAt: string | null;
  /** `unchanged`: the newest commit is the adopted one, nothing to adopt. */
  outcome: 'pending' | 'unchanged' | null;
  error: string | null;
}

/**
 * The environment of git, built from nothing: no global or system
 * configuration (no credential helpers, no aliases, no filters of the user),
 * HOME and XDG_CONFIG_HOME on an empty folder (no .netrc, no attributes of
 * the user), no prompt, no LFS, only the protocol of the repository.
 */
export function gitEnv(from: NodeJS.ProcessEnv, protocol: 'https' | 'file', home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    const value = from[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'true',
    SSH_ASKPASS: 'true',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: protocol,
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/** Before every git command: nothing configured can run. */
export const GIT_SAFE_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.symlinks=false',
  '-c', 'credential.helper=',
  '-c', 'protocol.file.allow=user',
  '-c', 'advice.detachedHead=false',
  '-c', 'submodule.recurse=false',
];

function runGit(git: string, args: readonly string[], env: Record<string, string>, cwd: string, options: { maxBuffer?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(git, [...GIT_SAFE_CONFIG, ...args], { cwd, env, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: options.maxBuffer ?? 1024 * 1024, encoding: 'utf8', shell: false }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
        return;
      }
      const why = error.killed === true ? 'took too long' : sanitizeForTerminal(stderr.trim().split('\n').slice(-2).join(' ')).slice(0, 300) || error.message;
      reject(new CatalogError('failed', `git ${args[0] ?? ''}: ${why}`));
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
  });
}

/** One line of third-party text, made safe to show: deceptive characters out, spaces folded, capped. */
export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = sanitizeForTerminal(value.replace(/\s+/g, ' ')).replace(/\?{2,}/g, '?').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function sha256(text: Buffer | string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A regular file, read with its size checked first; undefined for nothing there. */
export function readRegular(path: string, max: number): { buffer: Buffer } | { refused: string } | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) return { refused: 'symbolic link' };
  if (!stat.isFile()) return { refused: 'not a regular file' };
  if (stat.size > max) return { refused: `larger than ${String(Math.round(max / 1024))} KiB` };
  const buffer = readFileSync(path);
  if (buffer.length > max) return { refused: `larger than ${String(Math.round(max / 1024))} KiB` };
  return { buffer };
}

/** U+FFFD, where a byte was not UTF-8. */
const REPLACEMENT = String.fromCodePoint(0xfffd);
const BOM = new RegExp(`^${String.fromCodePoint(0xfeff)}`);

/** The text of a file, undefined when it is not UTF-8 or holds a NUL. */
export function utf8(buffer: Buffer): string | undefined {
  const text = buffer.toString('utf8');
  if (text.includes(REPLACEMENT) || text.includes('\u0000')) return undefined;
  return text.replace(BOM, '').replace(/\r\n?/g, '\n');
}

const MAX_FRONTMATTER_BYTES = 16 * 1024;

/** The frontmatter of a markdown file as a table of the own `keys`; undefined without one. */
export function frontmatter(text: string, path: string, keys: readonly string[] = ['name', 'description']): Record<string, unknown> | undefined {
  if (!text.startsWith('---\n')) return undefined;
  const close = /\n---[ \t]*(?:\n|$)/.exec(text.slice(3));
  if (close === null) return undefined;
  const front = text.slice(4, 3 + close.index + 1);
  if (Buffer.byteLength(front, 'utf8') > MAX_FRONTMATTER_BYTES) throw new CatalogError('invalid', 'frontmatter too large');
  const raw = parseYamlText(front, path);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const table: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(raw, key)) table[key] = (raw as Record<string, unknown>)[key];
  return table;
}

/** The body of a markdown file after its frontmatter. */
export function afterFrontmatter(text: string): string {
  if (!text.startsWith('---\n')) return text;
  const close = /\n---[ \t]*(?:\n|$)/.exec(text.slice(3));
  return close === null ? text : text.slice(3 + close.index + close[0].length);
}

/** Controls (but line feed and tab), bidirectional and zero-width characters: they can hide text from the reader. */
// eslint-disable-next-line no-control-regex
const HIDDEN_IN_BODY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

/** The body of a third-party file, made safe to show: the hidden characters go, lines and tabs stay. */
export function cleanBody(text: string): string {
  return text.replace(HIDDEN_IN_BODY, '');
}

/** A multi-line third-party text (a NOTICE): line by line, the breaks stay, every other control goes. */
export function cleanLines(text: string): string {
  return text.trim().split('\n').map((line) => sanitizeForTerminal(line.replace(/\t/g, ' ')).trimEnd()).join('\n');
}

export function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/**
 * Every file of the checkout, outside `.git`, without following links: the
 * shape the repository may have. Throws past the limits of files or bytes.
 */
async function measureTree(root: string, maxFiles: number): Promise<{ files: number; bytes: number; links: string[] }> {
  const result = { files: 0, bytes: 0, links: [] as string[] };
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 12) throw new CatalogError('invalid', 'the checkout is deeper than expected');
    for (const name of (await readdir(join(root, relative))).sort()) {
      if (relative === '' && name === '.git') continue;
      const shown = relative === '' ? name : `${relative}/${name}`;
      const stat = await lstat(join(root, shown));
      if (stat.isSymbolicLink()) result.links.push(shown);
      else if (stat.isDirectory()) await walk(shown, depth + 1);
      else {
        result.files += 1;
        result.bytes += stat.size;
        if (result.files > maxFiles) throw new CatalogError('invalid', `more than ${String(maxFiles)} files in the catalog`);
        if (result.bytes > MAX_TREE_BYTES) throw new CatalogError('invalid', `the catalog is larger than ${String(MAX_TREE_BYTES / 1024 / 1024)} MB`);
      }
    }
  };
  await walk('', 0);
  return result;
}

/** What a new version adds, takes away and changes for one kind, by slug and sha256 of the file. */
export function kindChanges(before: readonly CatalogEntry[], after: readonly CatalogEntry[], kind: string): KindChanges {
  const old = new Map(before.filter((entry) => entry.kind === kind).map((entry) => [entry.slug, entry.sha256]));
  const now = new Map(after.filter((entry) => entry.kind === kind).map((entry) => [entry.slug, entry.sha256]));
  const added = [...now.keys()].filter((slug) => !old.has(slug)).sort();
  const removed = [...old.keys()].filter((slug) => !now.has(slug)).sort();
  const changed = [...now.entries()].filter(([slug, sha]) => old.has(slug) && old.get(slug) !== sha).map(([slug]) => slug).sort();
  return {
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    addedSlugs: added.slice(0, LISTED_CHANGES),
    removedSlugs: removed.slice(0, LISTED_CHANGES),
    changedSlugs: changed.slice(0, LISTED_CHANGES),
  };
}

function sameEntries(before: readonly CatalogEntry[], after: readonly CatalogEntry[]): boolean {
  const key = (entry: CatalogEntry): string => `${entry.kind}\u0000${entry.slug}\u0000${entry.sha256}`;
  const old = new Set(before.map(key));
  return before.length === after.length && after.every((entry) => old.has(key(entry)));
}

function isIndex(value: unknown): value is CatalogIndex {
  if (typeof value !== 'object' || value === null) return false;
  const index = value as Partial<CatalogIndex>;
  return index.version === 1 && typeof index.commit === 'string' && COMMIT.test(index.commit) && Array.isArray(index.entries) && Array.isArray(index.rejected);
}

/** An index written by the catalog; undefined when missing or not one. The caller names the index of its own files. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function readIndexFile<I extends CatalogIndex>(path: string): I | undefined {
  const read = readRegular(path, 16 * 1024 * 1024);
  if (read === undefined || 'refused' in read) return undefined;
  try {
    const parsed = JSON.parse(read.buffer.toString('utf8')) as unknown;
    return isIndex(parsed) ? (parsed as I) : undefined;
  } catch {
    return undefined;
  }
}

function readLock(path: string): CatalogLock | undefined {
  const read = readRegular(path, 64 * 1024);
  if (read === undefined || 'refused' in read) return undefined;
  try {
    const parsed = JSON.parse(read.buffer.toString('utf8')) as Partial<CatalogLock>;
    if (typeof parsed.commit !== 'string' || !COMMIT.test(parsed.commit) || typeof parsed.repository !== 'string' || typeof parsed.adoptedAt !== 'string') return undefined;
    return { repository: parsed.repository, commit: parsed.commit, committedAt: typeof parsed.committedAt === 'string' ? parsed.committedAt : null, adoptedAt: parsed.adoptedAt };
  } catch {
    return undefined;
  }
}

/** Written next to the target and renamed over it: a reader sees the old file or the new one. */
export function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Whether a process lives: the signal 0 asks without sending anything. */
function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A busy file left by a process that no longer lives (or unreadable and older than a minute). */
function abandoned(path: string): boolean {
  let text: string;
  let age: number;
  try {
    text = readFileSync(path, 'utf8');
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    // Gone in the meantime: free.
    return true;
  }
  const pid = Number(/^(\d+)\n/.exec(text)?.[1] ?? Number.NaN);
  if (!Number.isSafeInteger(pid) || pid <= 0) return age > 60_000;
  return !processAlive(pid);
}

/**
 * Takes a busy file, created exclusively with the pid and a token; false
 * while another process that lives holds it. One left by a process that
 * died is taken over.
 */
export function takeBusy(path: string, token: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, `${String(process.pid)}\n${token}\n`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!abandoned(path)) return false;
    rmSync(path, { force: true });
  }
  return false;
}

/** Gives the busy file back, only if it is still the one taken with `token`. */
export function releaseBusy(path: string, token: string): void {
  try {
    if (readFileSync(path, 'utf8').split('\n')[1] === token) rmSync(path, { force: true });
  } catch {
    // Already gone.
  }
}

/** What the source does with the names of the tree and the checkout. */
export interface GitSourceSpec<I extends CatalogIndex, P> {
  /** `data/catalogs` or a folder in it. */
  dir: string;
  /** The names of the files of this source in `dir`. */
  prefix: string;
  /** Already checked: https of github.com, or file:// in tests. */
  repository: string;
  /** Asked before every download, with the address only. */
  gateway: CatalogGateway;
  /** Kind of the events: `<events>.downloaded`, `.failed`, `.adopted`, `.discarded`. */
  events: string;
  /**
   * From the names of every file of HEAD (no content fetched yet): the
   * sparse patterns to check out, or a refusal past the limits. What it
   * returns besides goes to `build`.
   */
  plan: (names: readonly string[]) => P & { patterns: readonly string[] };
  /** The index of the checkout, without `.git`: throws to refuse the version. */
  build: (root: string, plan: P, base: Omit<CatalogIndex, 'entries' | 'rejected'> & { links: string[] }) => I;
  /** Numbers of an index for the events. */
  counts: (index: I) => Record<string, number>;
  maxTreeFiles: number;
  /** Repairs a swap or a download cut short when created (default true), only if no other process holds the source. */
  recover?: boolean;
  onEvent?: (kind: string, payload: Record<string, string | number>) => void;
  env?: NodeJS.ProcessEnv;
  git?: string;
  now?: () => Date;
}

export interface GitSource<I extends CatalogIndex> {
  readonly repository: string;
  /** The adopted checkout. */
  readonly root: string;
  adopted(): { index: I; lock: CatalogLock } | undefined;
  /** The version waiting for the user; none while a download runs. */
  pending(): I | undefined;
  job(): JobView | null;
  /** Starts the download in the background; refused while one runs or a version waits. */
  update(): void;
  idle(): Promise<void>;
  /** Adopts the version waiting, which must be `commit` (the one the user saw). */
  adopt(commit: unknown): I;
  /** Deletes the version waiting; the index it had, if any. */
  discard(): I | undefined;
  /**
   * Deletes every file of the source, under its busy file. `first` runs
   * under it before anything is deleted (a throw deletes nothing); with
   * `folder` every other file of `dir` goes too, the busy file last, and
   * the folder once empty.
   */
  erase(options?: { first?: () => void; folder?: boolean }): void;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T[\d:]+(?:[+-]\d{2}:\d{2}|Z)$/;

export function createGitSource<I extends CatalogIndex, P>(spec: GitSourceSpec<I, P>): GitSource<I> {
  const now = spec.now ?? (() => new Date());
  const git = spec.git ?? 'git';
  const at = (suffix: string): string => join(spec.dir, `${spec.prefix}${suffix}`);
  const CLONE = at('');
  const NEXT = at('.next');
  const OLD = at('.old');
  const INDEX = at('.index.json');
  const NEXT_INDEX = at('.next.index.json');
  const LOCK = at('.lock.json');
  const BUSY = at('.busy');
  const GIT_HOME = at('.git-home');
  const env = gitEnv(spec.env ?? process.env, spec.repository.startsWith('file:') ? 'file' : 'https', GIT_HOME);
  let job: JobView | null = null;
  let running: Promise<void> = Promise.resolve();
  const event = (kind: string, payload: Record<string, string | number>): void => {
    try {
      spec.onEvent?.(`${spec.events}.${kind}`, payload);
    } catch {
      // An event that cannot be written never stops the catalog.
    }
  };

  /** The busy file for this process, or the refusal: one process at a time changes the folders. */
  function hold(): string {
    mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    if (!takeBusy(BUSY, token)) throw new CatalogError('conflict', BUSY_MESSAGE);
    return token;
  }

  /** Back to the adopted folder: OLD takes its name again (an empty OLD marked a first adoption). */
  function undoSwap(): void {
    if (isRealDir(CLONE) || isEmptyDir(OLD)) rmSync(OLD, { recursive: true, force: true });
    else renameSync(OLD, CLONE);
  }

  /** On to the new folder, already in place: its index, the lock written from the index, OLD away. */
  function finishSwap(): void {
    if (existsSync(NEXT_INDEX)) renameSync(NEXT_INDEX, INDEX);
    const index = readIndexFile<I>(INDEX);
    if (index !== undefined && readLock(LOCK)?.commit !== index.commit) {
      writeAtomic(LOCK, { repository: index.repository, commit: index.commit, committedAt: index.committedAt, adoptedAt: now().toISOString() } satisfies CatalogLock);
    }
    rmSync(OLD, { recursive: true, force: true });
  }

  /**
   * Under the busy file: a swap or a download cut short by a stop. OLD there
   * means a swap under way: with the new folder still waiting it goes back,
   * with the new folder in place it goes forward. A download without its
   * index goes, and an index without its download.
   */
  function recover(): void {
    for (const path of [LOCK, INDEX, NEXT_INDEX]) rmSync(`${path}.tmp`, { force: true });
    if (existsSync(OLD)) {
      if (isRealDir(NEXT) || !isRealDir(CLONE)) undoSwap();
      else finishSwap();
    }
    if (existsSync(NEXT) && readIndexFile(NEXT_INDEX) === undefined) rmSync(NEXT, { recursive: true, force: true });
    if (!existsSync(NEXT)) rmSync(NEXT_INDEX, { force: true });
  }

  // At the start, only while no other process holds the source: never under its feet.
  if (spec.recover !== false && isRealDir(spec.dir)) {
    const token = randomUUID();
    if (takeBusy(BUSY, token)) {
      try {
        recover();
      } finally {
        releaseBusy(BUSY, token);
      }
    }
  }

  function adopted(): { index: I; lock: CatalogLock } | undefined {
    const lock = readLock(LOCK);
    const index = readIndexFile<I>(INDEX);
    if (lock === undefined || index === undefined || index.commit !== lock.commit || !isRealDir(CLONE)) return undefined;
    return { index, lock };
  }

  function pending(): I | undefined {
    if (job?.status === 'running' || !isRealDir(NEXT)) return undefined;
    return readIndexFile<I>(NEXT_INDEX);
  }

  async function download(): Promise<void> {
    const started = Date.now();
    await rm(NEXT, { recursive: true, force: true });
    await rm(NEXT_INDEX, { force: true });
    await mkdir(spec.dir, { recursive: true, mode: 0o700 });
    // git finds nothing of the user in its HOME: an empty folder, made again each time.
    await rm(GIT_HOME, { recursive: true, force: true });
    await mkdir(GIT_HOME, { mode: 0o700 });
    try {
      await spec.gateway(spec.repository);
    } catch (error) {
      throw new CatalogError('blocked', `the gateway did not let the request out: ${error instanceof Error ? error.message : String(error)}`);
    }
    await runGit(git, ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', '--sparse', '--single-branch', '--no-tags', '--', spec.repository, NEXT], env, spec.dir);
    // The trees are here, the contents not yet: the source plans what to check
    // out from the names alone (the sizes would fetch each blob: they are
    // measured after, on the disk).
    const listed = await runGit(git, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { ...env, GIT_NO_LAZY_FETCH: '1' }, NEXT, { maxBuffer: MAX_LISTING_BYTES });
    const plan = spec.plan(listed.split('\0').filter((name) => name !== ''));
    await runGit(git, ['sparse-checkout', 'set', '--no-cone', '--stdin'], env, NEXT, { input: `${plan.patterns.join('\n')}\n` });
    // The index and the files of HEAD, within the sparse patterns: the blobs come now, only these.
    await runGit(git, ['read-tree', '-mu', 'HEAD'], env, NEXT);
    const commit = (await runGit(git, ['rev-parse', 'HEAD'], env, NEXT)).trim();
    if (!COMMIT.test(commit)) throw new CatalogError('failed', 'git did not give a commit');
    const date = (await runGit(git, ['log', '-1', '--format=%cI', 'HEAD'], env, NEXT)).trim();
    // Nothing reads git again in this folder.
    await rm(join(NEXT, '.git'), { recursive: true, force: true });
    if (job !== null) job.phase = 'index';
    const tree = await measureTree(NEXT, spec.maxTreeFiles);
    const index = spec.build(NEXT, plan, {
      version: 1,
      repository: spec.repository,
      commit,
      committedAt: ISO_DATE.test(date) ? date : null,
      fetchedAt: now().toISOString(),
      links: tree.links,
    });
    const current = adopted();
    const same = current !== undefined && current.index.commit === commit && sameEntries(current.index.entries, index.entries);
    if (same) {
      await rm(NEXT, { recursive: true, force: true });
      if (job !== null) job.outcome = 'unchanged';
    } else {
      writeAtomic(NEXT_INDEX, index);
      if (job !== null) job.outcome = 'pending';
    }
    event('downloaded', { commit, ...spec.counts(index), rejected: index.rejected.length, files: tree.files, bytes: tree.bytes, ms: Date.now() - started, outcome: same ? 'unchanged' : 'pending' });
  }

  function update(): void {
    if (job?.status === 'running') throw new CatalogError('conflict', 'a download of the catalog is already running');
    // Held for the whole download: the other process neither cleans nor swaps meanwhile.
    const token = hold();
    try {
      recover();
      if (pending() !== undefined) throw new CatalogError('conflict', PENDING_MESSAGE);
    } catch (error) {
      releaseBusy(BUSY, token);
      throw error;
    }
    const started: JobView = { status: 'running', phase: 'download', startedAt: now().toISOString(), finishedAt: null, outcome: null, error: null };
    job = started;
    running = download()
      .then(
        () => {
          started.status = 'done';
          started.phase = null;
          started.finishedAt = now().toISOString();
        },
        async (error: unknown) => {
          started.status = 'failed';
          started.phase = null;
          started.finishedAt = now().toISOString();
          started.error = error instanceof CatalogError ? error.message : 'the download failed';
          await rm(NEXT, { recursive: true, force: true }).catch(() => undefined);
          await rm(NEXT_INDEX, { force: true }).catch(() => undefined);
          event('failed', { reason: cleanLine(started.error, 200) });
        },
      )
      .finally(() => {
        releaseBusy(BUSY, token);
      });
  }

  /**
   * The swap: OLD steps aside (an empty OLD the first time, as the mark of a
   * swap under way), NEXT takes the name, then the index and the lock. An
   * error goes back while the old index is still there, forward after;
   * what cannot be done now is left to recover().
   */
  function swap(next: I): void {
    if (existsSync(CLONE)) renameSync(CLONE, OLD);
    else mkdirSync(OLD, { mode: 0o700 });
    let step: 'old' | 'placed' | 'indexed' = 'old';
    try {
      renameSync(NEXT, CLONE);
      step = 'placed';
      renameSync(NEXT_INDEX, INDEX);
      step = 'indexed';
      writeAtomic(LOCK, { repository: next.repository, commit: next.commit, committedAt: next.committedAt, adoptedAt: now().toISOString() } satisfies CatalogLock);
    } catch (error) {
      try {
        if (step === 'placed') renameSync(CLONE, NEXT);
        if (step === 'indexed') finishSwap();
        else undoSwap();
      } catch {
        // recover() finishes the work at the next start or action.
      }
      throw new CatalogError('failed', `the swap of the catalog did not complete: ${cleanLine(error instanceof Error ? error.message : String(error), 200)}`);
    }
    rmSync(OLD, { recursive: true, force: true });
  }

  function adopt(commit: unknown): I {
    if (job?.status === 'running') throw new CatalogError('conflict', 'a download of the catalog is running');
    if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new CatalogError('invalid', 'commit must be the full sha of the version shown');
    const token = hold();
    let next: I | undefined;
    try {
      recover();
      next = pending();
      if (next === undefined) throw new CatalogError('not-found', 'no new version is waiting');
      if (next.commit !== commit) throw new CatalogError('conflict', 'the version waiting is not the one shown: read the status again');
      swap(next);
    } finally {
      releaseBusy(BUSY, token);
    }
    job = null;
    event('adopted', { commit: next.commit, ...spec.counts(next) });
    return next;
  }

  function discard(): I | undefined {
    if (job?.status === 'running') throw new CatalogError('conflict', 'a download of the catalog is running');
    const token = hold();
    let next: I | undefined;
    try {
      recover();
      next = pending();
      if (next === undefined && !existsSync(NEXT)) throw new CatalogError('not-found', 'no new version is waiting');
      rmSync(NEXT, { recursive: true, force: true });
      rmSync(NEXT_INDEX, { force: true });
    } finally {
      releaseBusy(BUSY, token);
    }
    job = null;
    event('discarded', { commit: next?.commit ?? '' });
    return next;
  }

  function erase(options: { first?: () => void; folder?: boolean } = {}): void {
    if (job?.status === 'running') throw new CatalogError('conflict', 'a download of the catalog is running');
    const token = hold();
    try {
      options.first?.();
      for (const path of [NEXT, OLD, CLONE, GIT_HOME]) rmSync(path, { recursive: true, force: true });
      for (const path of [NEXT_INDEX, INDEX, LOCK]) {
        rmSync(path, { force: true });
        rmSync(`${path}.tmp`, { force: true });
      }
      if (options.folder === true) {
        for (const name of readdirSync(spec.dir)) {
          if (join(spec.dir, name) !== BUSY) rmSync(join(spec.dir, name), { recursive: true, force: true });
        }
      }
    } finally {
      releaseBusy(BUSY, token);
    }
    job = null;
    if (options.folder === true) {
      try {
        // Only once empty: a process that took the busy file meanwhile keeps the folder.
        rmdirSync(spec.dir);
      } catch {
        // Not empty or already gone.
      }
    }
  }

  return {
    repository: spec.repository,
    root: CLONE,
    adopted,
    pending,
    job: () => (job === null ? null : { ...job }),
    update,
    idle: () => running,
    adopt,
    discard,
    erase,
  };
}
