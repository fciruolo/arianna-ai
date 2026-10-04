// The `claude -p` adapter (task 1.5, D-049): launches the official binary,
// unmodified, in a prepared workspace with the confinement profile, and turns
// its stream into events and one outcome. Errors carry kinds and codes, never
// output: the stream and stderr can quote the brief or the files.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { maxLabel, spendAllowed, type Label } from '@arianna/policy';

import { preparedPath } from '../workspace.ts';
import { claudeArgs, claudeEnv, type ClaudeModel, type ClaudeTool } from './profile.ts';
import { ClaudeStream, type ClaudeEvent, type ClaudeUsage, type StreamFailure } from './stream.ts';

export const CLAUDE_EXECUTOR = 'claude';

export type ClaudeErrorKind =
  | 'not-enabled' // `claude` is not in `[cloud] executors`
  | 'invalid-options' // model, tools, limits or session id the profile refuses
  | 'not-cleared' // the brief is not a logged, unspent allow of the gateway towards claude
  | 'workspace' // not a workspace made by prepareWorkspace, gone or replaced
  | 'spawn' // the binary could not be started
  | 'timeout'
  | 'cancelled'
  | 'exit' // the process ended without a final message
  | 'handler' // the caller's onEvent failed
  | StreamFailure;

export class ClaudeError extends Error {
  override name = 'ClaudeError';
  readonly kind: ClaudeErrorKind;
  /** The session, when the binary had started one: the run can be resumed. */
  readonly sessionRef: string | undefined;
  /** Quota: when the subscription takes requests again, if the binary said it. */
  readonly resetsAt: Date | undefined;
  /** What the run used before failing, so that it is counted anyway. */
  readonly usage: ClaudeUsage | undefined;
  readonly exitCode: number | undefined;
  /** HTTP status of the API error the binary reported (401 login, 429 limit, 529 overload). */
  readonly apiStatus: number | undefined;
  /** Profile: the fields of `init` that did not hold. */
  readonly violations: readonly string[];

