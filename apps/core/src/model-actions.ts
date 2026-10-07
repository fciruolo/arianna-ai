import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CatalogEntry, ModelCatalog, ModelRole } from '@arianna/config';

import { errorCode } from './jobs.ts';
import { MODELS_DIR, ModelError, PART_SUFFIX, pullFile, type Fetcher, type FileStatus } from './model-files.ts';

/**
 * The actions of the "Modelli" page on a local model (I-3, stage M4, D-137):
 * download (the logic of `pnpm arianna:models pull`: catalog URLs only,
 * resumed from the `.part`, sha256 checked), verify (sha256 of every file),
 * remove from the disk (into the bin `data/models/eliminati`, never erased),
 * empty the bin, unload from the memory of the local server.
 *
 * Downloads and verifications run in the background of the core, one at a
 * time, with their progress kept in memory: a restart of the core stops
 * them, and the next download resumes from the `.part` files. Every action
 * leaves an L0 event with the model id and the outcome only: never a path
 * of the machine, never anything a file holds.
 */

/** The bin inside data/models: a catalog id may never take this name. */
export const TRASH_DIR = 'eliminati';

const SAFE_ID = /^[A-Za-z0-9][\w.-]{0,127}$/;

export type ActionKind = 'download' | 'verify';
export type ActionStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** A download or a verification: the one in progress, or the last one of the model. */
export interface ModelAction {
  modelId: string;
  kind: ActionKind;
  status: ActionStatus;
  /** Bytes downloaded or hashed so far, of `bytesTotal`. */
  bytesDone: number;
  bytesTotal: number;
  startedAt: string;
  finishedAt: string | null;
  /** A code (`network`, `wrong-hash`, `http-status`...), never a message. */
  error: string | null;
  /** Verify: the catalog paths of the files whose size or sha256 does not match. */
  bad: string[];
}

/** What the bin holds: one folder per removed model (or per set of wrong files replaced). */
export interface TrashView {
  folder: string;
  entries: { name: string; sizeBytes: number }[];
  sizeBytes: number;
}

/** What is on the disk for one model: any folder at all, and the bytes still to download. */
export interface DiskState {
  hasFiles: boolean;
  missingBytes: number;
}

export type UnloadOutcome = 'unloaded' | 'busy' | 'failed';

export class ModelActionError extends Error {
  override name = 'ModelActionError';
  readonly code: 'not-found' | 'invalid' | 'conflict';

