import type { CatalogEntry, ModelRole } from '@arianna/config';

import type { LocalServerStatus } from './local-servers.ts';

/**
 * oMLX sees a model downloaded from the "Modelli" page only after it starts
 * again (D-201): it reads the folders of `--model-dir` when it starts, and
 * none of the routes the core knows (`/v1/models`, `/v1/models/<name>/unload`)
 * reads them again. After a download that ended with every file
 * checked, the core restarts the local servers it started itself, with the
 * same restart as "Riavvia oMLX" (D-071), but never under a generation: it
 * waits until no request uses a local model, no call is open, no task step is
 * at work or ready and no trial is running, checking again every few
 * seconds. Downloads that end while it waits are served by the same restart.
 *
 * A server the core adopted (already running when the core started) is not
 * the core's to stop: the page asks the user to restart it by hand.
 */

/**
 * `waiting`: a download is done, the restart waits for the models to be free.
 * `restarting`: oMLX is stopping and loading again. `manual`: a server the
 * core did not start serves the models: the user restarts it by hand.
 * `failed`: the restart did not bring oMLX back: the user restarts it from
 * Impostazioni. The last two stay until the user dismisses them, restarts
 * oMLX from Impostazioni or downloads another model.
 */
export type ReloadState = 'idle' | 'waiting' | 'restarting' | 'manual' | 'failed';

export interface ReloadView {
  state: ReloadState;
  /** The catalog ids downloaded and not yet seen by oMLX (empty when idle). */
  models: string[];
}

/** The roles apps/voice loads on its own (mlx-audio, D-066): a model only for them never goes to oMLX. */
const VOICE_PROCESS_ROLES: readonly ModelRole[] = ['stt', 'tts'];

/**
 * Whether oMLX serves the model, so that a download of it needs a restart.
 * A model with `dir: guard` lives in data/guard/models, out of oMLX's sight (D-203): never.
 */
export function servedByLocalServer(entry: Pick<CatalogEntry, 'runtime' | 'roles' | 'dir'>): boolean {
  if (entry.dir === 'guard' || entry.runtime !== 'mlx') return false;
  return entry.roles.length === 0 || entry.roles.some((role) => !VOICE_PROCESS_ROLES.includes(role));
}

export type ReloadOutcome = 'waiting' | 'restarted' | 'manual' | 'failed';

export interface LocalReloadOptions {
  /** The supervised servers now (local-servers.ts). */
  servers: () => readonly Pick<LocalServerStatus, 'id' | 'managed' | 'adopted'>[];
  /** Stops a server and starts it again; resolves once it has settled. */
  restart: (id: string) => Promise<boolean>;
  /**
   * True while a generation, a call, a task step or a trial may use a local
   * model. The synchronous checks (requests in flight) go last: the restart
   * starts right after the answer, with no wait in between.
   */
  busy: () => Promise<boolean>;
  /** Between two checks of `busy`; 5 s by default. */
  checkMs?: number;
  /** One L0 event: the outcome and the catalog ids. */
  onEvent?: (payload: { outcome: ReloadOutcome; models: string }) => void;
  onError?: (error: unknown) => void;
}

export interface LocalReload {
  /** A download of `modelId` ended with every file checked: oMLX must see it. */
  request(modelId: string): void;
  /**
   * The user restarted oMLX from Impostazioni ("Riavvia oMLX", queued after
   * anything in progress): every download so far is served by it.
   */
  restartedByUser(): void;
  /** The user closed the line of `manual` or `failed`. */
  dismiss(): void;
  view(): ReloadView;
  /** Waits for the reload in progress to end (tests). */
  idle(): Promise<void>;
  /**
   * Stops waiting, without waiting itself: a restart already started ends
   * with the local servers, which the core stops right after.
   */
  stop(): void;
}

export function createLocalReload(options: LocalReloadOptions): LocalReload {
  const checkMs = options.checkMs ?? 5_000;
  const onError = options.onError ?? (() => undefined);
  const controller = new AbortController();
  /** Downloaded, waiting for the next restart. */
  const pending = new Set<string>();
  /** Served by the restart in progress, or left to the user. */
  let current: string[] = [];
  let state: ReloadState = 'idle';
  let loop: Promise<void> | undefined;

  function emit(outcome: ReloadOutcome, models: readonly string[]): void {
    try {
      options.onEvent?.({ outcome, models: models.join(',') });
    } catch (error) {
      onError(error);
    }
  }

  function sleep(): Promise<void> {
    return new Promise((resolve) => {
      if (controller.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, checkMs);
      controller.signal.addEventListener('abort', done, { once: true });
      function done(): void {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', done);
        resolve();
      }
    });
  }

  /** A check that fails (the database down) counts as busy: the restart waits, it never guesses. */
  async function busy(): Promise<boolean> {
    try {
      return await options.busy();
    } catch (error) {
      onError(error);
      return true;
    }
  }

  /** Read through a function: stop() may come while the loop awaits. */
  const stopped = (): boolean => controller.signal.aborted;

  async function run(): Promise<void> {
    while (pending.size > 0 && !stopped()) {
      state = 'waiting';
      // The event only when the restart really waits: a free machine restarts at once.
      let told = false;
      while (!stopped() && pending.size > 0 && (await busy())) {
        if (!told) {
          told = true;
          emit('waiting', [...pending]);
        }
        await sleep();
      }
      // Served meanwhile by a restart of the user.
      if (stopped() || pending.size === 0) return;
      current = [...pending];
      pending.clear();
      const servers = options.servers();
      const targets = servers.filter((server) => server.managed && !server.adopted);
      // An adopted server, or one the core only watches, needs the user.
      const manual = servers.length > targets.length;
      let failed = false;
      if (targets.length > 0) {
        state = 'restarting';
        for (const { id } of targets) {
          try {
            if (!(await options.restart(id))) failed = true;
          } catch (error) {
            failed = true;
            onError(error);
          }
        }
        emit(failed ? 'failed' : 'restarted', current);
      } else if (manual) {
        emit('manual', current);
      }
      // A restart of the user during this one served these models too.
      if (current.length === 0) failed = false;
      state = failed ? 'failed' : manual && current.length > 0 ? 'manual' : 'idle';
      if (state === 'idle') current = [];
    }
  }

  function start(): void {
    if (loop !== undefined) return;
    loop = run()
      .catch(onError)
      .finally(() => {
        loop = undefined;
        if (state === 'waiting' || state === 'restarting') state = 'idle';
        // A request that came while the loop was ending is not lost.
        if (pending.size > 0 && !controller.signal.aborted) start();
      });
  }

  function settle(): void {
    current = [];
    if (state === 'manual' || state === 'failed') state = 'idle';
  }

  return {
    request(modelId) {
      if (controller.signal.aborted) return;
      pending.add(modelId);
      if (state === 'manual' || state === 'failed') {
        // The earlier ones go with the next restart, so the page keeps naming them.
        for (const id of current) pending.add(id);
        current = [];
      }
      start();
    },

    restartedByUser() {
      pending.clear();
      settle();
    },

    dismiss() {
      settle();
    },

    view() {
      if (state === 'idle') return { state, models: [] };
      const models = state === 'waiting' ? [...pending] : state === 'restarting' ? [...current, ...pending] : [...current];
      return { state, models: [...new Set(models)] };
    },

    async idle() {
      while (loop !== undefined) await loop;
    },

    stop() {
      controller.abort();
    },
  };
}
