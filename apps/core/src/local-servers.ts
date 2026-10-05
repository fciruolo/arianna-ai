import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { LocalEndpointConfig } from '@arianna/config';
import { Watchdog, type WatchdogEvent, type WatchdogState } from '@arianna/executors';

import { cleanChildEnv } from './child-env.ts';

/**
 * The local inference servers (oMLX), started and watched by the core (D-071,
 * choice 4). An endpoint with `command` is started with the core, restarted
 * when it exits or stops answering and stopped with the core; one already
 * answering on its port is adopted and never killed. Without `command` the
 * watchdog only reports health, and the model tries that endpoint last.
 *
 * The server gets an environment built from nothing, like apps/voice: no
 * database password, no age key of sops, no proxy, Hugging Face offline. Its
 * log may hold prompts (L2): it stays in data/, one file per endpoint.
 *
 * oMLX does not exit when its standard input closes, so a core that dies
 * without stopping it (crash, SIGKILL) leaves it running, possibly still
 * loading a model: the next core would start a second one. The pid and start
 * time of each server the core starts go in data/<id>.pid; at the next start a
 * process with the same pid and the same start time is that orphan, and is
 * stopped first. A process that only reused the pid has another start time
 * and is never touched.
 */
export type LocalServerEvent = WatchdogEvent | { type: 'orphan'; endpoint: string; pid: number };
export interface LocalServerStatus {
  id: string;
  url: string;
  /** False: no `command`, the core only watches the server. */
  managed: boolean;
  /** Already answering when its watchdog started: the core watches it but never stops it. */
  adopted: boolean;
  state: WatchdogState;
}

export interface LocalServersOptions {
  /** ARIANNA_HOME: relative paths of `command` are relative to it. */
  home: string;
  /** data/: the log of endpoint `<id>` is data/<id>.log. */
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: LocalServerEvent) => void;
  /** Watchdog timings, shortened by the tests. */
  timing?: { intervalMs?: number; startupTimeoutMs?: number; backoffMs?: number; stopGraceMs?: number };
}

export interface LocalServers {
  /**
   * Brings the watchdogs in line with `endpoints`: new ones start, removed
   * ones stop, one whose `url` or `command` changed is stopped and started
   * again. Resolves once every new watchdog has settled. A sync still
   * waiting behind another (a long start of oMLX) is replaced by the next
   * one: only the last configuration is applied, and both resolve with it.
   */
  sync(endpoints: readonly LocalEndpointConfig[]): Promise<void>;
  status(): LocalServerStatus[];
  /**
   * Stops the server of `id` and starts it again ("Riavvia oMLX" of the
   * settings page, D-071); resolves once it has settled, false when there is
   * no such endpoint. Queued with the syncs. An adopted server is not the
   * core's to stop: the new watchdog adopts it again.
   */
  restart(id: string): Promise<boolean>;
  /** For createLocalModel: an endpoint without a watchdog counts as available. */
  isAvailable(id: string): boolean;
  /**
   * True while the server of `id` is on its way up (D-100): not checked yet,
   * starting or loading its model, restarting, or being replaced by "Riavvia
   * oMLX". False when it is up, settled on down or failed, or not supervised.
   */
  isSettling(id: string): boolean;
  /** For createLocalModel: an unreachable or stuck endpoint is checked at once. */
  onFailure(id: string): void;
  /** Stops every watchdog at once, even one still starting; later syncs are refused. */
  stop(): Promise<void>;
}

/** Watchdog states on the way up; `stopped` is seen only during a restart, since stop() drops the entry. */
const SETTLING: readonly WatchdogState[] = ['idle', 'starting', 'restarting', 'stopped'];

/** oMLX keeps its settings under HOME. */
export function localServerEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  return cleanChildEnv(from, ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR']);
}

/** The watchdog events that go in the event log: L0, ids, states, pids and codes only. */
export function loggedEvent(event: LocalServerEvent): boolean {
  switch (event.type) {
    case 'state':
    case 'adopt':
    case 'orphan':
    case 'gave-up':
    case 'spawn-error':
    case 'error':
      return true;
    case 'exit':
      return !event.expected;
    case 'spawn':
    case 'restart':
      return false;
  }
}

