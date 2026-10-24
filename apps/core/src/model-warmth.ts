import type { LocalEndpointConfig } from '@arianna/config';
import { LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';

import type { ModelMemory } from './model-memory.ts';

/**
 * The warm model (D-316). After a restart of the core the first question of a
 * new conversation waited about 80 s: oMLX loads a model only at the first
 * request (about 45 s for the 35B), then the first step still took 16-28 s
 * with the prefix in its SSD cache (the grammar of the schema compiled, the
 * weights brought back into memory). Two halves:
 *
 * (a) **warm-up**: when a server that serves the orchestrator comes up (the
 *     start of the core, a restart of the watchdog, «Riavvia»), the core sends
 *     it once, in the background, the first step of Arianna with a fixed
 *     message and one token (the orchestrator's `warmupRequest`). Not with
 *     swap or memory pressure already high, not while another request or a
 *     call is at work. Once per start of the server: an unload for
 *     inactivity never starts it again, or the memory would never be freed.
 * (b) **unload after inactivity**: a model of the account idle for
 *     `[local] idle_unload_minutes` (30 by default, 0 never) leaves the
 *     server. Never during a call, with requests in flight, with task steps at
 *     work or due, a trial running, or a routine due within a few minutes.
 *
 * Everything this module reports is L0: endpoint ids, catalog ids, outcomes,
 * times. The warm-up carries no data of the user's, so it passes no gateway
 * and writes no message, task or gateway row: only the log and the events.
 */

export type WarmOutcome = 'warmed' | 'skipped-swap' | 'skipped-busy' | 'skipped-no-agent' | 'failed';

export type WarmthEvent = { type: 'warm'; endpoint: string; outcome: WarmOutcome; ms: number; code?: string };

export type ModelState = 'warming' | 'loaded' | 'idle-unloaded' | 'not-loaded';

export interface WarmthStatus {
  idleMinutes: number;
  /** One per endpoint of the configuration; `since`: when it was unloaded for inactivity, else null. */
  endpoints: { id: string; state: ModelState; since: string | null; models: string[] }[];
}

export interface ModelWarmthOptions {
  endpoints: () => readonly LocalEndpointConfig[];
  /** The alias of the orchestrator: only a server that serves it is warmed. */
  alias: string;
  /** The warm-up request; undefined when there is nothing to warm. */
  request: () => Promise<ChatRequest | undefined>;
  /** The local model wrapped by the memory account, so that the warm-up is counted. */
  model: () => LocalModel;
  memory: Pick<ModelMemory, 'snapshot' | 'checkSwap' | 'activeRequests' | 'unloadIdle'>;
  callActive: () => boolean;
  /** Task steps running or due, a trial running: no warm-up, no unload. */
  busy: () => Promise<boolean>;
  /** A routine due soon: no unload (it would load the model again at once). */
  soon?: () => Promise<boolean>;
  idleMinutes: () => number;
  now?: () => number;
  /** How often the inactivity is checked; 60 s by default, 0 off (the tests call `tick`). */
  intervalMs?: number;
  /** The longest a warm-up may take, loading included; 5 minutes by default. */
  warmTimeoutMs?: number;
  onEvent?: (event: WarmthEvent) => void;
  onError?: (error: unknown) => void;
}

export interface ModelWarmth {
  /** The server of `endpoint` was started, adopted, exited or went down: the next `serverUp` warms it. */
  serverReset(endpoint: string): void;
  /** The server of `endpoint` answers: warmed once since its last reset. Resolves when the warm-up ends. */
  serverUp(endpoint: string): Promise<void>;
  /** One check of the inactivity now (the timer calls it too). */
  tick(): Promise<void>;
  status(): WarmthStatus;
  stop(): void;
}

/** An event of the local servers, as far as the warm-up reads it. */
export interface ServerEventLike {
  type: string;
  endpoint: string;
  state?: string;
}

/**
 * What an event of the local servers means for the warm-up: a server started,
 * adopted, exited or lost is warmed again when it answers; `up` warms one not
 * yet warmed since. An unload for inactivity is none of these events.
 */
export function onServerEvent(warmth: Pick<ModelWarmth, 'serverReset' | 'serverUp'> | undefined, event: ServerEventLike, onError: (error: unknown) => void): void {
  if (warmth === undefined) return;
  const lost = event.type === 'state' && (event.state === 'down' || event.state === 'failed' || event.state === 'stopped');
  if (event.type === 'spawn' || event.type === 'exit' || event.type === 'adopt' || lost) warmth.serverReset(event.endpoint);
  if (event.type === 'state' && event.state === 'up') warmth.serverUp(event.endpoint).catch(onError);
}

export function createModelWarmth(options: ModelWarmthOptions): ModelWarmth {
  const now = options.now ?? Date.now;
  /** Servers already warmed (or skipped) since their last reset. */
  const settled = new Set<string>();
  const warming = new Set<string>();
  /** When the models of an endpoint were unloaded for inactivity: until the next load or reset. */
  const idleSince = new Map<string, number>();
  const aborts = new Set<AbortController>();
  let ticking = false;
  let stopped = false;
  /** Read through a function: `stop()` may flip the flag while a check awaits. */
  const halted = (): boolean => stopped;

  const fail = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A broken listener must not stop the core.
    }
  };
  const emit = (event: WarmthEvent): void => {
    if (stopped) return;
    try {
      options.onEvent?.(event);
    } catch (error) {
      fail(error);
    }
  };

  function serves(endpoint: string): boolean {
    return options.endpoints().find((entry) => entry.id === endpoint)?.models[options.alias] !== undefined;
  }

  async function serverUp(endpoint: string): Promise<void> {
    if (stopped || settled.has(endpoint)) return;
    settled.add(endpoint);
    if (!serves(endpoint)) return;
    const started = now();
    const done = (outcome: WarmOutcome, code?: string): void => {
      emit({ type: 'warm', endpoint, outcome, ms: now() - started, ...(code === undefined ? {} : { code }) });
    };
    try {
      await options.memory.checkSwap();
    } catch (error) {
      fail(error);
    }
    const level = options.memory.snapshot().swap?.level ?? 'ok';
    if (level !== 'ok') {
      done('skipped-swap');
      return;
    }
    // A request at work loads the model by itself; a warm-up beside it would only compete.
    if (options.memory.activeRequests() > 0 || options.callActive() || (await options.busy())) {
      done('skipped-busy');
      return;
    }
    const request = await options.request();
    if (request === undefined) {
      done('skipped-no-agent');
      return;
    }
    if (halted()) return;
    const abort = new AbortController();
    aborts.add(abort);
    warming.add(endpoint);
    try {
      await options.model().chat({ ...request, timeoutMs: options.warmTimeoutMs ?? 300_000, signal: abort.signal });
      done('warmed');
    } catch (error) {
      // One token cannot close the JSON: the server answered, the work is done.
      if (error instanceof LocalModelError && error.kind === 'bad-response') done('warmed');
      else done('failed', error instanceof LocalModelError ? error.kind : 'error');
    } finally {
      warming.delete(endpoint);
      aborts.delete(abort);
    }
  }

  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    const minutes = options.idleMinutes();
    if (minutes <= 0) return;
    ticking = true;
    try {
      if (warming.size > 0 || options.callActive() || options.memory.activeRequests() > 0) return;
      if (await options.busy()) return;
      if ((await options.soon?.()) === true) return;
      if (options.callActive() || options.memory.activeRequests() > 0) return;
      const unloaded = await options.memory.unloadIdle(minutes * 60_000);
      const at = now();
      for (const { endpoint } of unloaded) idleSince.set(endpoint, at);
    } finally {
      ticking = false;
    }
  }

  const interval = options.intervalMs ?? 60_000;
  const timer = interval > 0 ? setInterval(() => { tick().catch(fail); }, interval) : undefined;
  timer?.unref();

  return {
    serverReset(endpoint) {
      settled.delete(endpoint);
      idleSince.delete(endpoint);
    },
    serverUp,
    tick,
    status() {
      const loaded = options.memory.snapshot().loaded;
      return {
        idleMinutes: options.idleMinutes(),
        endpoints: options.endpoints().map(({ id }) => {
          const models = loaded.filter((entry) => entry.endpoint === id).map((entry) => entry.model);
          if (warming.has(id)) return { id, state: 'warming' as const, since: null, models };
          if (models.length > 0) {
            idleSince.delete(id);
            return { id, state: 'loaded' as const, since: null, models };
          }
          const since = idleSince.get(id);
          return { id, state: since === undefined ? ('not-loaded' as const) : ('idle-unloaded' as const), since: since === undefined ? null : new Date(since).toISOString(), models };
        }),
      };
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      for (const abort of aborts) abort.abort();
    },
  };
}
