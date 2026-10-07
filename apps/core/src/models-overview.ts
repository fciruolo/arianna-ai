import {
  aliasesOf,
  CLOUD_MODEL_EXECUTOR,
  CLOUD_MODELS,
  loadCatalog,
  loadCloudCatalog,
  modelSize,
  ORCHESTRATOR_AGENT,
  type AriannaConfig,
  type CatalogEntry,
  type CatalogOrigin,
  type CloudCatalog,
  type CloudCatalogEntry,
  type CloudExecutor,
  type CloudModel,
  type CloudSource,
  type ModelCatalog,
  type ModelRole,
  type ModelRuntime,
  type ModelStatus,
} from '@arianna/config';
import { needsBudgetApproval, usesOf, type ModelUse } from '@arianna/router';

import type { Queryable } from './db/client.ts';
import type { DiskState, ModelAction, ModelActions, TrashView } from './model-actions.ts';
import { weightsDigest, type EvalStatus } from './model-evals.ts';
import type { MemorySnapshot } from './model-memory.ts';
import { present } from './settings-page.ts';

/**
 * One list of every model, local and cloud, for the "Modelli" page (I-3,
 * stage M2): the catalog cards, what is on disk and in the memory of the
 * local servers, the roles, the agents, the last trial, the switches and the
 * steps the router gives each one. Everything here is L0: catalog ids,
 * numbers, outcomes of trials on fake cases. Read only: no action, no network.
 */

/** The last trial of a local model (D-081), whatever its state. */
export interface LastEval {
  id: string;
  modelId: string;
  role: string;
  status: EvalStatus;
  passed: number | null;
  total: number | null;
  latencyMedianMs: number | null;
  requestedAt: Date;
  finishedAt: Date | null;
  weightsSha256: string | null;
}

/** Loaded: some local server holds it by the core's own account; on-disk: every file there; missing: to download. */
export type LocalState = 'loaded' | 'on-disk' | 'missing';

export interface LocalModelView {
  locality: 'local';
  id: string;
  family: string;
  runtime: ModelRuntime;
  ramMinGib: number;
  status: ModelStatus;
  /** Sum of the files of the catalog. */
  sizeBytes: number;
  provider: string | null;
  contextTokens: number | null;
  strengths: string[];
  license: string | null;
  notes: string | null;
  source: string | null;
  /** The roles the catalog says it suits. */
  suitedRoles: ModelRole[];
  /** Where the entry comes from: the curated catalog, or Hugging Face through this page (I-10); no suited role until the user promotes it. */
  origin: CatalogOrigin;
  /** The roles `[roles]` gives it now. */
  roles: ModelRole[];
  /** The aliases it serves through its roles (`local-large`, `local-small`, `local-voice`). */
  aliases: string[];
  /** The agents that run on it: Arianna on the orchestrator (D-116). */
  agents: string[];
  /** The steps the router gives its aliases. */
  uses: ModelUse[];
  /** Every file in data/models/<id> with its size (sha256 not checked here). */
  present: boolean;
  state: LocalState;
  /** A folder data/models/<id> exists, complete or not: something to remove. */
  hasFiles: boolean;
  /** Bytes still to download (a partial download counts for what it holds). */
  missingBytes: number;
  /** The download or verification in progress, or the last one since the core started (I-3, M4). */
  action: ModelAction | null;
  /** Where it is loaded, by the core's account (D-107, stage E). */
  loaded: { endpoint: string; gib: number | null; busy: boolean }[];
  /** The last trial, and whether it ran on the weights the catalog lists now. */
  lastEval: (Omit<LastEval, 'modelId' | 'weightsSha256'> & { sameWeights: boolean }) | null;
}

/**
 * on: a candidate of the router; off: turned off in `[cloud.models]`;
 * executor-off: its binary is not in `[cloud] executors`; not-connected: the
 * core has no adapter for it (Codex until task 1.16, Claude when the adapter
 * refused this Node installation). The first that holds wins, in the order
 * not-connected, executor-off, off: Codex reads "not connected" even when
 * the user left it out of `[cloud] executors`, the bigger reason.
 */
export type CloudState = 'on' | 'off' | 'executor-off' | 'not-connected';

export interface CloudModelView {
  locality: 'cloud';
  alias: CloudModel;
  executor: CloudExecutor;
  /** The hand-written card of config/cloud-models.catalog.yaml; null when the file has none (or cannot be read). */
  card: CloudCatalogEntry | null;
  /** The switch of `[cloud.models]`. */
  enabled: boolean;
  /** The exact name for `--model`; null, the alias (the newest model for the binary). */
  name: string | null;
  executorEnabled: boolean;
  adapter: boolean;
  state: CloudState;
  /** A step on it waits for the user's approval of the budget (the router's rule). */
  budgetApproval: boolean;
  /** The agents that start on it (`[agents.<id>] model`, D-116). */
  agents: string[];
  uses: ModelUse[];
}

