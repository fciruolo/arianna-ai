import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { sanitizeForTerminal } from '@arianna/agents';
import { PROJECTS_DIR } from '@arianna/config';

import { gitEnv, GIT_SAFE_CONFIG } from '../git-catalog.ts';

/**
 * GOD, Arianna developed from inside Arianna (D-127). The code of Arianna is
 * worked on in clones of this repository, never in ARIANNA_HOME itself:
 *
 *   repos/arianna/            the container, the project `arianna` (L1, D-145)
 *   repos/arianna/main/       the clone GOD reads (part `arianna:main`)
 *   repos/arianna/g<NNN>-…/   one clone per subtask, on its branch god/<part>
 *
 * A clone is made from the local repository (no network) and holds only what
 * is in git: no data/ (database, vault, archive, the real knowledge base), no
 * config/arianna.toml, no conversation. That is the guarantee of privacy: the
 * cloud executors that work there never see the installation. The work goes
 * back into ARIANNA_HOME only through git, as branches the user merges.
 *
 * git runs here with an environment built from nothing and no hooks (the
 * clone's files are written by cloud executors: nothing of them runs here).
 */
export const GOD_PROJECT = 'arianna';
/** The agent of GOD's chat (agents/god.yaml): only in a direct chat on the container, never a target of Arianna's delegations. */
export const GOD_AGENT = 'god';
/** The part of the clone GOD reads and the main branch of every clone. */
export const GOD_MAIN = 'main';
/** The container, relative to ARIANNA_HOME. */
export const GOD_CONTAINER = `${PROJECTS_DIR}/${GOD_PROJECT}`;
/**
 * The mark of a clone of GOD, in its git folder (read only for the cloud
 * executors, D-174): docker compose refuses to run there (scripts/compose.ts),
 * so that a clone never recreates the database of the installation.
 */
export const GOD_MARKER = 'arianna-god';
/**
 * The line of the mark that says how the clone was made: `--no-local
 * --single-branch` from the installation's main only. A clone made before it
 * (a local clone copied the whole object database: the stash and the objects
 * no branch reaches) is refused, and has to be made again.
 */
