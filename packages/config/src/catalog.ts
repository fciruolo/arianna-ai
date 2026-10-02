import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  asArray,
  asInteger,
  asOneOf,
  asString,
  asTable,
  ConfigError,
  onlyKeys,
} from './validate.ts';

/**
 * The curated list of local models (task 1.18, docs/INSTALLER-PORTABILITY.md).
 * It replaces the manifest of task 1.17: what is downloaded is the catalog
 * entries assigned to a role in `[roles]` of arianna.toml.
 */
export const CATALOG_FILE = join('config', 'models.catalog.yaml');

export const MODEL_ROLES = ['orchestrator', 'extractor', 'embedder', 'voice'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const MODEL_RUNTIMES = ['mlx', 'llama.cpp', 'vllm'] as const;
export type ModelRuntime = (typeof MODEL_RUNTIMES)[number];

/** `verified` once the model has passed the router and extraction evals; `experimental` before. */
export const MODEL_STATUSES = ['verified', 'experimental'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** One downloadable file of a model; stored at `data/models/<model id>/<path>`. */
export interface ModelFile {
  path: string;
  url: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * The id is also the folder in `data/models` and therefore the name the local
 * server (oMLX, `--model-dir data/models`) gives the model. The same role can
 * have one entry per runtime (MLX on the Mac, llama.cpp or vLLM on Linux).
 */
export interface CatalogEntry {
  id: string;
  family: string;
  runtime: ModelRuntime;
  /** Memory the model needs once loaded, in GiB. */
  ramMinGib: number;
  roles: ModelRole[];
  status: ModelStatus;
  files: ModelFile[];
}

export interface ModelCatalog {
  version: 1;
  models: CatalogEntry[];
}

export const EMPTY_CATALOG: ModelCatalog = { version: 1, models: [] };

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

function parseFile(raw: unknown, where: string): ModelFile {
  const file = asTable(raw, where);
  onlyKeys(file, ['path', 'url', 'size_bytes', 'sha256'], where);

  const path = asString(file.path, `${where}.path`);
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new ConfigError(`${where}.path: must be relative and stay inside the model folder`);
  }
  const url = asString(file.url, `${where}.url`);
  if (!URL.canParse(url) || new URL(url).protocol !== 'https:') {
    throw new ConfigError(`${where}.url: must be an https URL`);
  }
  const sha256 = asString(file.sha256, `${where}.sha256`);
  if (!SHA256.test(sha256)) {
    throw new ConfigError(`${where}.sha256: expected 64 lowercase hex characters`);
  }
  return {
    path,
    url,
    sizeBytes: asInteger(file.size_bytes, `${where}.size_bytes`, 1, Number.MAX_SAFE_INTEGER),
    sha256,
  };
}

function parseEntry(raw: unknown, where: string): CatalogEntry {
  const entry = asTable(raw, where);
  onlyKeys(entry, ['id', 'family', 'runtime', 'ram_min_gib', 'roles', 'status', 'files'], where);

  const id = asString(entry.id, `${where}.id`);
  if (!NAME.test(id)) {
    throw new ConfigError(`${where}.id: use lowercase letters, digits, dot, dash, underscore`);
  }
  const roles = asArray(entry.roles, `${where}.roles`).map((role, index) =>
    asOneOf(role, MODEL_ROLES, `${where}.roles[${String(index)}]`),
  );
  if (roles.length === 0) throw new ConfigError(`${where}.roles: at least one role is required`);
  if (new Set(roles).size !== roles.length) throw new ConfigError(`${where}.roles: a role is listed twice`);
  const files = asArray(entry.files, `${where}.files`).map((file, index) =>
    parseFile(file, `${where}.files[${String(index)}]`),
  );
  if (files.length === 0) throw new ConfigError(`${where}.files: at least one file is required`);
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw new ConfigError(`${where}.files: a path is listed twice`);

  return {
    id,
    family: asString(entry.family, `${where}.family`),
    runtime: asOneOf(entry.runtime, MODEL_RUNTIMES, `${where}.runtime`),
    ramMinGib: asInteger(entry.ram_min_gib, `${where}.ram_min_gib`, 1, 4096),
    roles,
    status: asOneOf(entry.status, MODEL_STATUSES, `${where}.status`),
    files,
  };
}

export function parseCatalog(text: string): ModelCatalog {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`catalog: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = asTable(raw, 'catalog');
  onlyKeys(root, ['version', 'models'], 'catalog');
  if (root.version !== 1) throw new ConfigError('catalog.version: only version 1 is supported');

  const models = asArray(root.models, 'catalog.models').map((entry, index) =>
    parseEntry(entry, `catalog.models[${String(index)}]`),
  );
  const ids = models.map((model) => model.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new ConfigError(`catalog.models: duplicate id ${duplicate}`);
  }
  return { version: 1, models };
}

/** Reads `config/models.catalog.yaml` from ARIANNA_HOME. */
export function loadCatalog(home: string): ModelCatalog {
  return parseCatalog(readFileSync(join(home, CATALOG_FILE), 'utf8'));
}

/** Total download size of a model. */
export function modelSize(entry: CatalogEntry): number {
  return entry.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}
