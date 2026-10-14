import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { DATA_DIR, guardPaths, loadCatalog, modelPath, resolveHome, type AriannaConfig, type GuardPaths } from '@arianna/config';
import { piiReport, piiUnavailable, type PiiCheck, type PiiUnavailableReason } from '@arianna/policy';

import { cleanChildEnv } from './child-env.ts';

/**
 * The second scanner of personal data (D-113, stage 2): apps/guard with
 * Rizzo-PII, started by the core at the first exit towards the cloud and
 * stopped after a while without work, so its 1.3 GB stay free most of the day.
 * The core talks to it on stdin and stdout, one JSON object per line: the
 * process has no socket, and its environment is the cage of the voice (no
 * proxy that works, Hugging Face offline, caches in data/guard/tmp).
 *
 * Every answer is a `PiiCheck` for the gateway: what the model found, or why it
 * did not answer (`off`, `starting`, `timeout`, `malformed`, `error`). No answer
 * stops the exit, except on a development installation (D-113, question 2).
 */
export interface PiiGuard {
  /** `fragmentNames`: names that are not persons in that fragment alone (D-214), by position. */
  scan(texts: readonly string[], fragmentNames?: readonly (readonly string[] | undefined)[]): Promise<PiiCheck>;
  readonly state: PiiGuardState;
  stop(): Promise<void>;
}

export type PiiGuardState = 'off' | 'idle' | 'starting' | 'ready' | 'failed' | 'stopped';