  constructor(
    kind: ClaudeErrorKind,
    message: string,
    details: {
      sessionRef?: string;
      resetsAt?: Date;
      usage?: ClaudeUsage;
      exitCode?: number;
      apiStatus?: number;
      violations?: readonly string[];
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.kind = kind;
    this.sessionRef = details.sessionRef;
    this.resetsAt = details.resetsAt;
    this.usage = details.usage;
    this.exitCode = details.exitCode;
    this.apiStatus = details.apiStatus;
    this.violations = details.violations ?? [];
  }
}

export interface ClaudeResult {
  sessionRef: string;
  /** The final answer. */
  text: string;
  /**
   * What the answer is worth (taint): the brief and the workspace files it may
   * have read, so at least L1, the ceiling of an allowlisted workspace.
   */
  label: Label;
  /** The model name the binary reported, e.g. `claude-sonnet-5-5`. */
  model: string;
  usage: ClaudeUsage;
  /** Tool uses the permissions refused. */
  permissionDenials: number;
  durationMs: number;
}

export interface ClaudeLimits {
  /** Whole run, wall clock. Default 15 minutes. */
  timeoutMs?: number;
  /** Model responses before the run is stopped. Default 40. */
  maxTurns?: number;
}

export interface ClaudeLaunch {
  /** From `prepareWorkspace`: the working directory, and all the files the tools reach. */
  workspace: unknown;
  model: ClaudeModel;
  tools: readonly ClaudeTool[];
  limits?: ClaudeLimits;
  /** Resume this session, from an earlier run in the same workspace (sessions are kept per folder). */
  sessionRef?: string;
}

export interface ClaudeStart extends Omit<ClaudeLaunch, 'sessionRef'> {
  /**
   * An `allow` of the gateway towards `claude`, written to gateway_log
   * (`passGateway`); spent by the launch. Its texts, joined by a blank line,
   * are the prompt.
   */
  brief: unknown;
  /** Called in order; the run waits for it, and stops if it rejects. */
  onEvent?: (event: ClaudeEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ClaudeResume extends ClaudeStart {
  sessionRef: string;
}

export interface ClaudeRun {
  result: Promise<ClaudeResult>;
  cancel(): void;
}

export interface ClaudeExecutor {
  /**
   * Throws the `ClaudeError` a launch with these options would fail with before
   * the brief is spent: check before asking the gateway, so that no allow is
   * logged for a run that never starts.
   */
  check(launch: ClaudeLaunch): Promise<void>;
  start(options: ClaudeStart): ClaudeRun;
  resume(options: ClaudeResume): ClaudeRun;
}

export interface ClaudeExecutorOptions {
  /** `[cloud] executors` of arianna.toml: nothing is launched unless it names `claude`. */
  enabled: readonly string[];
  /** Tests only: a fake binary. The core always runs `claude` from PATH. */
  command?: { file: string; args: readonly string[] };
  /** Default `process.env`; only a few variables pass (see `claudeEnv`). */
  env?: NodeJS.ProcessEnv;
  /** Between SIGTERM and SIGKILL. Default 5 s. */
  killGraceMs?: number;
  /** ARIANNA_HOME: sandboxed commands never read it, wherever it is, except the workspace. */
  home: string;
  /**
   * Folders sandboxed commands may read besides the workspace and the system
   * folders. Default: `bin` and `lib` of the Node installation running the
   * core, which may live in the home directory. Never a user root, the home
   * directory or a folder above them.
   */
  readable?: readonly string[];
  /**
   * The exact name passed to `--model` for an alias, read at each launch
   * (`[cloud.models]`, D-071); undefined passes the alias.
   */
  modelName?: (model: ClaudeModel) => string | undefined;
  /** Evals only: every line of the stream, as it comes, so that the canary can search the whole transcript. */
  observe?: (line: string) => void;
}

/** `bin` and `lib` of the Node installation running this process (`<prefix>/bin/node`). */
export function nodeToolchain(): string[] {
  const prefix = dirname(dirname(realpathSync(process.execPath)));
  return [join(prefix, 'bin'), join(prefix, 'lib')].filter((folder) => existsSync(folder));
}

/** Folders that hold user files: the read block closes them, and no readable folder may open one. */
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
 * fails at creation, not at the first run.
 */
function sandboxFolders(options: ClaudeExecutorOptions): { readable: string[]; denied: string[] } {
  if (typeof options.home !== 'string' || !isAbsolute(options.home)) throw new TypeError('claude: home (ARIANNA_HOME) must be an absolute folder');
  // Without HOME the user's home is still the account's: default-deny, never "no home to protect".
  const userHome = real((options.env ?? process.env).HOME ?? homedir());
  const given = [...(options.readable ?? nodeToolchain())];
  // Both spellings: on macOS `/home` resolves to a folder of the system data volume.
  const closed = [userHome, ...USER_ROOTS, ...USER_ROOTS.map(real)];
  for (const folder of given) {
    if ([resolve(folder), real(folder)].some((form) => closed.some((root) => covers(form, root)))) {
      throw new TypeError(`claude: readable folder ${folder} would open the user's files`);
    }
  }
  const readable = given.map(real);
  const tmp = real('/tmp');
  // The binary keeps its own temp folder there (`/tmp/claude-<uid>`): without it no command runs.
  readable.push(join(tmp, `claude-${String(process.getuid?.() ?? 0)}`));
  const denied = [...new Set([real(options.home), real(tmpdir()), tmp])];
  return { readable, denied };
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_TURNS = 40;
/** One line of the stream; a file read whole by a tool fits with room to spare. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

interface Checked {
  cwd: string;
  args: string[];
  limits: { timeoutMs: number; maxTurns: number };
}

export function createClaudeExecutor(options: ClaudeExecutorOptions): ClaudeExecutor {
  const enabled = [...options.enabled];
  const folders = sandboxFolders(options);

  async function check(launch: ClaudeLaunch): Promise<Checked> {
    if (!enabled.includes(CLAUDE_EXECUTOR)) throw new ClaudeError('not-enabled', 'claude: not enabled in [cloud] executors');
    const modelName = options.modelName?.(launch.model);
    const profile = (workspace: string) => ({
      model: launch.model,
      ...(modelName === undefined ? {} : { modelName }),
      tools: launch.tools,
      sandbox: { workspace, ...folders },
      ...(launch.sessionRef === undefined ? {} : { resume: launch.sessionRef }),
    });
    const build = (workspace: string): string[] => {
      try {
        return claudeArgs(profile(workspace));
      } catch (cause) {
        throw new ClaudeError('invalid-options', 'claude: the profile refuses these options', { cause });
      }
    };
    // Options first, with a stand-in folder: their errors come before the workspace's.
    build(folders.denied[0] ?? '/nonexistent');
    const limits = { timeoutMs: launch.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxTurns: launch.limits?.maxTurns ?? DEFAULT_MAX_TURNS };
    if (!(limits.timeoutMs > 0) || !Number.isSafeInteger(limits.maxTurns) || limits.maxTurns < 1) {
      throw new ClaudeError('invalid-options', 'claude: limits must be positive');
    }
    const path = preparedPath(launch.workspace);
    if (path === undefined) throw new ClaudeError('workspace', 'claude: the workspace was not prepared by prepareWorkspace');
    try {
      // The folder must still be the one prepared, not a link put in its place.
      if ((await realpath(path)) !== path || !(await stat(path)).isDirectory()) throw new Error('replaced');
    } catch (cause) {
      throw new ClaudeError('workspace', 'claude: the workspace folder is gone or was replaced', { cause });
    }
    return { cwd: path, args: build(path), limits };
  }

  const launch = (start: ClaudeStart, sessionRef?: string): ClaudeRun => {
    const controller = new AbortController();
    const result = run(start, sessionRef, controller.signal);
    return {
      result,
      cancel: () => {
        controller.abort();
      },
    };
  };

  async function run(start: ClaudeStart, sessionRef: string | undefined, cancelled: AbortSignal): Promise<ClaudeResult> {
    const checked = await check({ ...start, ...(sessionRef === undefined ? {} : { sessionRef }) });
    // Spent here, once: a second launch needs a second decision and a second row in gateway_log.
    const allowed = spendAllowed(start.brief);
    if (allowed?.target.kind !== 'executor' || allowed.target.id !== CLAUDE_EXECUTOR || allowed.target.locality !== 'cloud') {
      throw new ClaudeError('not-cleared', 'claude: the brief is not a logged gateway decision that allows claude');
    }
    return execute({
      ...checked,
      prompt: allowed.texts.join('\n\n'),
      label: maxLabel(allowed.label, 'L1'),
      stream: new ClaudeStream({ cwd: checked.cwd, tools: start.tools, ...(sessionRef === undefined ? {} : { sessionRef }) }),
      onEvent: start.onEvent,
      signals: [cancelled, ...(start.signal === undefined ? [] : [start.signal])],
    });
  }

  function execute(job: Checked & { prompt: string; label: Label; stream: ClaudeStream; onEvent: ClaudeStart['onEvent']; signals: AbortSignal[] }): Promise<ClaudeResult> {
    const { stream } = job;
    const started = Date.now();
    const file = options.command?.file ?? CLAUDE_EXECUTOR;
    const argv = [...(options.command?.args ?? []), ...job.args];

    return new Promise<ClaudeResult>((resolve, reject) => {
      let stopped: { kind: ClaudeErrorKind; cause?: unknown } | undefined;
      let closed = false;
      let handlers: Promise<void> = Promise.resolve();
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let killTimer: NodeJS.Timeout | undefined;
      // Resolves when the run must end whatever the handlers do: the time cap or a cancel.
      let release: () => void = () => undefined;
      const deadline = new Promise<void>((done) => {
        release = done;
      });

      // Its own process group: stopping the run stops whatever the binary started.
      const child = spawn(file, argv, { cwd: job.cwd, env: claudeEnv(options.env ?? process.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true });

      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The group is gone already.
        }
      };

      const stop = (kind: ClaudeErrorKind, cause?: unknown): void => {
        stopped ??= { kind, cause };
        if (kind === 'timeout' || kind === 'cancelled') release();
        if (closed) return;
        // To the group even when the main process has exited: a descendant may hold stdout open.
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

      const report = (events: ClaudeEvent[]) => {
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
        // Only the new chunk is searched: a long line is not scanned again for each piece.
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
      // Read and dropped: it can quote the prompt, and a full pipe would block the binary.
      child.stderr.on('data', () => undefined);
      // The binary may exit before reading everything (a bad flag): not an error of its own.
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
        // A stopped run leaves nothing behind in its group.
        if (stopped !== undefined) signalGroup('SIGKILL');
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (pending.length > 0) {
          if (stopped === undefined) line(Buffer.concat(pending));
          else options.observe?.(Buffer.concat(pending).toString('utf8'));
        }
        // The time cap still holds while the handlers finish: a stuck onEvent cannot hang the run.
        void Promise.race([handlers, deadline]).then(() => {
          clearTimeout(timer);
          for (const signal of job.signals) signal.removeEventListener('abort', onAbort);
          const outcome = stream.result;
          const details = {
            ...(stream.sessionRef === undefined ? {} : { sessionRef: stream.sessionRef }),
            ...(stream.resetsAt === undefined ? {} : { resetsAt: stream.resetsAt }),
            usage: stream.usage,
            ...(code === null ? {} : { exitCode: code }),
            ...(outcome?.apiStatus === undefined ? {} : { apiStatus: outcome.apiStatus }),
          };
          if (stopped === undefined && outcome?.ok === true && stream.sessionRef !== undefined) {
            resolve({
              sessionRef: stream.sessionRef,
              text: outcome.text ?? '',
              label: job.label,
              model: stream.model ?? '',
              usage: stream.usage,
              permissionDenials: outcome.permissionDenials ?? 0,
              durationMs: Date.now() - started,
            });
            return;
          }
          const kind: ClaudeErrorKind = stopped?.kind ?? (outcome?.ok === false ? (outcome.failure ?? 'bad-output') : 'exit');
          const violations = outcome?.violations;
          reject(
            new ClaudeError(kind, `claude: run ended with ${kind}${code === null ? '' : ` (exit ${String(code)})`}`, {
              ...details,
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
