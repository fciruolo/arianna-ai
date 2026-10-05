import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';

import type { LocalEndpointConfig, ModelCatalog } from '@arianna/config';
import { createLocalModel, LocalModelError, type ChatRequest, type ChatResult, type LocalModel } from '@arianna/executors';

/**
 * The memory policy of the local servers (D-107, stage E). oMLX keeps every
 * model it served in memory until its own guard evicts one: after a trial of
 * the 9B the Mac of 32 GB was swapping and oMLX wrote 0.6 tokens/s. The core
 * keeps its own account of what it made oMLX load, and:
 *
 * (a) when the model of a role changes, unloads the old one once no request
 *     uses it and no other alias still serves it (like D-074 for the calls);
 * (b) before a request that would load a model, adds the catalog estimates
 *     (`ram_min_gib`) of the models it believes loaded to the new one, and
 *     over the budget unloads the idle ones first, least recently used first;
 *     if the models at work still leave no room, refuses the request with the
 *     status oMLX's own guard uses (507), never swapping;
 * (c) watches swap and memory pressure and reports the level (L0).
 *
 * oMLX offers no list of the loaded models that the core could verify: the
 * account is what the core asked for since the server started, and a model
 * loaded by someone else (pnpm eval:models from a terminal) is not in it.
 * Unloading is idempotent (400 when the model was not loaded), so a role
 * change unloads the old model even when the account does not hold it.
 *
 * Model names here are catalog ids, never data: everything this module
 * reports is L0.
 */

const GIB = 1024 ** 3;

/** Share of the physical memory the local models may take: macOS gives the GPU about 75% by default. */
export const MODEL_MEMORY_FRACTION = 0.75;

