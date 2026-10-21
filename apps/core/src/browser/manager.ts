import type { NewEvent } from '../events.ts';

import { openDockerChannel, type OpenChannel } from './channel.ts';
import {
  BrowserError,
  browserRunArgs,
  checkImage,
  containerName,
  execDocker,
  leftoverContainers,
  removeContainers,
  type DockerRun,
} from './container.ts';
import { browserSeccompPath, readBrowserImageLock, type BrowserImageLock } from './image.ts';
import { waitForCdp, type CdpPipe } from './transport.ts';

/**
 * One browser for the whole installation (D-264): a second request while one
 * is starting, open, being removed or while the leftovers are cleaned up gets
 * "browser busy". The container is closed by stop(), when its CDP session
 * ends, after IDLE_MS without actions, or at the latest MAX_MS after its
 * start.
 */

export const IDLE_MS = 15 * 60_000;
export const MAX_MS = 30 * 60_000;
export const CDP_READY_MS = 20_000;
const CHECK_EVERY_MS = 30_000;

/** disconnected: the CDP session ended (Playwright closed, or the container stopped). */
export type CloseReason = 'stopped' | 'idle' | 'max' | 'disconnected';

/** When an open browser must close; pure, with the clock passed in. */
export class BrowserLifetime {
  readonly startedAt: number;
  #lastAction: number;
  readonly #idleMs: number;
  readonly #maxMs: number;

  constructor(now: number, idleMs = IDLE_MS, maxMs = MAX_MS) {
    this.startedAt = now;
    this.#lastAction = now;
    this.#idleMs = idleMs;
    this.#maxMs = maxMs;
  }

  touch(now: number): void {
    this.#lastAction = now;
  }