/** A stream of the child: an error on it (EPIPE when Python died) is an event, never thrown by `write`. */
interface ChildStream {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** What the core needs of a child process; the tests give a fake one. */
export interface GuardChild {
  readonly stdin: ChildStream & { write(line: string): boolean; end(): void };
  readonly stdout: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface PiiGuardOptions {
  /** The command that starts the service; undefined when the guard is off (no `pii` model, no environment). */
  start: (() => GuardChild) | undefined;
  /** Development passwords of the database, as the doctor checks them: no answer does not stop an exit. */
  development: boolean;
  /** Names of the assistant and of the agents, never taken for a person. */
  names?: () => readonly string[];
  /** Load of the model: 6-11 s measured (D-203), 30 s and more with the Mac under load. */
  startTimeoutMs?: number;
  /**
   * One request, plus `requestMsPer10k` for every 10 000 characters waiting in
   * the service (this request and the ones before it, read one at a time).
   */
  requestTimeoutMs?: number;
  requestMsPer10k?: number;
  /** Stopped after this long without a request. */
  idleMs?: number;
  /** After a crash, no new start before this long: exits stop meanwhile. */
  retryMs?: number;
  /** A process that ignores SIGTERM gets SIGKILL after this long. */
  killGraceMs?: number;
  onEvent?: (event: string) => void;
}

/** What apps/guard reads in one request (serve.py): larger payloads go in several requests. */
export const GUARD_MAX_TEXTS = 64;
export const GUARD_MAX_REQUEST_CHARS = 3 * 1024 * 1024;

interface Pending {
  chars: number;
  resolve: (answer: unknown[] | undefined) => void;
  timer: NodeJS.Timeout;
}

/** Texts in requests within the limits of the service; undefined when one text alone is too large. */
function batches(texts: readonly string[]): string[][] | undefined {
  const out: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const text of texts) {
    // JSON may double a character (escapes): the limit counts the text twice.
    const size = text.length * 2 + 16;
    if (size > GUARD_MAX_REQUEST_CHARS) return undefined;
    if (current.length === GUARD_MAX_TEXTS || chars + size > GUARD_MAX_REQUEST_CHARS) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += size;
  }
  out.push(current);
  return out;
}

export function createPiiGuard(options: PiiGuardOptions): PiiGuard {
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const requestMsPer10k = options.requestMsPer10k ?? 1_000;
  const idleMs = options.idleMs ?? 15 * 60_000;
  const retryMs = options.retryMs ?? 60_000;
  const killGraceMs = options.killGraceMs ?? 5_000;
  const unavailable = (reason: PiiUnavailableReason): PiiCheck => piiUnavailable(reason, options.development);

  let state: PiiGuardState = options.start === undefined ? 'off' : 'idle';
  let child: GuardChild | undefined;
  let ready: Promise<boolean> | undefined;
  let failedAt = 0;
  let nextId = 1;
  let idleTimer: NodeJS.Timeout | undefined;
  const pending = new Map<number, Pending>();
  let pendingChars = 0;

  const emit = (event: string): void => options.onEvent?.(event);

  function settle(id: number, answer: unknown[] | undefined): void {
    const request = pending.get(id);
    if (request === undefined) return;
    clearTimeout(request.timer);
    pending.delete(id);
    pendingChars -= request.chars;
    request.resolve(answer);
  }

  function settleAll(): void {
    for (const id of [...pending.keys()]) settle(id, undefined);
  }

  function kill(): void {
    const current = child;
    child = undefined;
    ready = undefined;
    if (current === undefined) return;
    let exited = false;
    current.on('exit', () => {
      exited = true;
    });
    try {
      current.stdin.end();
      current.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    // Stuck inside torch, it may ignore SIGTERM: two models of 1.3 GB must never stay.
    setTimeout(() => {
      if (exited) return;
      try {
        current.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, killGraceMs).unref();
  }

  function fail(event: string): void {
    kill();
    if (state !== 'stopped') state = 'failed';
    failedAt = Date.now();
    settleAll();
    emit(event);
  }

  function touch(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (pending.size > 0) {
        touch();
        return;
      }
      kill();
      if (state !== 'stopped') state = 'idle';
      emit('idle-stop');
    }, idleMs);
    idleTimer.unref();
  }

  function launch(): Promise<boolean> {
    const start = options.start;
    if (start === undefined) return Promise.resolve(false);
    state = 'starting';
    emit('starting');
    let started: GuardChild;
    try {
      started = start();
    } catch {
      fail('spawn-error');
      return Promise.resolve(false);
    }
    child = started;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const lost = (event: string) => (): void => {
        if (child === started) fail(event);
        done(false);
      };
      const timer = setTimeout(lost('start-timeout'), startTimeoutMs);
      // Every error has a listener: an EPIPE without one would stop the core.
      started.on('error', lost('spawn-error'));
      started.on('exit', lost('exited'));
      started.stdin.on('error', lost('write-error'));
      started.stdout.on('error', lost('read-error'));
      const lines = createInterface({ input: started.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        if (child !== started) return;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof message !== 'object' || message === null) return;
        const record = message as Record<string, unknown>;
        if (record.ready === true && state === 'starting') {
          state = 'ready';
          emit('ready');
          done(true);
          return;
        }
        if (typeof record.id !== 'number') return;
        // A malformed answer is a check that did not happen: piiReport says so.
        settle(record.id, record.error === undefined ? (Array.isArray(record.entities) ? record.entities : [record.entities]) : undefined);
      });
    });
  }

  /** The raw answer of the service for one request, undefined for no answer. */
  function request(current: GuardChild, texts: readonly string[]): Promise<unknown[] | undefined | 'timeout'> {
    const id = nextId++;
    const chars = texts.reduce((sum, text) => sum + text.length, 0);
    pendingChars += chars;
    const timeoutMs = requestTimeoutMs + Math.ceil(pendingChars / 10_000) * requestMsPer10k;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve('timeout');
        settle(id, undefined);
        // A process that does not answer in time is restarted at the next exit.
        if (child === current) fail('request-timeout');
      }, timeoutMs);
      pending.set(id, { chars, resolve, timer });
      try {
        current.stdin.write(`${JSON.stringify({ id, texts })}\n`);
      } catch {
        if (child === current) fail('write-error');
        else settle(id, undefined);
      }
    });
  }

  async function scan(texts: readonly string[], fragmentNames: readonly (readonly string[] | undefined)[] = []): Promise<PiiCheck> {
    if (state === 'off' || state === 'stopped') return unavailable('off');
    if (state === 'failed' && Date.now() - failedAt < retryMs) return unavailable('error');
    const parts = batches(texts);
    // One text larger than a request: not read, and the service is not disturbed for it.
    if (parts === undefined) return unavailable('error');
    touch();
    if (child === undefined || ready === undefined) ready = launch();
    if (!(await ready)) return unavailable(state === 'starting' ? 'starting' : 'error');
    const current = child;
    if (current === undefined) return unavailable('error');
    const answers = await Promise.all(parts.map((part) => request(current, part)));
    if (answers.includes('timeout')) return unavailable('timeout');
    if (answers.some((answer) => answer === undefined)) return unavailable('error');
    const entities = answers.flatMap((answer, index) => {
      const list = answer as unknown[];
      // A count that does not match its request makes the whole answer malformed.
      return list.length === parts[index]?.length ? list : [undefined];
    });
    return piiReport(texts, entities, options.names?.() ?? [], fragmentNames);
  }

  return {
    scan,
    get state() {
      return state;
    },
    stop() {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      // Final: an exit asked while the core stops does not start Python again.
      if (state !== 'off') state = 'stopped';
      settleAll();
      kill();
      return Promise.resolve();
    },
  };
}