/** `--memory-guard-gb N` (or `=N`) in the command of an oMLX endpoint: its own ceiling, in GB. */
export function memoryGuardGib(command: readonly string[] | undefined): number | undefined {
  if (command === undefined) return undefined;
  for (let index = 0; index < command.length; index += 1) {
    const arg = command[index] ?? '';
    let raw: string | undefined;
    if (arg === '--memory-guard-gb') raw = command[index + 1];
    else if (arg.startsWith('--memory-guard-gb=')) raw = arg.slice('--memory-guard-gb='.length);
    else continue;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  return undefined;
}

/** The ceiling for the models of one endpoint: the machine share, or the server's own guard when lower. */
export function memoryBudgetGib(totalBytes: number, guardGib?: number, fraction = MODEL_MEMORY_FRACTION): number {
  const share = (totalBytes / GIB) * fraction;
  return guardGib === undefined ? share : Math.min(share, guardGib);
}

/** The memory a model needs once loaded, from the catalog; undefined for a name the catalog does not know. */
export function modelRamGib(catalog: ModelCatalog, name: string): number | undefined {
  return catalog.models.find((entry) => entry.id === name)?.ramMinGib;
}

export interface LoadedModel {
  endpoint: string;
  name: string;
  /** Undefined: not in the catalog, counted as 0. */
  gib: number | undefined;
  /** Requests in flight on it. */
  busy: number;
  lastUsed: number;
  /** True after the first answer: the server holds it, and no later error takes it out of the account. */
  confirmed?: boolean;
}

/**
 * An error that proves the server did not load the model: no server
 * answered, or it refused the name (404, 400) or the memory (507). A
 * timeout, a cancelled request or an unknown error may come after the load.
 */
export function provesNotLoaded(error: unknown): boolean {
  if (!(error instanceof LocalModelError)) return false;
  if (error.kind === 'unavailable') return true;
  return error.kind === 'http' && (error.status === 404 || error.status === 400 || error.status === 507);
}

export interface LoadPlan {
  /** Idle models to unload first, least recently used first. */
  evict: LoadedModel[];
  /** False: even after the evictions the models at work leave no room. */
  fits: boolean;
  /** Estimated GiB once the plan is applied and the new model loaded. */
  totalGib: number;
}

/**
 * What to unload before loading `incoming`. A model already loaded needs
 * nothing; a model the catalog does not know is not estimated and always
 * fits (oMLX's guard still applies). Only idle models that are not pinned
 * (the model of a call in progress, between two turns) can go, least
 * recently used first, and no more than needed: a model picked on the way
 * that turns out not to be needed once a larger one is out stays. When the
 * plan cannot fit, nothing is evicted.
 */
export function planLoad(
  loaded: readonly LoadedModel[],
  incoming: { endpoint: string; name: string; gib: number | undefined },
  budgetGib: number,
  pinned: (model: LoadedModel) => boolean = () => false,
): LoadPlan {
  const sum = (models: readonly LoadedModel[]): number => models.reduce((total, model) => total + (model.gib ?? 0), 0);
  if (loaded.some((model) => model.endpoint === incoming.endpoint && model.name === incoming.name)) {
    return { evict: [], fits: true, totalGib: sum(loaded) };
  }
  let total = sum(loaded) + (incoming.gib ?? 0);
  if (incoming.gib === undefined || total <= budgetGib) return { evict: [], fits: true, totalGib: total };
  const idle = loaded.filter((model) => model.busy === 0 && (model.gib ?? 0) > 0 && !pinned(model)).sort((a, b) => a.lastUsed - b.lastUsed);
  let evict: LoadedModel[] = [];
  for (const model of idle) {
    if (total <= budgetGib) break;
    evict.push(model);
    total -= model.gib ?? 0;
  }
  if (total > budgetGib) return { evict: [], fits: false, totalGib: sum(loaded) + incoming.gib };
  // Not more than needed: the most recently used of the picked ones stays when there is room for it.
  for (const model of [...evict].reverse()) {
    if (total + (model.gib ?? 0) <= budgetGib) {
      evict = evict.filter((other) => other !== model);
      total += model.gib ?? 0;
    }
  }
  return { evict, fits: true, totalGib: total };
}

/** Model names an endpoint served before a change and no alias serves after it: the ones to unload. */
export function staleModels(before: readonly LocalEndpointConfig[], after: readonly LocalEndpointConfig[]): { endpoint: string; name: string }[] {
  const stale: { endpoint: string; name: string }[] = [];
  for (const endpoint of before) {
    const now = after.find((other) => other.id === endpoint.id);
    // A removed endpoint is stopped by the local servers, with its memory.
    if (now === undefined) continue;
    const kept = new Set(Object.values(now.models));
    for (const name of new Set(Object.values(endpoint.models))) {
      if (!kept.has(name)) stale.push({ endpoint: endpoint.id, name });
    }
  }
  return stale;
}

/** The endpoint a request for `alias` goes to first, in the order createLocalModel tries them. */
export function targetEndpoint(endpoints: readonly LocalEndpointConfig[], alias: string, isAvailable: (id: string) => boolean): LocalEndpointConfig | undefined {
  const serving = endpoints.filter((endpoint) => endpoint.models[alias] !== undefined);
  return serving.find((endpoint) => isAvailable(endpoint.id)) ?? serving[0];
}

// ---- Swap and memory pressure -------------------------------------------

export interface SwapSample {
  usedBytes: number;
  totalBytes: number;
  /** macOS kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical. */
  pressure?: number;
}

export type SwapLevel = 'ok' | 'high' | 'critical';

const UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: GIB, T: 1024 ** 4 };

/** `sysctl -n vm.swapusage` of macOS: "total = 9216.00M  used = 8325.38M  free = 890.62M  (encrypted)". */
export function parseSwapUsage(text: string): Pick<SwapSample, 'usedBytes' | 'totalBytes'> | undefined {
  const field = (name: string): number | undefined => {
    const match = new RegExp(`${name}\\s*=\\s*([0-9.]+)([BKMGT])`).exec(text);
    if (match === null) return undefined;
    const value = Number(match[1]);
    const unit = UNITS[match[2] ?? ''];
    return Number.isFinite(value) && unit !== undefined ? Math.round(value * unit) : undefined;
  };
  const total = field('total');
  const used = field('used');
  return total === undefined || used === undefined ? undefined : { usedBytes: used, totalBytes: total };
}

