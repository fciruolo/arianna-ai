import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

import { localEndpointUrl } from './endpoint.ts';
import { localRequest } from './http.ts';

/**
 * Keeps a local inference server alive (docs/SPEC.md: oMLX has been seen to
 * collapse after long activity). The watchdog checks `GET {url}/models` at a
 * fixed interval and, when it owns a start command, restarts the server after
 * it exits or stops answering. Without a command it only reports health, and
 * the model falls back to the next endpoint.
 *
 * A server that is already answering at start is adopted: the watchdog cannot
 * stop it, but takes over with its own process once it fails (for instance a
 * server left behind by a core that was killed). An adopted server that hangs
 * without dying cannot be stopped: the new process finds the port taken and
 * the watchdog ends in `failed` (D-033).
 */
export type WatchdogState = 'idle' | 'starting' | 'up' | 'down' | 'restarting' | 'failed' | 'stopped';

export type WatchdogEvent =
  | { type: 'state'; endpoint: string; state: WatchdogState; previous: WatchdogState }
  | { type: 'adopt'; endpoint: string }
  | { type: 'spawn'; endpoint: string; pid: number }
  /** The command could not be started; `code` is the system error code, e.g. ENOENT. */
  | { type: 'spawn-error'; endpoint: string; code: string }
  /** The supervision itself broke (for instance the log file cannot be opened): state `failed`. */
  | { type: 'error'; endpoint: string; message: string }
  | { type: 'exit'; endpoint: string; pid: number; code: number | null; signal: string | null; expected: boolean }
  | { type: 'restart'; endpoint: string; reason: RestartReason; attempt: number }
  | { type: 'gave-up'; endpoint: string; restarts: number; windowMs: number };

export type RestartReason = 'exit' | 'unhealthy' | 'startup-failed';

export interface WatchdogOptions {
  /** Endpoint id, for events. */
  id: string;
  /** Base URL of the OpenAI-compatible API; loopback only. */
  url: string;
  /** argv of the server (no shell). Without it the watchdog only monitors. */
  command?: readonly string[];
  cwd?: string;
  /** File that receives the server's stdout and stderr; discarded otherwise. Logs may contain prompts: keep it in data/. */
  logFile?: string;
  intervalMs?: number;
  healthTimeoutMs?: number;
  /** Consecutive failed checks (or reported failures) before a restart. */
  failuresBeforeRestart?: number;
  startupTimeoutMs?: number;
  /** More restarts than this within `restartWindowMs` → state `failed`, no more restarts. */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Base delay before a restart, doubled at each consecutive one, at most 30 s. */
  backoffMs?: number;
  /** Time between SIGTERM and SIGKILL when stopping the server. */
  stopGraceMs?: number;
  onEvent?: (event: WatchdogEvent) => void;
}

const MAX_BACKOFF_MS = 30_000;
const STARTUP_POLL_MS = 250;

export class Watchdog {
  readonly id: string;
  readonly #url: string;
  readonly #options: Required<Omit<WatchdogOptions, 'command' | 'cwd' | 'logFile' | 'onEvent'>> &
    Pick<WatchdogOptions, 'command' | 'cwd' | 'logFile' | 'onEvent'>;

  #state: WatchdogState = 'idle';
  #running = false;
  #loop: Promise<void> | undefined;
  #child: ChildProcess | undefined;
  #childExit: Promise<void> | undefined;
  #stopping = new Set<number>();
  #failures = 0;
  #needsLaunch = false;
  #reason: RestartReason = 'exit';
  #restarts: number[] = [];
  #consecutiveRestarts = 0;
  #launched = false;
  #wake: (() => void) | undefined;
  #woken = false;
  #waiters: { states: readonly WatchdogState[]; resolve: () => void }[] = [];