  expired(now: number): CloseReason | null {
    if (now - this.startedAt >= this.#maxMs) return 'max';
    if (now - this.#lastAction >= this.#idleMs) return 'idle';
    return null;
  }
}

export interface OpenBrowser {
  id: string;
  container: string;
  /** The one CDP session of the container, already answering. */
  cdp: CdpPipe;
  /** Marks an action: the idle time starts again. */
  touch(): void;
  /** Closes the browser (the same as stop of the manager). */
  close(reason?: CloseReason): Promise<void>;
}

export interface ManagerOptions {
  home: string;
  docker?: DockerRun;
  openChannel?: OpenChannel;
  readLock?: (home: string) => BrowserImageLock | null;
  seccompPath?: string;
  now?: () => number;
  idleMs?: number;
  maxMs?: number;
  cdpReadyMs?: number;
  /** Periodic check of the lifetime; injectable for tests. */
  every?: (callback: () => void, ms: number) => { clear(): void };
  onClose?: (id: string, reason: CloseReason) => void;
  /** Events without data (L0, only the kind of failure); without it, a line on stderr. */
  onEvent?: (event: NewEvent) => void;
}

interface Active {
  browser: OpenBrowser;
  lifetime: BrowserLifetime;
  timer: { clear(): void };
}

/** A container that must still be removed: the browser stays busy until it is gone. */
interface Closing {
  id: string;
  container: string;
  reason: CloseReason;
  timer: { clear(): void };
  /** onClose is called for a browser that was open, not for a start that failed. */
  notify: boolean;
  /** The removal running now, if any: the timer does not start a second one, a second stop waits for it. */
  removing: Promise<void> | null;
  /** Failures so far; the event goes out at the first one only. */
  failures: number;
}

export type ManagerState = 'free' | 'cleaning' | 'starting' | 'open' | 'closing';

const defaultEvery = (callback: () => void, ms: number): { clear(): void } => {
  const handle = setInterval(callback, ms);
  handle.unref();
  return { clear: () => { clearInterval(handle); } };
};

export class BrowserManager {
  readonly #options: ManagerOptions;
  readonly #docker: DockerRun;
  readonly #open: OpenChannel;
  readonly #now: () => number;
  readonly #every: (callback: () => void, ms: number) => { clear(): void };
  #active: Active | null = null;
  #starting = false;
  #cleaning = false;
  #closing: Closing | null = null;

  constructor(options: ManagerOptions) {
    this.#options = options;
    this.#docker = options.docker ?? execDocker;
    this.#open = options.openChannel ?? openDockerChannel;
    this.#now = options.now ?? Date.now;
    this.#every = options.every ?? defaultEvery;
  }

  get active(): OpenBrowser | null {
    return this.#active?.browser ?? null;
  }

  get state(): ManagerState {
    if (this.#closing) return 'closing';
    if (this.#cleaning) return 'cleaning';
    if (this.#starting) return 'starting';
    return this.#active ? 'open' : 'free';
  }

  /**
   * At the start of the core: removes the containers left by a core that
   * stopped. Refused while this manager has a browser of its own, and the
   * manager is busy while it runs, so no start can slip in between.
   */
  async cleanup(): Promise<string[]> {
    if (this.state !== 'free') throw new BrowserError('busy', 'a browser is in use: nothing to clean up now');
    this.#cleaning = true;
    try {
      const names = await leftoverContainers(this.#docker);
      await removeContainers(this.#docker, names);
      return names;
    } finally {
      this.#cleaning = false;
    }
  }

  async start(id: string): Promise<OpenBrowser> {
    if (this.state !== 'free') throw new BrowserError('busy', 'browser busy, try again shortly');
    const container = containerName(id);
    this.#starting = true;
    let created = false;
    try {
      const lock = (this.#options.readLock ?? readBrowserImageLock)(this.#options.home);
      if (!lock) throw new BrowserError('no-lock', 'config/browser-image.lock is missing: run pnpm browser:build');
      await checkImage(this.#docker, lock.image);
      const args = browserRunArgs({ id, image: lock.image, seccompPath: this.#options.seccompPath ?? browserSeccompPath(this.#options.home) });
      created = true;
      await this.#docker(args, 60_000);
      const cdp = await waitForCdp(this.#open, container, { timeoutMs: this.#options.cdpReadyMs ?? CDP_READY_MS, now: this.#now });
      const lifetime = new BrowserLifetime(this.#now(), this.#options.idleMs, this.#options.maxMs);
      const browser: OpenBrowser = {
        id,
        container,
        cdp,
        touch: () => { lifetime.touch(this.#now()); },
        close: (reason = 'stopped') => this.stop(id, reason),
      };
      const timer = this.#every(() => { this.#check(); }, CHECK_EVERY_MS);
      this.#active = { browser, lifetime, timer };
      // The session ends with the container: then the browser is closed here too.
      void cdp.whenClosed.then(() => this.stop(id, 'disconnected')).catch(() => undefined);
      return browser;
    } catch (error) {
      // `docker run` may have created the container even when it failed.
      if (created) await this.#close({ id, container, reason: 'stopped', notify: false });
      throw error;
    } finally {
      this.#starting = false;
    }
  }

  /** Closes the browser; when docker cannot remove it, it stays busy and the removal is tried again. */
  async stop(id: string, reason: CloseReason = 'stopped'): Promise<void> {
    const active = this.#active;
    if (!active || active.browser.id !== id) {
      // Already closing (the session ended first): wait for the removal under way.
      const closing = this.#closing;
      if (closing?.id === id && closing.removing) await closing.removing;
      return;
    }
    this.#active = null;
    active.timer.clear();
    active.browser.cdp.close();
    await this.#close({ id, container: active.browser.container, reason, notify: true });
  }

  async #close(next: Pick<Closing, 'id' | 'container' | 'reason' | 'notify'>): Promise<void> {
    const closing: Closing = { ...next, removing: null, failures: 0, timer: this.#every(() => { void this.#remove(); }, CHECK_EVERY_MS) };
    this.#closing = closing;
    await this.#remove();
  }

  /** One attempt to remove the closing container, or the one already running. */
  #remove(): Promise<void> {
    const closing = this.#closing;
    if (!closing) return Promise.resolve();
    if (closing.removing) return closing.removing;
    closing.removing = this.#attempt(closing);
    return closing.removing;
  }

  async #attempt(closing: Closing): Promise<void> {
    try {
      await removeContainers(this.#docker, [closing.container]);
    } catch (error) {
      closing.failures += 1;
      // Only the kind of failure, only the first time: the message of docker names the container, that is the job.
      if (closing.failures === 1) this.#event({ kind: 'browser.remove_failed', label: 'L0', payload: { reason: error instanceof BrowserError ? error.code : 'error' } });
      return;
    } finally {
      closing.removing = null;
    }
    if (this.#closing !== closing) return;
    this.#closing = null;
    closing.timer.clear();
    if (closing.notify) this.#safely(() => { this.#options.onClose?.(closing.id, closing.reason); });
  }

  #event(event: NewEvent): void {
    this.#safely(() => {
      if (this.#options.onEvent) this.#options.onEvent(event);
      else {
        const reason = event.payload?.reason;
        console.warn(`browser: ${event.kind} (${typeof reason === 'string' ? reason : ''})`);
      }
    });
  }

  /** A callback of the caller that throws must not become a rejection nobody handles (the timer calls here). */
  #safely(callback: () => void): void {
    try {
      callback();
    } catch {
      console.warn('browser: a callback of the manager failed');
    }
  }

  #check(): void {
    const active = this.#active;
    if (!active) return;
    const reason = active.lifetime.expired(this.#now());
    if (reason) void this.stop(active.browser.id, reason);
  }
}
