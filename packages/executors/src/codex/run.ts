// The `codex exec` adapter (task 1.16, D-138): launches the official binary,
// unmodified, in a prepared workspace with the confinement profile, and turns
// its stream into events and one outcome. Same shape as the claude adapter
// (claude/run.ts). Errors carry kinds and codes, never output: the stream and
// stderr can quote the brief or the files.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { maxLabel, spendAllowed, type Label } from '@arianna/policy';

import { nodeToolchain } from '../claude/run.ts';
import type { StreamFailure } from '../claude/stream.ts';
import { preparedNotes } from '../notes.ts';
import { checkRunPidDir, forgetRunPid, guardGroup, recordRunPid } from '../process-group.ts';
import { preparedPath, workspaceContainer } from '../workspace.ts';
import { codexArgs, codexEnv, userInstructionFiles, type CodexAccess, type CodexModel } from './profile.ts';
import { codexRefusalOf, CodexStream, type CodexEvent, type CodexUsage } from './stream.ts';

export const CODEX_EXECUTOR = 'codex';

export type CodexErrorKind =
  | 'not-enabled' // `codex` is not in `[cloud] executors`
  | 'invalid-options' // model, access, limits or session id the profile refuses
  | 'not-cleared' // the brief is not a logged, unspent allow of the gateway towards codex
  | 'workspace' // not a workspace made by prepareWorkspace, gone or replaced
  | 'spawn' // the binary could not be started
  | 'timeout'
  | 'cancelled'
  | 'exit' // the process ended without completing the turn
  | 'handler' // the caller's onEvent failed
  | 'auth' // the binary said the login is missing or expired (`codex login`)
  | 'plan' // the binary said the ChatGPT plan does not allow the model
  | StreamFailure;

export class CodexError extends Error {
  override name = 'CodexError';
  readonly kind: CodexErrorKind;
  /** The session, when the binary had started one: the run can be resumed, unless it was launched with `persistSession: false`. */
  readonly sessionRef: string | undefined;
  /** What the run used before failing, so that it is counted anyway. */
  readonly usage: CodexUsage | undefined;
  readonly exitCode: number | undefined;
  /** HTTP status of the API error the binary reported (400 model refused, 401 login, 429 limit). */
  readonly apiStatus: number | undefined;
  /** Profile: what did not hold (`session`, `item:<type>`). */
  readonly violations: readonly string[];
  /** How long the process ran, for any failure after the spawn (undefined for a refusal before it): "stopped after 6 seconds" tells a refused login from a long run. */
  readonly durationMs: number | undefined;