  constructor(options: WatchdogOptions) {
    if (options.command?.length === 0) throw new TypeError('command must not be empty');
    this.id = options.id;
    this.#url = localEndpointUrl(options.url);
    this.#options = {
      intervalMs: 5_000,
      healthTimeoutMs: 3_000,
      failuresBeforeRestart: 3,
      startupTimeoutMs: 180_000,
      maxRestarts: 5,
      restartWindowMs: 600_000,
      backoffMs: 1_000,
      stopGraceMs: 5_000,
      ...options,
    };
  }

  get state(): WatchdogState {
    return this.#state;
  }

  /** True when the last check passed. */
  isAvailable(): boolean {
    return this.#state === 'up';
  }

  /**
   * Starts supervising. Resolves once the server is up, or the watchdog has
   * settled on `down` (no command), `failed` or `stopped`.
   */
  async start(): Promise<void> {
    if (this.#running) throw new Error(`watchdog ${this.id} already started`);
    this.#running = true;
    const settled = this.waitForState(['up', 'down', 'failed', 'stopped']);
    const healthy = await this.#healthy();
    if (!this.#isRunning()) return; // stop() was called meanwhile
    if (healthy) {
      if (this.#options.command !== undefined) {
        this.#emit({ type: 'adopt', endpoint: this.id });
        this.#launched = true;
      }
      this.#setState('up');
    } else if (this.#options.command === undefined) {
      this.#setState('down');
    } else {
      this.#needsLaunch = true;
    }
    this.#loop = this.#run().catch(async (error: unknown) => {
      this.#running = false;
      const code = (error as { code?: unknown } | null)?.code;
      this.#emit({ type: 'error', endpoint: this.id, message: typeof code === 'string' ? code : String(error) });
      await this.#killChild();
      this.#setState('failed');
    });
    await settled;
  }

  /** Stops supervising and stops the server it started (an adopted one is left alone). */
  async stop(): Promise<void> {
    this.#running = false;
    this.#poke();
    await this.#loop;
    await this.#killChild();
    this.#setState('stopped');
  }

  /**
   * A request found the server unreachable or stuck: check it now instead of
   * at the next interval. A server that still answers is not restarted, so a
   * long generation that hit its timeout does not cost a restart.
   */
  reportFailure(): void {
    if (this.#running) this.#poke();
  }

  /** Resolves when the state is one of `states` (immediately if it already is). */
  waitForState(states: readonly WatchdogState[]): Promise<void> {
    if (states.includes(this.#state)) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ states, resolve }));
  }

  async #run(): Promise<void> {
    while (this.#running) {
      if (this.#needsLaunch) {
        if (!this.#launched) {
          // First launch: not a restart.
          this.#launched = true;
          await this.#launch();
          continue;
        }
        if (!this.#allowRestart()) {
          await this.#killChild();
          this.#setState('failed');
          this.#running = false;
          break;
        }
        this.#setState('restarting');
        this.#emit({ type: 'restart', endpoint: this.id, reason: this.#reason, attempt: this.#consecutiveRestarts });
        await this.#killChild();
        await this.#sleep(Math.min(this.#options.backoffMs * 2 ** (this.#consecutiveRestarts - 1), MAX_BACKOFF_MS));
        if (!this.#isRunning()) break;
        await this.#launch();
        continue;
      }

      await this.#sleep(this.#options.intervalMs);
      if (!this.#isRunning()) break;

      const owned = this.#options.command !== undefined;
      if (owned && this.#childExited()) {
        this.#markForLaunch('exit');
        continue;
      }
      if (await this.#healthy()) {
        this.#failures = 0;
        this.#consecutiveRestarts = 0;
        this.#setState('up');
        continue;
      }
      this.#failures += 1;
      if (this.#failures < this.#options.failuresBeforeRestart) continue;
      if (owned) this.#markForLaunch('unhealthy');
      else this.#setState('down');
    }
  }

  /** Read through a method: `stop()` may flip the flag while the loop awaits. */
  #isRunning(): boolean {
    return this.#running;
  }

  #markForLaunch(reason: RestartReason): void {
    this.#needsLaunch = true;
    this.#reason = reason;
  }

  /** Counts this restart; false when the window already holds too many. */
  #allowRestart(): boolean {
    const now = Date.now();
    this.#restarts = this.#restarts.filter((at) => now - at < this.#options.restartWindowMs);
    if (this.#restarts.length >= this.#options.maxRestarts) {
      this.#emit({ type: 'gave-up', endpoint: this.id, restarts: this.#restarts.length, windowMs: this.#options.restartWindowMs });
      return false;
    }
    this.#restarts.push(now);
    this.#consecutiveRestarts += 1;
    return true;
  }

  /** Spawns the server and waits until it answers, exits or times out. */
  async #launch(): Promise<void> {
    const [file, ...args] = this.#options.command ?? [];
    if (file === undefined) return;
    this.#needsLaunch = false;
    this.#failures = 0;
    this.#setState('starting');

    const log = this.#options.logFile === undefined ? undefined : openSync(this.#options.logFile, 'a');
    let child: ChildProcess;
    try {
      // Own process group, so that stopping it also stops the workers it forks.
      child = spawn(file, args, {
        cwd: this.#options.cwd,
        detached: true,
        stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'],
      });
    } finally {
      if (log !== undefined) closeSync(log);
    }
    this.#child = child;
    this.#childExit = new Promise((resolve) => {
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (child.pid === undefined) this.#emit({ type: 'spawn-error', endpoint: this.id, code: error.code ?? 'unknown' });
        resolve();
      });
      child.once('exit', (code, signal) => {
        const pid = child.pid ?? -1;
        const expected = this.#stopping.delete(pid);
        this.#emit({ type: 'exit', endpoint: this.id, pid, code, signal, expected });
        resolve();
        // An exit the watchdog caused must not cut short the backoff that follows.
        if (!expected) this.#poke();
      });
    });
    if (child.pid !== undefined) this.#emit({ type: 'spawn', endpoint: this.id, pid: child.pid });

    const deadline = Date.now() + this.#options.startupTimeoutMs;
    while (this.#running && Date.now() < deadline) {
      if (this.#childExited()) break;
      // Answering while our child is gone means someone else holds the port.
      if ((await this.#healthy()) && !this.#childExited()) {
        this.#setState('up');
        return;
      }
      await this.#sleep(STARTUP_POLL_MS);
    }
    if (this.#running) this.#markForLaunch('startup-failed');
  }

  #childExited(): boolean {
    const child = this.#child;
    return child !== undefined && (child.exitCode !== null || child.signalCode !== null || child.pid === undefined);
  }

  async #killChild(): Promise<void> {
    const child = this.#child;
    const exited = this.#childExit;
    this.#child = undefined;
    this.#childExit = undefined;
    if (child === undefined || exited === undefined) return;
    const pid = child.pid;
    if (pid === undefined) {
      await exited;
      return;
    }
    if (child.exitCode === null && child.signalCode === null) {
      this.#stopping.add(pid);
      killGroup(pid, 'SIGTERM');
      const timer = new Promise<'timeout'>((resolve) => setTimeout(resolve, this.#options.stopGraceMs, 'timeout').unref());
      if ((await Promise.race([exited, timer])) === 'timeout') killGroup(pid, 'SIGKILL');
    }
    await exited;
    // Workers that outlived the main process would keep the port and the memory.
    killGroup(pid, 'SIGKILL');
  }

  async #healthy(): Promise<boolean> {
    try {
      const response = await localRequest(`${this.#url}/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.#options.healthTimeoutMs),
      });
      return response.status >= 200 && response.status <= 299;
    } catch {
      return false;
    }
  }

  /** Sleeps, but wakes early on stop, on a child exit or on a reported failure. */
  #sleep(ms: number): Promise<void> {
    if (this.#woken) {
      this.#woken = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      this.#wake = undefined;
    });
  }

  /** Wakes the current sleep, or makes the next one return at once. */
  #poke(): void {
    if (this.#wake === undefined) this.#woken = true;
    else this.#wake();
  }

  #setState(state: WatchdogState): void {
    const previous = this.#state;
    if (state === previous) return;
    this.#state = state;
    this.#emit({ type: 'state', endpoint: this.id, state, previous });
    const ready = this.#waiters.filter((waiter) => waiter.states.includes(state));
    this.#waiters = this.#waiters.filter((waiter) => !waiter.states.includes(state));
    for (const waiter of ready) waiter.resolve();
  }

  #emit(event: WatchdogEvent): void {
    try {
      this.#options.onEvent?.(event);
    } catch {
      // A broken listener must not stop the supervision.
    }
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}
