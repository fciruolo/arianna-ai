// Process groups a core leaves behind when it dies without stopping them
// (D-071 for oMLX, D-302 for `claude` and `codex`). A child spawned with
// `detached: true` leads its own group and does not die with the core: after
// a SIGKILL of the core it keeps running. The pid and the start time of each
// group leader go in a file under data/; at the next start a process with the
// same pid and the same start time is that orphan, and its group is stopped.
// A process that only reused the pid has another start time and is never
// touched. A guardian (D-304) does not wait for that start: it stops the
// group of a run within about a second of the death of the core.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** The folder of the cloud runs' pid files under `data/` (0700): ARIANNA_HOME, closed to sandboxed commands. */
export const RUN_PID_DIR = 'run-pids';
/** One file per run: `<executor>-<pid>.pid`. */
const RUN_PID_FILE = /^([a-z][a-z0-9-]{0,31})-([0-9]{1,10})\.pid$/;

export interface PidRecord {
  pid: number;
  /** As `ps -o lstart=` prints it: with the pid, it names one process. */
  started: string;
}

/** The start time of a living process, undefined when there is none with that pid. */
export function processStart(pid: number): string | undefined {
  try {
    // The system `ps`, in a fixed locale and zone: a core started from another environment reads the same text.
    const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return started === '' ? undefined : started;
  } catch {
    return undefined;
  }
}

/** The record of a pid file; undefined when it is missing or damaged. */
export function readPidRecord(file: string): PidRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as Partial<PidRecord> | null;
    return record !== null && typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 1 && typeof record.started === 'string' ? { pid: record.pid, started: record.started } : undefined;
  } catch {
    return undefined;
  }
}

/** The core that wrote a run's file, read from it; undefined when absent or damaged. */
function ownerOf(file: string): PidRecord | undefined {
  try {
    const owner = (JSON.parse(readFileSync(file, 'utf8')) as { owner?: Partial<PidRecord> } | null)?.owner;
    return owner !== undefined && typeof owner.pid === 'number' && Number.isInteger(owner.pid) && typeof owner.started === 'string' ? { pid: owner.pid, started: owner.started } : undefined;
  } catch {
    return undefined;
  }
}

let self: PidRecord | undefined;
/** This process, as `processStart` names it: asked once. */
function selfRecord(): PidRecord | undefined {
  if (self === undefined) {
    const started = processStart(process.pid);
    if (started !== undefined) self = { pid: process.pid, started };
  }
  return self;
}