/**
 * The end of data/<id>.log for the settings page (D-071): at most `maxBytes`,
 * from the first whole line. Empty when there is no log yet.
 */
export function logTail(dataDir: string, id: string, maxBytes = 16 * 1024): string {
  let fd: number;
  try {
    fd = openSync(join(dataDir, `${id}.log`), 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    closeSync(fd);
  }
}

interface PidRecord {
  pid: number;
  /** As `ps -o lstart=` prints it: with the pid, it names one process. */
  started: string;
}

function processStart(pid: number): string | undefined {
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return started === '' ? undefined : started;
  } catch {
    return undefined;
  }
}

function readPid(file: string): PidRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as Partial<PidRecord>;
    return typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 1 && typeof record.started === 'string' ? { pid: record.pid, started: record.started } : undefined;
  } catch {
    return undefined;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Stops the server a previous core started and left behind, if it is still the same process. */
async function reapOrphan(file: string, graceMs: number): Promise<number | undefined> {
  const record = readPid(file);
  rmSync(file, { force: true });
  if (record === undefined || processStart(record.pid) !== record.started) return undefined;
  killGroup(record.pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && processStart(record.pid) === record.started) await new Promise((resolve) => setTimeout(resolve, 100));
  killGroup(record.pid, 'SIGKILL');
  return record.pid;
}

interface Supervised {
  endpoint: Pick<LocalEndpointConfig, 'id' | 'url' | 'command'>;
  watchdog: Watchdog;
  adopted: boolean;
}

/** What decides the process: the model names change without touching it. */
function processOf({ id, url, command }: LocalEndpointConfig): Supervised['endpoint'] {
  return { id, url, ...(command === undefined ? {} : { command: [...command] }) };
}

export function createLocalServers(options: LocalServersOptions): LocalServers {
  const env = localServerEnv(options.env ?? process.env);
  const supervised = new Map<string, Supervised>();
  let order: string[] = [];
  let queue: Promise<void> = Promise.resolve();
  /** The sync queued and not started yet: a later one replaces its endpoints. */
  let pending: { endpoints: readonly LocalEndpointConfig[]; done: Promise<void> } | undefined;
  let closed = false;
  /** Read through a function: stop() may flip the flag while a sync awaits. */
  const isClosed = (): boolean => closed;

  const pidFile = (id: string): string => join(options.dataDir, `${id}.pid`);

  function emit(event: LocalServerEvent): void {
    try {
      options.onEvent?.(event);
    } catch {
      // A broken listener must not stop the supervision.
    }
  }

  /** Keeps data/<id>.pid in step with the process the watchdog started. */
  function track(event: WatchdogEvent): void {
    const entry = supervised.get(event.endpoint);
    if (entry !== undefined && (event.type === 'adopt' || event.type === 'spawn')) entry.adopted = event.type === 'adopt';
    try {
      if (event.type === 'spawn') {
        const started = processStart(event.pid);
        if (started !== undefined) writeFileSync(pidFile(event.endpoint), JSON.stringify({ pid: event.pid, started }), { mode: 0o600 });
      } else if (event.type === 'exit' && readPid(pidFile(event.endpoint))?.pid === event.pid) {
        rmSync(pidFile(event.endpoint), { force: true });
      }
    } catch {
      // Without the file a crashed core may leave an orphan: the supervision goes on.
    }
    emit(event);
  }

  async function startWatchdog(endpoint: Supervised['endpoint'], watchdog: Watchdog): Promise<void> {
    if (endpoint.command !== undefined) {
      const orphan = await reapOrphan(pidFile(endpoint.id), options.timing?.stopGraceMs ?? 5_000);
      if (orphan !== undefined) emit({ type: 'orphan', endpoint: endpoint.id, pid: orphan });
    }
    // stop() may have come while the orphan was stopping: a watchdog never started stays stopped.
    if (!isClosed()) await watchdog.start();
  }

  function watchdogOf(endpoint: Supervised['endpoint']): Watchdog {
    const timing = options.timing ?? {};
    return new Watchdog({
      id: endpoint.id,
      url: endpoint.url,
      ...(endpoint.command === undefined ? {} : { command: endpoint.command }),
      cwd: options.home,
      env,
      logFile: join(options.dataDir, `${endpoint.id}.log`),
      // The first load of a large model from disk takes a while.
      startupTimeoutMs: timing.startupTimeoutMs ?? 180_000,
      ...(timing.intervalMs === undefined ? {} : { intervalMs: timing.intervalMs }),
      ...(timing.backoffMs === undefined ? {} : { backoffMs: timing.backoffMs }),
      ...(timing.stopGraceMs === undefined ? {} : { stopGraceMs: timing.stopGraceMs }),
      onEvent: track,
    });
  }

  async function apply(endpoints: readonly LocalEndpointConfig[]): Promise<void> {
    if (closed) return;
    const wanted = new Map(endpoints.map((endpoint) => [endpoint.id, processOf(endpoint)]));
    const stale = [...supervised.values()].filter(({ endpoint }) => !isDeepStrictEqual(wanted.get(endpoint.id), endpoint));
    for (const { endpoint } of stale) supervised.delete(endpoint.id);
    await Promise.all(stale.map(({ watchdog }) => watchdog.stop()));
    // stop() may have come while the stale ones were stopping.
    if (isClosed()) return;

    const started: Promise<void>[] = [];
    for (const endpoint of wanted.values()) {
      if (supervised.has(endpoint.id)) continue;
      const watchdog = watchdogOf(endpoint);
      supervised.set(endpoint.id, { endpoint, watchdog, adopted: false });
      started.push(startWatchdog(endpoint, watchdog));
    }
    order = [...wanted.keys()];
    await Promise.all(started);
  }

  return {
    sync(endpoints) {
      if (closed) return Promise.reject(new Error('local servers stopped'));
      // One change at a time: a second sync waits for the first to settle.
      // Syncs waiting behind a long start are merged: the last configuration
      // wins, and every caller resolves when it is applied.
      if (pending !== undefined) {
        pending.endpoints = endpoints;
        return pending.done;
      }
      const waiting: { endpoints: readonly LocalEndpointConfig[]; done: Promise<void> } = { endpoints, done: Promise.resolve() };
      waiting.done = queue.then(() => {
        pending = undefined;
        return apply(waiting.endpoints);
      });
      pending = waiting;
      queue = waiting.done.catch(() => undefined);
      return waiting.done;
    },

    status() {
      return order.flatMap((id) => {
        const entry = supervised.get(id);
        if (entry === undefined) return [];
        return [{ id, url: entry.endpoint.url, managed: entry.endpoint.command !== undefined, adopted: entry.adopted, state: entry.watchdog.state }];
      });
    },

    restart(id) {
      if (closed) return Promise.reject(new Error('local servers stopped'));
      const next = queue.then(async () => {
        const entry = supervised.get(id);
        if (entry === undefined || isClosed()) return false;
        // Listed while it stops, as not available: the model does not send it requests.
        let starting: Promise<void> | undefined;
        try {
          await entry.watchdog.stop();
        } finally {
          if (!isClosed() && supervised.get(id) === entry) {
            const watchdog = watchdogOf(entry.endpoint);
            supervised.set(id, { endpoint: entry.endpoint, watchdog, adopted: false });
            starting = startWatchdog(entry.endpoint, watchdog);
          }
        }
        await starting;
        return true;
      });
      queue = next.then(() => undefined, () => undefined);
      return next;
    },

    isSettling(id) {
      const state = supervised.get(id)?.watchdog.state;
      return state !== undefined && SETTLING.includes(state);
    },

    isAvailable(id) {
      return supervised.get(id)?.watchdog.isAvailable() ?? true;
    },

    onFailure(id) {
      supervised.get(id)?.watchdog.reportFailure();
    },

    async stop() {
      // Stop first, then wait: a sync still waiting for a model to load would
      // otherwise hold the shutdown for minutes.
      closed = true;
      const all = [...supervised.values()];
      supervised.clear();
      order = [];
      await Promise.all(all.map(({ watchdog }) => watchdog.stop()));
      await queue;
    },
  };
}