export interface ModelsOverview {
  local: LocalModelView[];
  cloud: CloudModelView[];
  /** The sources the cloud cards name, by id. */
  sources: CloudSource[];
  /** The memory of the local models (D-107, stage E); null when the core does not keep the account. */
  memory: Omit<MemorySnapshot, 'loaded'> | null;
  /** The bin of the removed models (I-3, M4); null when the core has no actions. */
  trash: TrashView | null;
  /** Why a catalog or the trials could not be read: the file and the place, never what it holds. */
  errors: { catalog: string | null; cloudCatalog: string | null; evals: string | null };
}

export interface OverviewInputs {
  catalog: ModelCatalog;
  cloudCatalog: CloudCatalog;
  config: Pick<AriannaConfig, 'roles' | 'cloud' | 'agents'>;
  /** Whether every file of a model is on disk. */
  present: (entry: CatalogEntry) => boolean;
  memory: MemorySnapshot | undefined;
  lastEvals: readonly LastEval[];
  /** Whether the core has an adapter for the executor now. */
  adapters: Readonly<Record<CloudExecutor, boolean>>;
  /** What is on the disk; without it, from `present` alone. */
  disk?: (entry: CatalogEntry) => DiskState;
  actions?: readonly ModelAction[];
  trash?: TrashView | null;
  errors?: Partial<ModelsOverview['errors']>;
}

/** The steps of several aliases, each kind once at its best tier. */
function usesOfAliases(aliases: readonly string[]): ModelUse[] {
  const best = new Map<string, ModelUse>();
  for (const use of aliases.flatMap((alias) => usesOf(alias))) {
    const known = best.get(use.kind);
    // A ladder of its own beats being the fallback of another; a lower tier beats a higher one.
    if (known === undefined || (known.fallback === true && use.fallback !== true) || (known.fallback === use.fallback && use.tier < known.tier)) best.set(use.kind, use);
  }
  return [...best.values()];
}

function localView(entry: CatalogEntry, inputs: OverviewInputs): LocalModelView {
  const { roles } = inputs.config;
  const assigned = (Object.keys(roles) as ModelRole[]).filter((role) => roles[role] === entry.id);
  const aliases = Object.entries(aliasesOf(roles))
    .filter(([, id]) => id === entry.id)
    .map(([alias]) => alias);
  const loaded = (inputs.memory?.loaded ?? []).filter(({ model }) => model === entry.id).map(({ endpoint, gib, busy }) => ({ endpoint, gib, busy }));
  const isPresent = inputs.present(entry);
  const disk = inputs.disk?.(entry) ?? { hasFiles: isPresent, missingBytes: isPresent ? 0 : modelSize(entry) };
  const action = inputs.actions?.find(({ modelId }) => modelId === entry.id);
  const last = inputs.lastEvals.find(({ modelId }) => modelId === entry.id);
  return {
    locality: 'local',
    id: entry.id,
    family: entry.family,
    runtime: entry.runtime,
    ramMinGib: entry.ramMinGib,
    status: entry.status,
    sizeBytes: modelSize(entry),
    provider: entry.provider ?? null,
    contextTokens: entry.contextTokens ?? null,
    strengths: entry.strengths ?? [],
    license: entry.license ?? null,
    notes: entry.notes ?? null,
    source: entry.source ?? null,
    suitedRoles: entry.roles,
    origin: entry.origin ?? 'catalog',
    roles: assigned,
    aliases,
    agents: assigned.includes('orchestrator') ? [ORCHESTRATOR_AGENT] : [],
    uses: usesOfAliases(aliases),
    present: isPresent,
    state: loaded.length > 0 ? 'loaded' : isPresent ? 'on-disk' : 'missing',
    hasFiles: disk.hasFiles,
    missingBytes: disk.missingBytes,
    action: action === undefined ? null : { ...action, bad: [...action.bad] },
    loaded,
    lastEval:
      last === undefined
        ? null
        : {
            id: last.id,
            role: last.role,
            status: last.status,
            passed: last.passed,
            total: last.total,
            latencyMedianMs: last.latencyMedianMs,
            requestedAt: last.requestedAt,
            finishedAt: last.finishedAt,
            sameWeights: last.weightsSha256 === weightsDigest(entry),
          },
  };
}

function cloudView(alias: CloudModel, inputs: OverviewInputs): CloudModelView {
  const { cloud, agents } = inputs.config;
  const executor = CLOUD_MODEL_EXECUTOR[alias];
  const setting = cloud.models[alias];
  const executorEnabled = cloud.executors.includes(executor);
  const adapter = inputs.adapters[executor];
  const state: CloudState = !adapter ? 'not-connected' : !executorEnabled ? 'executor-off' : !setting.enabled ? 'off' : 'on';
  return {
    locality: 'cloud',
    alias,
    executor,
    card: inputs.cloudCatalog.models.find((entry) => entry.alias === alias) ?? null,
    enabled: setting.enabled,
    name: setting.name ?? null,
    executorEnabled,
    adapter,
    state,
    budgetApproval: needsBudgetApproval(alias),
    agents: Object.entries(agents)
      .filter(([, settings]) => settings.model === alias)
      .map(([agent]) => agent)
      .sort(),
    uses: usesOf(alias),
  };
}