/** Writes the record of a living process; false when it is gone already or the file cannot be written. */
export function writePidRecord(file: string, pid: number, owner?: PidRecord): boolean {
  const started = processStart(pid);
  if (started === undefined) return false;
  try {
    writeFileSync(file, JSON.stringify({ pid, started, ...(owner === undefined ? {} : { owner }) }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Stops the group a previous core started and left behind, if its leader is
 * still the same process: SIGTERM, up to `graceMs` for it to exit, SIGKILL.
 * The file goes in any case. Returns the pid of the group stopped.
 */
export async function reapOrphan(file: string, graceMs: number): Promise<number | undefined> {
  const record = readPidRecord(file);
  rmSync(file, { force: true });
  if (record === undefined || processStart(record.pid) !== record.started) return undefined;
  signalGroup(record.pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && processStart(record.pid) === record.started) await new Promise((resolve) => setTimeout(resolve, 100));
  // Also when the leader exited: a descendant may have ignored SIGTERM.
  signalGroup(record.pid, 'SIGKILL');
  return record.pid;
}

/** Refuses a folder that is not absolute and normalized, or the root. */
export function checkRunPidDir(dir: string): string {
  if (!isAbsolute(dir) || resolve(dir) !== dir || dir === sep) throw new TypeError('run pids: dir must be an absolute, normalized folder other than the root');
  return dir;
}

/**
 * The pid file of one run of `executor`, written when its process has
 * started, with the core that launched it; undefined when it could not be
 * written (the run goes on: only a crash of the core would then leave it
 * behind). Remove it with `forgetRunPid` when the run ends.
 */
export function recordRunPid(dir: string, executor: string, pid: number): string | undefined {
  const name = `${executor}-${String(pid)}.pid`;
  if (!RUN_PID_FILE.test(name)) return undefined;
  try {
    const file = join(checkRunPidDir(dir), name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return writePidRecord(file, pid, selfRecord()) ? file : undefined;
  } catch {
    // Never thrown at the launch: the child runs already.
    return undefined;
  }
}

export function forgetRunPid(file: string | undefined): void {
  if (file === undefined) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // A file left behind names a process that has exited: the next start ignores it.
  }
}

/**
 * At the start of the core, before any run: stops the groups of the runs a
 * previous core left running, and removes their files. The runs of a core
 * still alive (a second `pnpm start` on the same ARIANNA_HOME, which fails
 * later on the port) are not orphans: left alone, with their files. Files
 * with another name are left alone too; a missing folder is no orphan.
 */
export async function reapRunOrphans(dir: string, graceMs = 5_000): Promise<{ executor: string; pid: number }[]> {
  let names: string[];
  try {
    names = readdirSync(checkRunPidDir(dir));
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return [];
  }
  const files = names.flatMap((name) => {
    const executor = RUN_PID_FILE.exec(name)?.[1];
    if (executor === undefined) return [];
    const file = join(dir, name);
    const owner = ownerOf(file);
    const ownerAlive = owner !== undefined && owner.pid !== process.pid && processStart(owner.pid) === owner.started;
    return ownerAlive ? [] : [{ executor, file }];
  });
  const stopped = await Promise.all(files.map(async ({ executor, file }) => ({ executor, pid: await reapOrphan(file, graceMs) })));
  return stopped.flatMap(({ executor, pid }) => (pid === undefined ? [] : [{ executor, pid }]));
}

/**
 * D-304: the guardian of a run's group, the system `/bin/sh`. `$1` is the
 * group. It waits on its stdin, a pipe only the core holds: a line means the
 * run ended in the core, and it exits; end of file without one means the core
 * died (even by SIGKILL the kernel closes the pipe), and it stops the group:
 * SIGTERM, up to about a second for it to exit, SIGKILL.
 */
const GUARD_SCRIPT = [
  'IFS= read -r line && exit 0',
  'kill -s TERM -- "-$1" 2>/dev/null || exit 0',
  'i=0',
  'while [ "$i" -lt 10 ] && kill -s 0 -- "-$1" 2>/dev/null; do sleep 0.1; i=$((i+1)); done',
  'kill -s KILL -- "-$1" 2>/dev/null',
  'exit 0',
].join('\n');

/** `$0` of the guardian, as `ps` shows it. */
export const GUARD_NAME = 'arianna-run-guard';

export interface GroupGuard {
  /** The guardian's pid; undefined when it could not start (then only D-302 is left). */
  readonly pid: number | undefined;
  /** The run ended in the core: the guardian exits and leaves the group alone. Once is enough. */
  release(): void;
}

/**
 * Starts the guardian of the process group `pgid`, right after the group's
 * leader is spawned: if this process dies, by any signal, the group is
 * stopped within about a second, without waiting for the next start. The
 * guardian sees only the group number: never the brief, the stream or the
 * environment of the run. Its own group and session: a stop of the run's
 * group or a Ctrl-C of the core's terminal does not reach it. Never throws.
 */
export function guardGroup(pgid: number): GroupGuard {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return { pid: undefined, release: () => undefined };
  try {
    const guard = spawn('/bin/sh', ['-c', GUARD_SCRIPT, GUARD_NAME, String(pgid)], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    // Left referenced on purpose: it lives exactly as long as the run, whose binary keeps the loop alive anyway.
    guard.on('error', () => undefined);
    guard.stdin.on('error', () => undefined);
    let released = false;
    return {
      pid: guard.pid,
      release: () => {
        if (released) return;
        released = true;
        guard.stdin.end('\n');
      },
    };
  } catch {
    return { pid: undefined, release: () => undefined };
  }
}