/** /proc/meminfo of Linux: SwapTotal and SwapFree, in kB. */
export function parseMeminfoSwap(text: string): Pick<SwapSample, 'usedBytes' | 'totalBytes'> | undefined {
  const field = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s*(\\d+)\\s*kB`, 'm').exec(text);
    return match === null ? undefined : Number(match[1]) * 1024;
  };
  const total = field('SwapTotal');
  const free = field('SwapFree');
  return total === undefined || free === undefined ? undefined : { usedBytes: total - free, totalBytes: total };
}

/** Swap in use that counts as high: 10% of the physical memory, at least 2 GiB. */
export function swapThreshold(memoryBytes: number): number {
  return Math.max(2 * GIB, memoryBytes * 0.1);
}

/**
 * The level of a sample. Critical pressure is critical; warning pressure or
 * swap over the threshold is high. Back to ok only below three quarters of
 * the threshold with normal pressure, so that the level does not flap.
 * macOS keeps pages in swap after the pressure ends: the level stays high
 * until they are freed, for instance by restarting oMLX.
 */
export function swapLevel(sample: SwapSample, memoryBytes: number, previous: SwapLevel = 'ok'): SwapLevel {
  if (sample.pressure !== undefined && sample.pressure >= 4) return 'critical';
  const threshold = swapThreshold(memoryBytes);
  if ((sample.pressure !== undefined && sample.pressure >= 2) || sample.usedBytes >= threshold) return 'high';
  if (previous !== 'ok' && sample.usedBytes >= threshold * 0.75) return 'high';
  return 'ok';
}

const execFileAsync = promisify(execFile);

async function run(file: string, args: string[]): Promise<string> {
  return (await execFileAsync(file, args, { timeout: 5_000, encoding: 'utf8' })).stdout;
}

/** One sample of this machine, or undefined where it cannot be read. */
export async function readSwap(platform: NodeJS.Platform = process.platform): Promise<SwapSample | undefined> {
  try {
    if (platform === 'darwin') {
      const usage = parseSwapUsage(await run('sysctl', ['-n', 'vm.swapusage']));
      if (usage === undefined) return undefined;
      const pressure = Number((await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).catch(() => '')).trim());
      return Number.isInteger(pressure) && pressure > 0 ? { ...usage, pressure } : usage;
    }
    if (platform === 'linux') return parseMeminfoSwap(await readFile('/proc/meminfo', 'utf8'));
  } catch {
    // A machine that does not say is not a warning.
  }
  return undefined;
}

// ---- The account ----------------------------------------------------------

export type ModelMemoryEvent =
  | { type: 'unloaded'; endpoint: string; model: string; reason: 'role-changed' | 'budget' }
  | { type: 'refused'; endpoint: string; model: string; needGib: number; busyGib: number; budgetGib: number }
  | { type: 'swap'; level: SwapLevel; previous: SwapLevel; usedGib: number; pressure: number | null };

export interface MemorySnapshot {
  memoryGib: number;
  /** The ceiling of each endpoint the core knows, in GiB. */
  budgets: { endpoint: string; gib: number }[];
  /** What the core made the local servers load, by its own account. */
  loaded: { endpoint: string; model: string; gib: number | null; busy: boolean }[];
  estimatedGib: number;
  swap: { level: SwapLevel; usedGib: number; totalGib: number; pressure: number | null } | null;
}

export interface ModelMemoryOptions {
  catalog: () => ModelCatalog;
  /** The endpoints of the current arianna.toml: their guards and models. */
  endpoints: () => readonly LocalEndpointConfig[];
  isAvailable: (id: string) => boolean;
  /** Unloads one model by name from one endpoint; best effort, true once unloaded. */
  unload: (endpoint: LocalEndpointConfig, name: string) => Promise<boolean>;
  /**
   * A model that must not be evicted even while idle: the model of the calls
   * while a call is in progress, idle between two turns. Read synchronously.
   */
  pinned?: (endpoint: string, name: string) => boolean;
  /** How long an unload may hold the requests behind it; 5 s by default. */
  unloadTimeoutMs?: number;
  memoryBytes?: number;
  now?: () => number;
  readSwap?: () => Promise<SwapSample | undefined>;
  /** Every 30 s by default; 0 turns the swap watch off. */
  swapIntervalMs?: number;
  onEvent?: (event: ModelMemoryEvent) => void;
  onError?: (error: unknown) => void;
}

export interface ModelMemory {
  /** The same model, with every request admitted against the budget and counted. */
  wrap(model: LocalModel, endpoints: readonly LocalEndpointConfig[]): LocalModel;
  /** After a change of roles or model names: unloads what no alias serves any more, once idle. */
  modelsChanged(before: readonly LocalEndpointConfig[], after: readonly LocalEndpointConfig[]): Promise<void>;
  /** The server of `endpoint` started or exited: it holds nothing. */
  serverReset(endpoint: string): void;
  snapshot(): MemorySnapshot;
  /** One swap check now (the timer calls it too). */
  checkSwap(): Promise<void>;
  stop(): void;
}

const key = (endpoint: string, name: string): string => `${endpoint}\u0000${name}`;

/** A model name in an event or in the snapshot: catalog ids only, anything else is a name the user chose. */
export const UNCATALOGUED = 'uncatalogued';

export function createModelMemory(options: ModelMemoryOptions): ModelMemory {
  const memoryBytes = options.memoryBytes ?? totalmem();
  const now = options.now ?? Date.now;
  const unloadTimeoutMs = options.unloadTimeoutMs ?? 5_000;
  const loaded = new Map<string, LoadedModel>();
  /** Stale models still at work: unloaded when their last request ends. */
  const pending = new Map<string, LocalEndpointConfig>();
  /** Unloads in flight: a request for the same model waits for its end. */
  const unloading = new Map<string, Promise<void>>();
  /**
   * Admissions of models not in the account and every unload, one at a time:
   * two requests must not both see room for themselves, and an unload must
   * not cross a load of the same model. A model already in the account skips it.
   */
  let queue: Promise<unknown> = Promise.resolve();
  let swap: { level: SwapLevel; sample: SwapSample } | undefined;
  let stopped = false;

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  }

  function emit(event: ModelMemoryEvent): void {
    if (stopped) return;
    try {
      options.onEvent?.(event);
    } catch {
      // A broken listener must not stop a request.
    }
  }
  const fail = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Ignored, as above.
    }
  };

  /** The catalog estimate; a catalog being edited does not stop a request: the model goes unestimated. */
  function ramOf(name: string): number | undefined {
    try {
      return modelRamGib(options.catalog(), name);
    } catch (error) {
      fail(error);
      return undefined;
    }
  }
  const shown = (name: string, gib: number | undefined): string => (gib === undefined ? UNCATALOGUED : name);

  function budgetOf(endpoint: LocalEndpointConfig): number {
    return memoryBudgetGib(memoryBytes, memoryGuardGib(endpoint.command));
  }

  const isPinned = (model: { endpoint: string; name: string }): boolean => {
    try {
      return options.pinned?.(model.endpoint, model.name) ?? false;
    } catch (error) {
      fail(error);
      // When in doubt the model stays.
      return true;
    }
  };

  /** Never longer than `unloadTimeoutMs`: a slow unload counts as not done. */
  async function unloadWithin(endpoint: LocalEndpointConfig, name: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => { resolve(false); }, unloadTimeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([options.unload(endpoint, name), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Takes the model out of the account at once and unloads it; the promise ends with the unload. */
  function drop(endpoint: LocalEndpointConfig, name: string, reason: 'role-changed' | 'budget'): Promise<void> {
    const id = key(endpoint.id, name);
    const gib = loaded.get(id)?.gib ?? ramOf(name);
    loaded.delete(id);
    pending.delete(id);
    if (stopped) return Promise.resolve();
    const work = (async () => {
      try {
        if (await unloadWithin(endpoint, name)) emit({ type: 'unloaded', endpoint: endpoint.id, model: shown(name, gib), reason });
      } catch (error) {
        fail(error);
      }
    })().finally(() => {
      if (unloading.get(id) === work) unloading.delete(id);
    });
    unloading.set(id, work);
    return work;
  }

  /** A stale model, once idle: unloaded in the queue, unless a request took it again meanwhile. */
  function dropStale(endpoint: LocalEndpointConfig, name: string): Promise<void> {
    return serial(async () => {
      if (stopped) return;
      const id = key(endpoint.id, name);
      if ((loaded.get(id)?.busy ?? 0) > 0) {
        pending.set(id, endpoint);
        return;
      }
      await drop(endpoint, name, 'role-changed');
    });
  }

  function configOf(id: string, fallback: readonly LocalEndpointConfig[]): LocalEndpointConfig | undefined {
    return options.endpoints().find((endpoint) => endpoint.id === id) ?? fallback.find((endpoint) => endpoint.id === id);
  }

  /** Makes room for `name` on `endpoint` and counts the request; throws the 507 of a full machine. */
  async function admit(endpoint: LocalEndpointConfig, name: string, endpoints: readonly LocalEndpointConfig[]): Promise<LoadedModel> {
    const id = key(endpoint.id, name);
    await unloading.get(id);
    const gib = ramOf(name);
    const budget = budgetOf(endpoint);
    const plan = planLoad([...loaded.values()], { endpoint: endpoint.id, name, gib }, budget, isPinned);
    if (!plan.fits) {
      const heldGib = [...loaded.values()].filter((model) => model.busy > 0 || isPinned(model)).reduce((total, model) => total + (model.gib ?? 0), 0);
      emit({ type: 'refused', endpoint: endpoint.id, model: shown(name, gib), needGib: gib ?? 0, busyGib: heldGib, budgetGib: budget });
      throw new LocalModelError(
        'http',
        `not enough memory for ${shown(name, gib)}: about ${String(gib ?? 0)} GiB, ${String(heldGib)} GiB taken by models at work, ceiling ${budget.toFixed(1)} GiB`,
        { endpoint: endpoint.id, status: 507 },
      );
    }
    // Out of the account all together before the first wait: a request on the
    // fast path never takes a model that is about to be unloaded.
    const drops: Promise<void>[] = [];
    for (const model of plan.evict) {
      const config = configOf(model.endpoint, endpoints);
      if (config === undefined) loaded.delete(key(model.endpoint, model.name));
      else drops.push(drop(config, model.name, 'budget'));
    }
    await Promise.all(drops);
    const existing = loaded.get(id);
    const entry = existing ?? { endpoint: endpoint.id, name, gib, busy: 0, lastUsed: now() };
    entry.busy += 1;
    loaded.set(id, entry);
    return entry;
  }

  function release(entry: LoadedModel): void {
    entry.busy = Math.max(0, entry.busy - 1);
    entry.lastUsed = now();
    const stale = pending.get(key(entry.endpoint, entry.name));
    if (entry.busy === 0 && stale !== undefined) dropStale(stale, entry.name).catch(fail);
  }

  function wrap(model: LocalModel, endpoints: readonly LocalEndpointConfig[]): LocalModel {
    const wrapped: LocalModel = {
      async chat(request: ChatRequest): Promise<ChatResult> {
        const endpoint = targetEndpoint(endpoints, request.model, options.isAvailable);
        const name = endpoint?.models[request.model];
        if (endpoint === undefined || name === undefined) return model.chat(request);
        const id = key(endpoint.id, name);
        const known = loaded.get(id);
        let entry: LoadedModel;
        if (known !== undefined && !unloading.has(id)) {
          // Already in the account: nothing to make room for, no wait behind an unload.
          known.busy += 1;
          entry = known;
        } else {
          entry = await serial(() => admit(endpoint, name, endpoints));
        }
        try {
          const result = await model.chat(request);
          entry.confirmed = true;
          return result;
        } catch (error) {
          // Never answered and the error proves it was not loaded: out of the account.
          if (entry.confirmed !== true && entry.busy === 1 && provesNotLoaded(error) && loaded.get(id) === entry) loaded.delete(id);
          throw error;
        } finally {
          release(entry);
        }
      },
    };
    const unload = model.unload?.bind(model);
    if (unload !== undefined) {
      wrapped.unload = async (alias: string): Promise<boolean> => {
        const done = await unload(alias);
        if (done) {
          for (const endpoint of endpoints) {
            const name = endpoint.models[alias];
            const entry = name === undefined ? undefined : loaded.get(key(endpoint.id, name));
            if (entry !== undefined && entry.busy === 0) loaded.delete(key(endpoint.id, entry.name));
          }
        }
        return done;
      };
    }
    return wrapped;
  }

  async function modelsChanged(before: readonly LocalEndpointConfig[], after: readonly LocalEndpointConfig[]): Promise<void> {
    const work: Promise<void>[] = [];
    for (const { endpoint: id, name } of staleModels(before, after)) {
      const config = after.find((endpoint) => endpoint.id === id);
      if (config === undefined) continue;
      if ((loaded.get(key(id, name))?.busy ?? 0) > 0) pending.set(key(id, name), config);
      else work.push(dropStale(config, name));
    }
    await Promise.all(work);
  }

  async function checkSwap(): Promise<void> {
    const sample = await (options.readSwap ?? readSwap)();
    if (sample === undefined || stopped) return;
    const previous = swap?.level ?? 'ok';
    const level = swapLevel(sample, memoryBytes, previous);
    swap = { level, sample };
    if (level !== previous) emit({ type: 'swap', level, previous, usedGib: round(sample.usedBytes / GIB), pressure: sample.pressure ?? null });
  }

  const interval = options.swapIntervalMs ?? 30_000;
  const timer = interval > 0 ? setInterval(() => { checkSwap().catch(fail); }, interval) : undefined;
  timer?.unref();
  if (timer !== undefined) checkSwap().catch(fail);

  return {
    wrap,
    modelsChanged,
    serverReset(endpoint) {
      for (const [id, entry] of loaded) if (entry.endpoint === endpoint) loaded.delete(id);
      for (const id of pending.keys()) if (id.startsWith(`${endpoint}\u0000`)) pending.delete(id);
    },
    snapshot() {
      const models = [...loaded.values()];
      return {
        memoryGib: round(memoryBytes / GIB),
        budgets: options.endpoints().map((endpoint) => ({ endpoint: endpoint.id, gib: round(budgetOf(endpoint)) })),
        loaded: models.map((entry) => ({ endpoint: entry.endpoint, model: shown(entry.name, entry.gib), gib: entry.gib ?? null, busy: entry.busy > 0 })),
        estimatedGib: models.reduce((total, entry) => total + (entry.gib ?? 0), 0),
        swap:
          swap === undefined
            ? null
            : { level: swap.level, usedGib: round(swap.sample.usedBytes / GIB), totalGib: round(swap.sample.totalBytes / GIB), pressure: swap.sample.pressure ?? null },
      };
    },
    checkSwap,
    stop() {
      stopped = true;
      pending.clear();
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The alias of the throwaway endpoint `unloadModel` builds: never a router alias. */
const UNLOAD_ALIAS = 'memory-unload';

/**
 * Unloads `name` from one endpoint by building a one-alias model on it: the
 * route of D-074 (`POST /v1/models/<name>/unload`), for a name that no alias
 * of the configuration points at any more.
 */
export function unloadModel(endpoint: LocalEndpointConfig, name: string, isAvailable: (id: string) => boolean): Promise<boolean> {
  const model = createLocalModel({ endpoints: [{ id: endpoint.id, url: endpoint.url, models: { [UNLOAD_ALIAS]: name } }], isAvailable });
  return model.unload?.(UNLOAD_ALIAS) ?? Promise.resolve(false);
}