/** The list from what the core holds now; pure, so the page and the tests see the same rules. */
export function buildModelsOverview(inputs: OverviewInputs): ModelsOverview {
  const snapshot = inputs.memory;
  // What each model holds is on its own row; here the totals.
  const memory: ModelsOverview['memory'] =
    snapshot === undefined ? null : { memoryGib: snapshot.memoryGib, budgets: snapshot.budgets, estimatedGib: snapshot.estimatedGib, swap: snapshot.swap };
  return {
    local: inputs.catalog.models.map((entry) => localView(entry, inputs)),
    cloud: CLOUD_MODELS.map((alias) => cloudView(alias, inputs)),
    sources: inputs.cloudCatalog.sources,
    memory,
    trash: inputs.trash ?? null,
    errors: { catalog: inputs.errors?.catalog ?? null, cloudCatalog: inputs.errors?.cloudCatalog ?? null, evals: inputs.errors?.evals ?? null },
  };
}

/** The newest trial of each model by request, one row per model (D-081). */
export async function lastEvals(sql: Queryable): Promise<LastEval[]> {
  const rows = await sql.unsafe<LastEval[]>(
    `SELECT DISTINCT ON (model_id) id::text, model_id AS "modelId", role, status, passed, total,
       latency_median_ms AS "latencyMedianMs", requested_at AS "requestedAt", finished_at AS "finishedAt",
       weights_sha256 AS "weightsSha256"
     FROM model_evals ORDER BY model_id, requested_at DESC, id DESC`,
  );
  return [...rows];
}

export interface ModelsOverviewOptions {
  home: string;
  dataDir: string;
  /** The running configuration, read at each request. */
  config: () => Pick<AriannaConfig, 'roles' | 'cloud' | 'agents'>;
  memory?: () => MemorySnapshot;
  adapters: () => Readonly<Record<CloudExecutor, boolean>>;
  /** The actions on the local models (I-3, M4): their progress, the bin, what is on the disk. */
  actions?: Pick<ModelActions, 'list' | 'trash' | 'disk'>;
}

/**
 * Only where the file is wrong, never what it holds: a ConfigError may carry
 * a key, an id or the lines a YAML error quotes, so only its place (the part
 * before the first colon) is kept. Anything else is "cannot be read".
 */
function readError(error: unknown, file: string): string {
  if (!(error instanceof Error) || error.name !== 'ConfigError') return `${file} cannot be read`;
  const place = error.message.split(':')[0] ?? '';
  return /^[\w .[\]-]{1,120}$/.test(place) ? `${file} is not valid at ${place}` : `${file} is not valid`;
}

/**
 * Both catalogs are read again at each request, like the settings page: a
 * new entry needs no restart. A catalog that cannot be read leaves its side
 * of the list empty (or without cards) and says why.
 */
export async function loadModelsOverview(sql: Queryable, options: ModelsOverviewOptions): Promise<ModelsOverview> {
  const errors: ModelsOverview['errors'] = { catalog: null, cloudCatalog: null, evals: null };
  let catalog: ModelCatalog = { version: 1, models: [] };
  try {
    catalog = loadCatalog(options.home);
  } catch (error) {
    // The models added from Hugging Face (I-10) have their own file: the error names it.
    const user = error instanceof Error && error.message.startsWith('user catalog');
    errors.catalog = readError(error, user ? 'config/models.user-catalog.yaml' : 'config/models.catalog.yaml');
  }
  let cloudCatalog: CloudCatalog = { version: 1, sources: [], models: [] };
  try {
    cloudCatalog = loadCloudCatalog(options.home);
  } catch (error) {
    errors.cloudCatalog = readError(error, 'config/cloud-models.catalog.yaml');
  }
  // The database down costs the trials, not the page.
  let trials: LastEval[] = [];
  try {
    trials = await lastEvals(sql);
  } catch {
    errors.evals = 'the trials cannot be read';
  }
  return buildModelsOverview({
    catalog,
    cloudCatalog,
    config: options.config(),
    present: (entry) => present(options.dataDir, entry.id, entry.files),
    memory: options.memory?.(),
    lastEvals: trials,
    adapters: options.adapters(),
    ...(options.actions === undefined ? {} : { disk: options.actions.disk, actions: options.actions.list(), trash: trashOf(options.actions) }),
    errors,
  });
}

/** A bin that cannot be read costs the bin, not the page. */
function trashOf(actions: Pick<ModelActions, 'trash'>): TrashView | null {
  try {
    return actions.trash();
  } catch {
    return null;
  }
}