  constructor(
    kind: CodexErrorKind,
    message: string,
    details: { sessionRef?: string; usage?: CodexUsage; exitCode?: number; apiStatus?: number; violations?: readonly string[]; durationMs?: number; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.kind = kind;
    this.sessionRef = details.sessionRef;
    this.usage = details.usage;
    this.exitCode = details.exitCode;
    this.apiStatus = details.apiStatus;
    this.violations = details.violations ?? [];
    this.durationMs = details.durationMs;
  }
}

export interface CodexResult {
  sessionRef: string;
  /** The final answer: the last message of the turn. */
  text: string;
  /** What the answer is worth (taint): the brief and the workspace files it may have read, so at least L1. */
  label: Label;
  /** The model name passed to `--model`; empty when the binary used its default. */
  model: string;
  usage: CodexUsage;
  durationMs: number;
}

export interface CodexLimits {
  /** Whole run, wall clock. Default 15 minutes. */
  timeoutMs?: number;
  /** Commands and file changes before the run is stopped. Default 40. */
  maxTurns?: number;
}

export interface CodexLaunch {
  /** From `prepareWorkspace` or `openRepository`: the working directory, the only folder the run may write. */
  workspace: unknown;
  model: CodexModel;
  access: CodexAccess;
  limits?: CodexLimits;
  /** Resume this session, from an earlier run in the same workspace. */
  sessionRef?: string;
  /** False: `--ephemeral`, nothing of the session is saved and it cannot be resumed (D-136). Default true. */
  persistSession?: boolean;
  /** From `prepareProjectNotes` for `codex` (D-166): the read-only copy of the project's notes the gateway let out, opened for reading. */
  notes?: unknown;
}

export interface CodexStart extends Omit<CodexLaunch, 'sessionRef'> {
  /** An `allow` of the gateway towards `codex`, written to gateway_log; spent by the launch. Its texts, joined by a blank line, are the prompt. */
  brief: unknown;
  /** Called in order; the run waits for it, and stops if it rejects. */
  onEvent?: (event: CodexEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface CodexResume extends CodexStart {
  sessionRef: string;
}

export interface CodexRun {
  result: Promise<CodexResult>;
  cancel(): void;
}

export interface CodexExecutor {
  /** Throws the `CodexError` a launch with these options would fail with before the brief is spent. */
  check(launch: CodexLaunch): Promise<void>;
  start(options: CodexStart): CodexRun;
  resume(options: CodexResume): CodexRun;
}

export interface CodexExecutorOptions {
  /** `[cloud] executors` of arianna.toml: nothing is launched unless it names `codex`. A function is read at each launch. */
  enabled: readonly string[] | (() => readonly string[]);
  /** Tests only: a fake binary. The core always runs `codex` from PATH. */
  command?: { file: string; args: readonly string[] };
  /** Default `process.env`; only a few variables pass (see `codexEnv`). */
  env?: NodeJS.ProcessEnv;
  /** Between SIGTERM and SIGKILL. Default 5 s. */
  killGraceMs?: number;
  /** D-302: the folder of the runs' pid files, as for claude (`ClaudeExecutorOptions.pidDir`). */
  pidDir?: string;
  /** ARIANNA_HOME: the sandbox never opens it, except the workspace. */
  home: string;
  /** Folders the sandbox may read besides the workspace and the system folders. Default: `codexToolchain`. Never a user root or the home directory. */
  readable?: readonly string[];
  /** The exact name passed to `--model` (`[cloud.models]` or the cloud catalog, D-071, D-141), read at each launch; undefined refuses the launch. */
  modelName?: (model: CodexModel) => string | undefined;
  /** Evals only: every line of the stream, as it comes, so that the canary can search the whole transcript. */
  observe?: (line: string) => void;
}

/** Package manager folders a toolchain may live in; `var` (databases, logs of other programs) is left out. */
const PACKAGE_PREFIXES = ['/opt/homebrew', '/usr/local'];
const PACKAGE_FOLDERS = ['bin', 'opt', 'Cellar', 'Caskroom', 'lib'];

/** Where `codex` is on this PATH, resolved: its folder must be readable, the sandbox runs a helper from it. */
function codexBinaryFolders(env: NodeJS.ProcessEnv): string[] {
  for (const folder of (env.PATH ?? '').split(delimiter)) {
    if (folder === '' || !isAbsolute(folder)) continue;
    const file = join(folder, CODEX_EXECUTOR);
    try {
      accessSync(file, constants.X_OK);
      return [folder, dirname(realpathSync(file))];
    } catch {
      // Not here.
    }
  }
  return [];
}

/**
 * The default readable folders: the Node installation running the core, the
 * package manager's toolchain folders, the command line tools of Xcode (git)
 * and the folders of the binary.
 */
export function codexToolchain(env: NodeJS.ProcessEnv = process.env): string[] {
  const folders = [
    ...nodeToolchain(),
    ...PACKAGE_PREFIXES.flatMap((prefix) => PACKAGE_FOLDERS.map((name) => join(prefix, name))),
    '/Library/Developer/CommandLineTools',
    ...codexBinaryFolders(env),
  ].filter((folder) => existsSync(folder));
  return [...new Set(folders.map((folder) => realpathSync(folder)))];
}

/** Folders that hold user files: no readable folder may open one. */
const USER_ROOTS = ['/Users', '/home', '/root', '/Volumes', '/mnt', '/media', '/run/media', '/srv'];

/** True when `folder` is `target` or contains it. */
function covers(folder: string, target: string): boolean {
  const rel = relative(folder, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * The sandbox folders of an executor, checked once: a wrong configuration
 * fails at creation, not at the first run. Exported for the canary eval, which
 * runs commands under the same rules without a model.
 */
export function codexSandboxFolders(options: Pick<CodexExecutorOptions, 'home' | 'env' | 'readable'>): { readable: string[]; denied: string[] } {
  if (typeof options.home !== 'string' || !isAbsolute(options.home)) throw new TypeError('codex: home (ARIANNA_HOME) must be an absolute folder');
  const env = options.env ?? process.env;
  const userHome = real(env.HOME ?? homedir());
  const given = [...(options.readable ?? codexToolchain(env))];
  const closed = [userHome, ...USER_ROOTS, ...USER_ROOTS.map(real)];
  for (const folder of given) {
    if ([resolve(folder), real(folder)].some((form) => closed.some((root) => covers(form, root)))) {
      throw new TypeError(`codex: readable folder ${folder} would open the user's files`);
    }
  }
  const readable = [...new Set(given.map(real))];
  // Both spellings of the shared temp folders: the sandbox matches the path as written.
  const denied = [...new Set([real(options.home), real(tmpdir()), '/tmp', real('/tmp')])];
  for (const folder of readable) {
    if (denied.some((closed) => covers(folder, closed) || covers(closed, folder))) {
      throw new TypeError(`codex: readable folder ${folder} would open ARIANNA_HOME or a shared temp folder`);
    }
  }
  return { readable, denied };
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_TURNS = 40;
/** One line of the stream: a command's whole output comes in one. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;
/** Stderr kept in memory for a failed run: the binary's refusals come first and are short. */
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * What stderr says about a run that ended without a turn (a binary that is
 * not logged in exits before the thread): only the class, never the text.
 */
function stderrRefusal(text: string): CodexErrorKind | undefined {
  // Only the binary's own error lines, and never quota: stderr can quote the brief, and a quota waits and runs again.
  for (const line of text.split('\n')) {
    if (!/^\s*error\b/i.test(line)) continue;
    const refusal = codexRefusalOf(line, undefined);
    if (refusal === 'auth' || refusal === 'plan') return refusal;
  }
  return undefined;
}

interface Checked {
  cwd: string;
  args: string[];
  model: string;
  limits: { timeoutMs: number; maxTurns: number };
}

export function createCodexExecutor(options: CodexExecutorOptions): CodexExecutor {
  const given = options.enabled;
  const fixed = typeof given === 'function' ? [] : [...given];
  const enabled = typeof given === 'function' ? given : (): readonly string[] => fixed;
  const folders = codexSandboxFolders(options);
  if (options.pidDir !== undefined) checkRunPidDir(options.pidDir);

  async function check(launch: CodexLaunch): Promise<Checked> {
    if (!enabled().includes(CODEX_EXECUTOR)) throw new CodexError('not-enabled', 'codex: not enabled in [cloud] executors');
    // Looked at each launch: written after the executor was made, it would still go into the prompt.
    const userHome = (options.env ?? process.env).HOME ?? homedir();
    if (userInstructionFiles(userHome).some((file) => existsSync(file))) {
      throw new CodexError('profile', 'codex: the user has global Codex instructions (AGENTS.md in the Codex folder of the home), which would reach the cloud without the gateway', {
        violations: ['user-instructions'],
      });
    }
    if (launch.persistSession === false && launch.sessionRef !== undefined) {
      throw new CodexError('invalid-options', 'codex: the session was not saved (persistSession false), so it cannot be resumed');
    }
    const modelName = options.modelName?.(launch.model);
    // D-166: the copy of the project's notes opened for reading, the container of a part denied whole.
    const build = (workspace: string, extra: { notes?: string; container?: string } = {}): string[] => {
      try {
        return codexArgs({
          model: launch.model,
          ...(modelName === undefined ? {} : { modelName }),
          access: launch.access,
          sandbox: {
            workspace,
            readable: [...folders.readable, ...(extra.notes === undefined ? [] : [extra.notes])],
            denied: [...folders.denied, ...(extra.container === undefined || folders.denied.includes(extra.container) ? [] : [extra.container])],
          },
          ...(launch.sessionRef === undefined ? {} : { resume: launch.sessionRef }),
          ...(launch.persistSession === undefined ? {} : { persistSession: launch.persistSession }),
        });
      } catch (cause) {
        throw new CodexError('invalid-options', 'codex: the profile refuses these options', { cause });
      }
    };
    // Options first, with a stand-in folder: their errors come before the workspace's.
    build('/nonexistent-workspace');
    const limits = { timeoutMs: launch.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxTurns: launch.limits?.maxTurns ?? DEFAULT_MAX_TURNS };
    if (!(limits.timeoutMs > 0) || !Number.isSafeInteger(limits.maxTurns) || limits.maxTurns < 1) {
      throw new CodexError('invalid-options', 'codex: limits must be positive');
    }
    const path = preparedPath(launch.workspace);
    if (path === undefined) throw new CodexError('workspace', 'codex: the workspace was not prepared by prepareWorkspace');
    try {
      if ((await realpath(path)) !== path || !(await stat(path)).isDirectory()) throw new Error('replaced');
    } catch (cause) {
      throw new CodexError('workspace', 'codex: the workspace folder is gone or was replaced', { cause });
    }
    let notes: string | undefined;
    if (launch.notes !== undefined) {
      const copy = preparedNotes(launch.notes);
      if (copy?.executor !== CODEX_EXECUTOR) throw new CodexError('workspace', 'codex: the notes were not prepared for codex by prepareProjectNotes');
      try {
        if ((await realpath(copy.path)) !== copy.path || !(await stat(copy.path)).isDirectory()) throw new Error('replaced');
      } catch (cause) {
        throw new CodexError('workspace', 'codex: the notes folder is gone or was replaced', { cause });
      }
      notes = copy.path;
    }
    const container = workspaceContainer(launch.workspace);
    return { cwd: path, args: build(path, { ...(notes === undefined ? {} : { notes }), ...(container === undefined ? {} : { container }) }), model: modelName ?? '', limits };
  }

  const launch = (start: CodexStart, sessionRef?: string): CodexRun => {
    const controller = new AbortController();
    const result = run(start, sessionRef, controller.signal);
    return {
      result,
      cancel: () => {
        controller.abort();
      },
    };
  };

  async function run(start: CodexStart, sessionRef: string | undefined, cancelled: AbortSignal): Promise<CodexResult> {
    const checked = await check({ ...start, ...(sessionRef === undefined ? {} : { sessionRef }) });
    // Spent here, once: a second launch needs a second decision and a second row in gateway_log.
    const allowed = spendAllowed(start.brief);
    if (allowed?.target.kind !== 'executor' || allowed.target.id !== CODEX_EXECUTOR || allowed.target.locality !== 'cloud') {
      throw new CodexError('not-cleared', 'codex: the brief is not a logged gateway decision that allows codex');
    }
    return execute({
      ...checked,
      prompt: allowed.texts.join('\n\n'),
      label: maxLabel(allowed.label, 'L1'),
      stream: new CodexStream(sessionRef === undefined ? {} : { sessionRef }),
      onEvent: start.onEvent,
      signals: [cancelled, ...(start.signal === undefined ? [] : [start.signal])],
    });
  }

  function execute(job: Checked & { prompt: string; label: Label; stream: CodexStream; onEvent: CodexStart['onEvent']; signals: AbortSignal[] }): Promise<CodexResult> {
    const { stream } = job;
    const started = Date.now();
    const file = options.command?.file ?? CODEX_EXECUTOR;
    const argv = [...(options.command?.args ?? []), ...job.args];

    return new Promise<CodexResult>((resolve, reject) => {
      let stopped: { kind: CodexErrorKind; cause?: unknown } | undefined;
      let closed = false;
      let handlers: Promise<void> = Promise.resolve();
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      let killTimer: NodeJS.Timeout | undefined;
      let release: () => void = () => undefined;
      const deadline = new Promise<void>((done) => {
        release = done;
      });

      // Its own process group: stopping the run stops whatever the binary started.
      const child = spawn(file, argv, { cwd: job.cwd, env: codexEnv(options.env ?? process.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      // D-302: a core killed now leaves the group running; the next one stops it from this file.
      const pidFile = options.pidDir === undefined || child.pid === undefined ? undefined : recordRunPid(options.pidDir, CODEX_EXECUTOR, child.pid);
      // D-304: and a guardian stops the group within a second if the core dies, without waiting for that start.
      const guard = child.pid === undefined ? undefined : guardGroup(child.pid);

      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The group is gone already.
        }
      };

      const stop = (kind: CodexErrorKind, cause?: unknown): void => {
        stopped ??= { kind, cause };
        if (kind === 'timeout' || kind === 'cancelled') release();
        if (closed) return;
        signalGroup('SIGTERM');
        killTimer ??= setTimeout(() => {
          signalGroup('SIGKILL');
        }, options.killGraceMs ?? 5_000);
      };

      const timer = setTimeout(() => {
        stop('timeout');
      }, job.limits.timeoutMs);
      const onAbort = () => {
        stop('cancelled');
      };
      for (const signal of job.signals) {
        if (signal.aborted) stop('cancelled');
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const report = (events: CodexEvent[]) => {
        const onEvent = job.onEvent;
        if (onEvent === undefined) return;
        for (const event of events) {
          handlers = handlers.then(async () => {
            if (stopped?.kind !== 'handler') await onEvent(event);
          });
        }
        handlers = handlers.catch((cause: unknown) => {
          stop('handler', cause);
        });
      };

      const line = (bytes: Buffer) => {
        const text = bytes.toString('utf8');
        options.observe?.(text);
        report(stream.feed(text));
        if (stream.result === undefined) {
          if (stream.usage.turns > job.limits.maxTurns) stop('max-turns');
        } else if (!stream.result.ok) {
          stop(stream.result.failure ?? 'bad-output');
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        let start = 0;
        let newline: number;
        while ((newline = chunk.indexOf(0x0a, start)) !== -1) {
          pending.push(chunk.subarray(start, newline));
          line(Buffer.concat(pending));
          pending = [];
          pendingBytes = 0;
          start = newline + 1;
        }
        if (start < chunk.length) {
          pending.push(chunk.subarray(start));
          pendingBytes += chunk.length - start;
        }
        if (pendingBytes > MAX_LINE_BYTES) {
          options.observe?.(Buffer.concat(pending).toString('utf8'));
          pending = [];
          pendingBytes = 0;
          stop('bad-output');
        }
      });
      // Read, never stored nor logged: it can quote the prompt, and a full pipe would block the binary.
      // Only its first lines stay in memory, so that a run that fails can tell a refused login or plan (D-064).
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        const part = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
        stderr.push(part);
        stderrBytes += part.length;
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(job.prompt);

      child.on('error', (cause) => {
        stop('spawn', cause);
        if (child.pid === undefined) finish(null);
      });
      child.on('close', (code) => {
        finish(code);
      });

      function finish(code: number | null): void {
        if (closed) return;
        closed = true;
        forgetRunPid(pidFile);
        if (stopped !== undefined) signalGroup('SIGKILL');
        // After the stop: the guardian, released, leaves the group alone.
        guard?.release();
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (pending.length > 0) {
          if (stopped === undefined) line(Buffer.concat(pending));
          else options.observe?.(Buffer.concat(pending).toString('utf8'));
        }
        void Promise.race([handlers, deadline]).then(() => {
          clearTimeout(timer);
          for (const signal of job.signals) signal.removeEventListener('abort', onAbort);
          const outcome = stream.result;
          const details = {
            ...(stream.sessionRef === undefined ? {} : { sessionRef: stream.sessionRef }),
            usage: stream.usage,
            ...(code === null ? {} : { exitCode: code }),
            ...(outcome?.apiStatus === undefined ? {} : { apiStatus: outcome.apiStatus }),
          };
          // A completed turn with a non-zero exit is not a success: the binary saw something go wrong after it.
          if (stopped === undefined && outcome?.ok === true && stream.sessionRef !== undefined && code === 0) {
            resolve({ sessionRef: stream.sessionRef, text: outcome.text ?? '', label: job.label, model: job.model, usage: stream.usage, durationMs: Date.now() - started });
            return;
          }
          const ended: CodexErrorKind = stopped?.kind ?? (outcome?.ok === false ? (outcome.failure ?? 'bad-output') : 'exit');
          // An error the binary reported in the stream, or a failed exit before any thread (a binary not logged in
          // stops there): its own words may say the login or the plan refused it.
          const beforeThread = ended === 'exit' && stream.sessionRef === undefined && code !== null && code !== 0;
          const kind: CodexErrorKind =
            ended === 'execution'
              ? (stream.refusal ?? ended)
              : beforeThread
                ? (stderrRefusal(Buffer.concat(stderr).toString('utf8')) ?? ended)
                : ended;
          const violations = outcome?.violations;
          reject(
            new CodexError(kind, `codex: run ended with ${kind}${code === null ? '' : ` (exit ${String(code)})`}`, {
              ...details,
              durationMs: Date.now() - started,
              ...(violations === undefined ? {} : { violations }),
              ...(stopped?.cause === undefined ? {} : { cause: stopped.cause }),
            }),
          );
        });
      }
    });
  }

  return {
    check: async (options) => {
      await check(options);
    },
    start: (start) => launch(start),
    resume: (resumed) => launch(resumed, resumed.sessionRef),
  };
}