  constructor(code: ModelActionError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ModelActionsOptions {
  /** Read at each action: a new entry needs no restart. */
  catalog: () => ModelCatalog;
  /** data/: the models are in data/models/<id>. */
  dataDir: string;
  /** The roles of the running configuration. */
  roles: () => Partial<Record<ModelRole, string>>;
  /** The HTTPS client of the downloads (model-http.ts); a fake one in the tests. */
  fetch: Fetcher;
  /** Where the core believes the model is loaded, and whether a request uses it. */
  loaded: (modelId: string) => readonly { endpoint: string; busy: boolean }[];
  /** Unloads the model from every local server that holds it (model-memory.ts). */
  unload: (modelId: string) => Promise<UnloadOutcome>;
  /** A trial of the model (D-081) queued or running. */
  trialOpen: (modelId: string) => Promise<boolean>;
  /** One L0 event: the kind and the model id with the outcome. */
  onEvent: (kind: string, payload: Record<string, string | number>) => void;
  freeBytes?: (path: string) => number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface ModelActions {
  download(modelId: string): ModelAction;
  verify(modelId: string): ModelAction;
  /** Stops the download or the verification in progress of the model. */
  cancel(modelId: string): ModelAction;
  /** Moves data/models/<id> into the bin; `confirm` must be the model id. */
  remove(modelId: string, confirm: unknown): Promise<{ modelId: string; folder: string }>;
  unload(modelId: string): Promise<{ modelId: string; outcome: UnloadOutcome }>;
  trash(): TrashView;
  /** Erases what the bin holds; `confirm` must be true. */
  emptyTrash(confirm: unknown): { removed: number; sizeBytes: number };
  /** The action in progress and the last one of each model. */
  list(): ModelAction[];
  disk(entry: CatalogEntry): DiskState;
  /** Stops the action in progress and waits for its end. */
  stop(): Promise<void>;
}

export function freeBytesOf(path: string): number {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

/** The bytes of a folder, links counted as links: nothing outside it is followed. */
export function folderBytes(path: string): number {
  const stats = lstatSync(path);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const name of readdirSync(path)) total += folderBytes(join(path, name));
  return total;
}

/** What is on the disk for a model, from sizes only (no hash): what the page shows next to the buttons. */
export function diskState(dataDir: string, entry: CatalogEntry): DiskState {
  const folder = join(dataDir, MODELS_DIR, entry.id);
  let hasFiles = false;
  try {
    lstatSync(folder);
    hasFiles = true;
  } catch {
    // Nothing there.
  }
  let missingBytes = 0;
  for (const file of entry.files) {
    const target = join(folder, file.path);
    const size = sizeOf(target);
    if (size === file.sizeBytes) continue;
    // A partial download counts as done for its bytes: the next pull resumes from it.
    const part = size === undefined ? (sizeOf(`${target}${PART_SUFFIX}`) ?? 0) : 0;
    missingBytes += file.sizeBytes - Math.min(part, file.sizeBytes);
  }
  return { hasFiles, missingBytes };
}

/** "2026-10-07T21-03-11-123Z-<id>": sortable, the model id at the end; "-2", "-3"... when the name is taken. */
function binName(trashDir: string, now: Date, modelId: string): string {
  const base = `${now.toISOString().replace(/[:.]/g, '-')}-${modelId}`;
  let name = base;
  for (let count = 2; existsSync(join(trashDir, name)); count += 1) name = `${base}-${String(count)}`;
  return name;
}

async function hashWithProgress(path: string, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new ModelError('aborted', 'verification stopped');
      const buffer = chunk as Buffer;
      hash.update(buffer);
      onBytes(buffer.length);
    }
  } finally {
    stream.destroy();
  }
  return hash.digest('hex');
}

function codeOf(error: unknown): string {
  return error instanceof ModelError ? error.code : errorCode(error);
}

export function createModelActions(options: ModelActionsOptions): ModelActions {
  const now = options.now ?? (() => new Date());
  const free = options.freeBytes ?? freeBytesOf;
  const onError = options.onError ?? (() => undefined);
  const modelsDir = join(options.dataDir, MODELS_DIR);
  const trashDir = join(modelsDir, TRASH_DIR);
  /** The last action of each model, the running one included. */
  const last = new Map<string, ModelAction>();
  let running: { action: ModelAction; controller: AbortController; done: Promise<void> } | undefined;

  function emit(kind: string, payload: Record<string, string | number>): void {
    try {
      options.onEvent(kind, payload);
    } catch (error) {
      onError(error);
    }
  }

  function entryOf(modelId: unknown): CatalogEntry {
    // A catalog id names a folder of data/models: never the bin, never a path.
    if (typeof modelId !== 'string' || !SAFE_ID.test(modelId) || modelId === TRASH_DIR) throw new ModelActionError('not-found', 'the model is not in the catalog');
    const entry = options.catalog().models.find((model) => model.id === modelId);
    if (entry === undefined) throw new ModelActionError('not-found', 'the model is not in the catalog');
    return entry;
  }

  function idle(): void {
    if (running !== undefined) {
      const { kind, modelId } = running.action;
      throw new ModelActionError('conflict', `a ${kind === 'download' ? 'download' : 'verification'} of ${modelId} is running: wait for it or stop it`);
    }
  }

  function rolesOf(modelId: string): ModelRole[] {
    const roles = options.roles();
    return (Object.keys(roles) as ModelRole[]).filter((role) => roles[role] === modelId);
  }

  /** The bin, created when missing; refused when something else took its name. */
  function ensureTrash(): void {
    mkdirSync(trashDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(trashDir).isDirectory()) throw new ModelActionError('invalid', `data/${MODELS_DIR}/${TRASH_DIR} is not a folder`);
  }

  function start(entry: CatalogEntry, kind: ActionKind, bytesTotal: number, work: (action: ModelAction, signal: AbortSignal) => Promise<void>): ModelAction {
    const action: ModelAction = { modelId: entry.id, kind, status: 'running', bytesDone: 0, bytesTotal, startedAt: now().toISOString(), finishedAt: null, error: null, bad: [] };
    const controller = new AbortController();
    last.set(entry.id, action);
    emit(`model.${kind}.started`, { modelId: entry.id });
    // Held before the work starts: no second action can slip in, whatever the work does first.
    const held: { action: ModelAction; controller: AbortController; done: Promise<void> } = { action, controller, done: Promise.resolve() };
    running = held;
    held.done = (async () => {
      try {
        await Promise.resolve();
        await work(action, controller.signal);
        action.status = 'done';
      } catch (error) {
        action.status = controller.signal.aborted ? 'cancelled' : 'failed';
        action.error = controller.signal.aborted ? 'cancelled' : codeOf(error);
        if (!controller.signal.aborted && !(error instanceof ModelError)) onError(error);
      } finally {
        action.finishedAt = now().toISOString();
        if (running === held) running = undefined;
        const outcome = action.status === 'done' && kind === 'verify' && action.bad.length > 0 ? 'mismatch' : action.status === 'done' ? 'ok' : action.status;
        emit(`model.${kind}.finished`, {
          modelId: entry.id,
          outcome,
          ...(action.error === null ? {} : { error: action.error }),
          ...(kind === 'verify' ? { bad: action.bad.length } : {}),
        });
      }
    })();
    return { ...action };
  }

  function trash(): TrashView {
    const view: TrashView = { folder: `data/${MODELS_DIR}/${TRASH_DIR}`, entries: [], sizeBytes: 0 };
    if (!existsSync(trashDir) || !lstatSync(trashDir).isDirectory()) return view;
    for (const name of readdirSync(trashDir).sort()) {
      const sizeBytes = folderBytes(join(trashDir, name));
      view.entries.push({ name, sizeBytes });
      view.sizeBytes += sizeBytes;
    }
    return view;
  }

  return {
    download(modelId) {
      const entry = entryOf(modelId);
      idle();
      const statuses = modelStatusSync(options.dataDir, entry);
      // The files a verification found wrong are downloaded again, even with the right size.
      const wrong = new Set(last.get(entry.id)?.kind === 'verify' ? (last.get(entry.id)?.bad ?? []) : []);
      const needed = statuses.filter((status) => status.state !== 'present' || wrong.has(status.file.path));
      if (needed.length === 0) throw new ModelActionError('conflict', 'every file is already on the disk: verify them instead');
      const { missingBytes } = diskState(options.dataDir, entry);
      const replaced = needed.filter((status) => status.state === 'wrong-size' || status.state === 'present');
      // missingBytes already counts a file of the wrong size; a wrong sha256 of the right size is on top.
      const toFetch = missingBytes + replaced.filter((status) => status.state === 'present').reduce((total, status) => total + status.file.sizeBytes, 0);
      mkdirSync(modelsDir, { recursive: true });
      if (free(modelsDir) < toFetch) throw new ModelActionError('conflict', `not enough free space: ${String(toFetch)} bytes to download`);
      const total = needed.reduce((sum, status) => sum + status.file.sizeBytes, 0);
      return start(entry, 'download', total, async (action, signal) => {
        // A wrong file goes into the bin, never erased: the download writes a new one.
        if (replaced.length > 0) {
          ensureTrash();
          const bin = join(trashDir, binName(trashDir, now(), entry.id));
          for (const status of replaced) {
            const to = join(bin, status.file.path);
            mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
            renameSync(status.target, to);
          }
        }
        // Progress never goes back: the .part of the files still to do count from the start.
        const partOf = (status: FileStatus): number => (status.state === 'partial' ? Math.min(sizeOf(`${status.target}${PART_SUFFIX}`) ?? 0, status.file.sizeBytes) : 0);
        let finished = 0;
        let restParts = needed.reduce((sum, status) => sum + partOf(status), 0);
        action.bytesDone = restParts;
        for (const status of needed) {
          restParts -= partOf(status);
          await pullFile(
            { ...status, state: 'missing' },
            {
              fetch: options.fetch,
              signal,
              onProgress: (_status, bytes) => {
                action.bytesDone = finished + bytes + restParts;
              },
            },
          );
          finished += status.file.sizeBytes;
          action.bytesDone = finished;
        }
      });
    },

    verify(modelId) {
      const entry = entryOf(modelId);
      idle();
      const statuses = modelStatusSync(options.dataDir, entry);
      if (statuses.some((status) => status.state !== 'present')) throw new ModelActionError('conflict', 'some files are missing or partial: download them first');
      const total = entry.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      return start(entry, 'verify', total, async (action, signal) => {
        let finished = 0;
        for (const status of statuses) {
          let read = 0;
          const digest = await hashWithProgress(status.target, signal, (bytes) => {
            read += bytes;
            action.bytesDone = finished + read;
          });
          finished += status.file.sizeBytes;
          action.bytesDone = finished;
          if (digest !== status.file.sha256) action.bad.push(status.file.path);
        }
      });
    },

    cancel(modelId) {
      if (running === undefined || running.action.modelId !== modelId) throw new ModelActionError('conflict', 'nothing is running for this model');
      running.controller.abort();
      return { ...running.action };
    },

    async remove(modelId, confirm) {
      const entry = entryOf(modelId);
      if (confirm !== entry.id) throw new ModelActionError('invalid', 'removal needs the id of the model as confirmation');
      if (await options.trialOpen(entry.id)) throw new ModelActionError('conflict', 'a trial of the model is queued or running: cancel it first');
      // After the wait for the database: the checks below see the state of the moment of the rename.
      const roles = rolesOf(entry.id);
      if (roles.length > 0) throw new ModelActionError('conflict', `the model has the role ${roles.join(', ')}: give the role to another model first`);
      if (running?.action.modelId === entry.id) throw new ModelActionError('conflict', 'a download or verification of the model is running: stop it first');
      if (options.loaded(entry.id).length > 0) throw new ModelActionError('conflict', 'the model is loaded in memory: unload it first');
      const from = join(modelsDir, entry.id);
      try {
        lstatSync(from);
      } catch {
        throw new ModelActionError('not-found', 'the model has no files on the disk');
      }
      ensureTrash();
      const name = binName(trashDir, now(), entry.id);
      // A rename inside data/models: the same disk, instant, and a link moves as a link.
      renameSync(from, join(trashDir, name));
      last.delete(entry.id);
      emit('model.removed', { modelId: entry.id, outcome: 'ok' });
      return { modelId: entry.id, folder: `data/${MODELS_DIR}/${TRASH_DIR}/${name}` };
    },

    async unload(modelId) {
      const entry = entryOf(modelId);
      const places = options.loaded(entry.id);
      if (places.length === 0) throw new ModelActionError('conflict', 'the model is not loaded by Arianna');
      if (places.some((place) => place.busy)) throw new ModelActionError('conflict', 'a request is using the model now: try again when it ends');
      const outcome = await options.unload(entry.id);
      emit('model.unloaded', { modelId: entry.id, outcome });
      if (outcome === 'busy') throw new ModelActionError('conflict', 'a request or a call is using the model now: try again when it ends');
      return { modelId: entry.id, outcome };
    },

    trash,

    emptyTrash(confirm) {
      if (confirm !== true) throw new ModelActionError('invalid', 'emptying the bin needs the confirmation of the user');
      // A download may be moving a wrong file into the bin now.
      idle();
      const view = trash();
      for (const { name } of view.entries) rmSync(join(trashDir, name), { recursive: true, force: true });
      emit('model.trash.emptied', { outcome: 'ok', removed: view.entries.length });
      return { removed: view.entries.length, sizeBytes: view.sizeBytes };
    },

    list() {
      return [...last.values()].map((action) => ({ ...action, bad: [...action.bad] }));
    },

    disk: (entry) => diskState(options.dataDir, entry),

    async stop() {
      const current = running;
      if (current === undefined) return;
      current.controller.abort();
      await current.done;
    },
  };
}

/** The sizes of the files of one model, synchronously (the hash is the verification's job). */
function modelStatusSync(dataDir: string, entry: CatalogEntry): FileStatus[] {
  return entry.files.map((file) => {
    const target = join(dataDir, MODELS_DIR, entry.id, file.path);
    const size = sizeOf(target);
    const state: FileStatus['state'] = size === undefined ? (sizeOf(`${target}${PART_SUFFIX}`) === undefined ? 'missing' : 'partial') : size === file.sizeBytes ? 'present' : 'wrong-size';
    return { model: entry.id, file, target, state };
  });
}