export const GOD_MARKER_VERSION = 'clone: main only, no-local (D-127 v2)';
/** The name of a subtask's part and of its branch's last segment: `g<NNN>-<slug>`. */
export const SUBTASK_PART = /^g[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$/;
/** The branch of a subtask in its clone. */
export function subtaskBranch(part: string): string {
  return `god/${part}`;
}

const GIT_TIMEOUT_MS = 10 * 60_000;

export class GodCloneError extends Error {
  override name = 'GodCloneError';
}

/** The folder of a part of the container: `main` or a subtask's. */
export function godPartDir(home: string, part: string): string {
  if (part !== GOD_MAIN && !SUBTASK_PART.test(part)) throw new GodCloneError(`invalid part ${JSON.stringify(part)}`);
  return join(home, GOD_CONTAINER, part);
}

/** `arianna:<part>`, the project of a conversation on that clone. */
export function godWorkspace(part: string): string {
  return `${GOD_PROJECT}:${part}`;
}

/** The part of a conversation's project when it is one of the container of GOD, else undefined. */
export function godPartOf(workspace: string | null | undefined): string | undefined {
  if (typeof workspace !== 'string' || !workspace.startsWith(`${GOD_PROJECT}:`)) return undefined;
  const part = workspace.slice(GOD_PROJECT.length + 1);
  return part === GOD_MAIN || SUBTASK_PART.test(part) ? part : undefined;
}

/** What makes a folder not a development copy, in the words the user reads. */
const FORBIDDEN_DATA = ['vault', 'postgres', 'archive', 'kb', 'models'];

/**
 * Why a clone is not a development copy, or undefined when it is one (D-127).
 * A tripwire, not the guarantee (the guarantee is that the clone is made by
 * git from the repository): it catches the data of an installation copied in
 * by hand. Refused: a `.git` that is not a folder (a linked worktree points
 * into another repository), a data/ holding the folders of an installation
 * (vault, database, archive, knowledge base, models), a config/arianna.toml
 * with the passwords of the database set (development uses the defaults).
 */
export function godCloneRefusal(dir: string): string | undefined {
  try {
    if (!lstatSync(dir).isDirectory()) return 'la cartella del clone non è una cartella';
  } catch {
    return 'il clone non c’è: crealo con pnpm god:clone';
  }
  try {
    if (!lstatSync(join(dir, '.git')).isDirectory()) return 'il clone non ha una cartella .git sua (è un worktree collegato a un altro repository)';
  } catch {
    return 'il clone non è un repository git';
  }
  let marker: string;
  try {
    marker = readFileSync(join(dir, '.git', GOD_MARKER), 'utf8');
  } catch {
    return 'la cartella non è un clone fatto da GOD: cancellala e rifalla con pnpm god:clone';
  }
  if (!marker.includes(GOD_MARKER_VERSION)) return 'il clone è stato fatto con il metodo vecchio, che copiava anche lo stash e gli oggetti non raggiungibili dell’installazione: cancella la cartella e rifallo con pnpm god:clone';
  for (const name of FORBIDDEN_DATA) {
    if (present(join(dir, 'data', name))) return `il clone contiene data/${name}: sembra un’installazione con dati veri, non una copia di sviluppo`;
  }
  const config = join(dir, 'config', 'arianna.toml');
  if (existsSync(config)) {
    let text: string;
    try {
      text = readFileSync(config, 'utf8');
    } catch {
      return 'config/arianna.toml del clone non si legge';
    }
    if (/^\s*(password|app_password)\s*=/m.test(text)) return 'config/arianna.toml del clone imposta le password del database: non è quello di sviluppo';
  }
  return undefined;
}

/** True when something is at `path`, a link included (never followed). */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `inner` is inside `outer` (not equal). */
function inside(inner: string, outer: string): boolean {
  const path = relative(outer, inner);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

export interface GitOptions {
  /** Written to the standard input. */
  input?: string;
  /** Exit codes that are answers, not errors (`check-ignore` says 1 for "none"). */
  okCodes?: readonly number[];
}

export interface GitRunner {
  (args: readonly string[], cwd: string, options?: GitOptions): Promise<string>;
}

/** git with an environment built from nothing (git-catalog.ts) and no hooks; `HOME` an empty folder of data/. */
export function godGit(home: string, data: string, options: { git?: string; env?: NodeJS.ProcessEnv } = {}): GitRunner {
  const gitHome = join(data, 'god', 'git-home');
  return (args, cwd, run = {}) => {
    mkdirSync(gitHome, { recursive: true, mode: 0o700 });
    const env = { ...gitEnv(options.env ?? process.env, 'file', gitHome), GIT_NO_LAZY_FETCH: '1' };
    return new Promise((resolve, reject) => {
      const child = execFile(options.git ?? 'git', [...GIT_SAFE_CONFIG, ...args], { cwd, env, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', shell: false }, (error, stdout, stderr) => {
        if (error === null || (typeof error.code === 'number' && (run.okCodes ?? []).includes(error.code))) {
          resolve(stdout);
          return;
        }
        const why = error.killed ? 'took too long' : sanitizeForTerminal(stderr.trim().split('\n').slice(-2).join(' ')).slice(0, 300) || error.message;
        reject(new GodCloneError(`git ${args[0] ?? ''}: ${why}`));
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(run.input ?? '');
    });
  };
}

export interface CloneState {
  /** The part's folder, relative to ARIANNA_HOME. */
  path: string;
  exists: boolean;
  /** Why it is not a development copy; undefined when it is. */
  refusal?: string;
  branch?: string;
  head?: string;
  /** Commits of ARIANNA_HOME's main the clone has not fetched or merged yet; undefined when unknown. */
  behind?: number;
  /** Files changed and not committed in the clone. */
  dirty?: number;
}

/** The current branch, HEAD and changes of a clone, and how far it is behind the main of the installation. */
export async function cloneState(home: string, data: string, part: string, git: GitRunner = godGit(home, data)): Promise<CloneState> {
  const dir = godPartDir(home, part);
  const path = relative(home, dir).split(sep).join('/');
  if (!existsSync(dir)) return { path, exists: false };
  const refusal = godCloneRefusal(dir);
  if (refusal !== undefined) return { path, exists: true, refusal };
  const state: CloneState = { path, exists: true };
  try {
    state.branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
    state.head = (await git(['rev-parse', 'HEAD'], dir)).trim();
    state.dirty = (await git(['status', '--porcelain', '--untracked-files=all'], dir)).split('\n').filter((line) => line !== '').length;
    const main = (await git(['rev-parse', `refs/heads/${GOD_MAIN}`], home)).trim();
    // Commits of the installation's main that are not in the clone's HEAD (known only once fetched).
    const known = await git(['cat-file', '-e', `${main}^{commit}`], dir).then(
      () => true,
      () => false,
    );
    if (known) state.behind = Number((await git(['rev-list', '--count', `HEAD..${main}`], dir)).trim());
  } catch {
    // A clone git cannot read: shown as it is, without numbers.
  }
  return state;
}

/** Writes the mark of a clone of GOD in its git folder. */
function mark(dir: string): void {
  writeFileSync(join(dir, '.git', GOD_MARKER), `A clone of GOD (D-127): docker compose is refused here, the database is the installation's.\n${GOD_MARKER_VERSION}\n`);
}

/** The installation as the clones' origin: a file URL, so that git transfers objects as over a network (only what main reaches), never copying the object database. */
export function originOf(home: string): string {
  return `file://${home}`;
}

/** Makes a clone of the installation's main only: no stash, no other branch, no tag, no object main does not reach. */
async function cloneMain(home: string, dir: string, git: GitRunner): Promise<void> {
  mkdirSync(join(home, GOD_CONTAINER), { recursive: true });
  await git(['clone', '--quiet', '--no-local', '--single-branch', '--no-tags', '--branch', GOD_MAIN, '--', originOf(home), dir], home);
  mark(dir);
}

export interface SyncResult {
  created: boolean;
  /** The clone moved forward to the installation's main (clean, on main). */
  forwarded: boolean;
  state: CloneState;
  /** A new clone that could not be fully prepared (prepare.ts): why. */
  warning?: string;
}

/**
 * Creates the clone GOD reads, `repos/arianna/main`, from ARIANNA_HOME, or
 * updates it: fetch from the installation, then a fast-forward of its main
 * when it is on main with nothing changed. Never touches a clone with work in
 * it beyond the fetch. Refuses a folder that is not a development copy.
 */
export async function syncGodClone(home: string, data: string, git: GitRunner = godGit(home, data), prepare?: (dir: string) => Promise<void>): Promise<SyncResult> {
  return syncPart(home, data, GOD_MAIN, git, prepare);
}

async function syncPart(home: string, data: string, part: string, git: GitRunner, prepare?: (dir: string) => Promise<void>): Promise<SyncResult> {
  const dir = godPartDir(home, part);
  if (!inside(dir, home)) throw new GodCloneError('the clone must be inside ARIANNA_HOME');
  let created = false;
  if (!existsSync(dir)) {
    await cloneMain(home, dir, git);
    created = true;
  } else {
    const refusal = godCloneRefusal(dir);
    if (refusal !== undefined) throw new GodCloneError(refusal);
  }
  // The installation may have moved (ARIANNA_HOME is portable): the remote is set again every time.
  await git(['remote', 'set-url', 'origin', originOf(home)], dir);
  // Only main, as the clone: never the other branches, the tags or the stash of the installation.
  if (!created) await git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${GOD_MAIN}:refs/remotes/origin/${GOD_MAIN}`], dir);
  // A new clone gets what the sandbox cannot fetch (prepare.ts), before any agent works there.
  let warning: string | undefined;
  if (created && prepare !== undefined) {
    await prepare(dir).catch((error: unknown) => {
      warning = error instanceof Error ? error.message : String(error);
    });
  }
  let forwarded = false;
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
  const dirty = (await git(['status', '--porcelain', '--untracked-files=all'], dir)).trim() !== '';
  if (!created && branch === GOD_MAIN && !dirty) {
    const before = (await git(['rev-parse', 'HEAD'], dir)).trim();
    await git(['merge', '--quiet', '--ff-only', `origin/${GOD_MAIN}`], dir);
    forwarded = (await git(['rev-parse', 'HEAD'], dir)).trim() !== before;
  }
  return { created, forwarded, state: await cloneState(home, data, part, git), ...(warning === undefined ? {} : { warning }) };
}

/**
 * A clone for one subtask (D-127, G2): a new folder of the container, from
 * the installation's main, on its own branch `god/<part>`. Refuses a folder
 * that is already there: a subtask never works in another's clone.
 */
export async function createSubtaskClone(home: string, data: string, part: string, git: GitRunner = godGit(home, data)): Promise<string> {
  if (!SUBTASK_PART.test(part)) throw new GodCloneError(`invalid part ${JSON.stringify(part)}`);
  const dir = godPartDir(home, part);
  if (existsSync(dir)) throw new GodCloneError(`the clone ${part} is already there`);
  await cloneMain(home, dir, git);
  await git(['checkout', '--quiet', '-b', subtaskBranch(part)], dir);
  return dir;
}