/** The only variables of the core the service inherits. */
const INHERITED = ['PATH', 'HOME', 'LANG'] as const;

/**
 * The cage of apps/guard (D-113): a clean environment, a proxy that goes
 * nowhere, Hugging Face and transformers offline, caches inside data/guard.
 * `pnpm guard:trial` and `pnpm test:guard` run in the same one.
 */
export function guardEnv(from: NodeJS.ProcessEnv, paths: GuardPaths): Record<string, string> {
  mkdirSync(paths.tmp, { recursive: true, mode: 0o700 });
  return {
    ...cleanChildEnv(from, INHERITED),
    PYTHONPATH: paths.src,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HOME: join(paths.tmp, 'hf'),
    XDG_CACHE_HOME: join(paths.tmp, 'cache'),
    TMPDIR: paths.tmp,
    TOKENIZERS_PARALLELISM: 'false',
    // stdin and stdout in UTF-8 whatever LANG says: the positions are counted on the same text.
    PYTHONUTF8: '1',
  };
}

/**
 * How the core starts apps/guard, or undefined when it cannot: no `pii` model
 * assigned, its weights missing, or no environment (pnpm guard:sync).
 */
export function guardStarter(paths: GuardPaths, modelDir: string | undefined, env: NodeJS.ProcessEnv = process.env): (() => GuardChild) | undefined {
  if (modelDir === undefined || !existsSync(join(modelDir, 'model.safetensors')) || !existsSync(paths.python)) return undefined;
  return () =>
    spawn(paths.python, ['-m', 'arianna_guard.serve', '--model', modelDir], {
      cwd: paths.project,
      env: guardEnv(env, paths),
      // stderr is not read: the service writes there only step names, never text.
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
    });
}

// The guard of this process, configured once by main.ts; until then every exit
// towards the cloud stops (`off`, not development): forgetting it is not a pass.
let current: PiiGuard = createPiiGuard({ start: undefined, development: false });

export function configurePiiGuard(guard: PiiGuard): void {
  current = guard;
}

export function stopPiiGuard(): Promise<void> {
  return current.stop();
}

/** The second check of `texts`, for passGateway. */
export function piiCheckOf(texts: readonly string[], fragmentNames: readonly (readonly string[] | undefined)[] = []): Promise<PiiCheck> {
  return current.scan(texts, fragmentNames);
}

/**
 * The guard of a command of the terminal (the catalogs, D-160, D-161, D-079,
 * D-202, D-206): the same service and the same rule as the core. Development as
 * the doctor reads it from the configuration: no `app_password` reference, the
 * development passwords. Stopped after a few idle seconds, so the command exits.
 */
export function cliPiiGuard(config: Pick<AriannaConfig, 'home' | 'paths' | 'roles' | 'database'> | undefined): PiiGuard {
  const home = config?.home ?? resolveHome();
  const data = config?.paths.data ?? join(home, DATA_DIR);
  const assigned = config?.roles.pii;
  const entry = assigned === undefined ? undefined : loadCatalog(home).models.find((model) => model.id === assigned && model.roles.includes('pii'));
  return createPiiGuard({
    start: guardStarter(guardPaths(home, data), entry === undefined ? undefined : modelPath(data, entry)),
    // Without a configuration nothing says development: the doctor would not call it ready either.
    development: config !== undefined && config.database.appPassword === undefined,
    idleMs: 5_000,
  });
}
