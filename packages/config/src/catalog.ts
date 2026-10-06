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

// `voice` writes the replies of a call; `stt` and `tts` hear and speak (D-066).
export const MODEL_ROLES = ['orchestrator', 'extractor', 'embedder', 'voice', 'stt', 'tts'] as const;
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
  /**
   * What the "Modelli" page shows of the model (I-3), all optional and written
   * by hand: who makes it, the context it was trained for, 1-4 short lines on
   * what it is good at, its license, a note, and the page of the model.
   * Never fetched at runtime.
   */
  provider?: string;
  contextTokens?: number;
  strengths?: string[];
  license?: string;
  notes?: string;
  source?: string;
}

/** At most this many lines of strengths for a model (I-3: 2-4 short lines). */
export const MAX_STRENGTHS = 4;

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
  const url = asHttpsUrl(file.url, `${where}.url`);
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
  onlyKeys(
    entry,
    ['id', 'family', 'runtime', 'ram_min_gib', 'roles', 'status', 'files', 'provider', 'context_tokens', 'strengths', 'license', 'notes', 'source'],
    where,
  );

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
    ...describedBy(entry, where),
  };
}

/** The optional fields of the card (I-3); absent ones stay absent. */
function describedBy(entry: Record<string, unknown>, where: string): Pick<CatalogEntry, 'provider' | 'contextTokens' | 'strengths' | 'license' | 'notes' | 'source'> {
  const card: Pick<CatalogEntry, 'provider' | 'contextTokens' | 'strengths' | 'license' | 'notes' | 'source'> = {};
  if (entry.provider !== undefined) card.provider = asString(entry.provider, `${where}.provider`);
  if (entry.context_tokens !== undefined) card.contextTokens = asInteger(entry.context_tokens, `${where}.context_tokens`, 1, 100_000_000);
  if (entry.strengths !== undefined) card.strengths = asStrengths(entry.strengths, `${where}.strengths`);
  if (entry.license !== undefined) card.license = asString(entry.license, `${where}.license`);
  if (entry.notes !== undefined) card.notes = asString(entry.notes, `${where}.notes`);
  if (entry.source !== undefined) card.source = asHttpsUrl(entry.source, `${where}.source`);
  return card;
}

/** 1-4 short lines, each on one line. */
export function asStrengths(value: unknown, where: string): string[] {
  const lines = asArray(value, where).map((line, index) => asString(line, `${where}[${String(index)}]`));
  if (lines.length === 0 || lines.length > MAX_STRENGTHS) throw new ConfigError(`${where}: expected 1-${String(MAX_STRENGTHS)} lines`);
  if (lines.some((line) => line.includes('\n') || line.length > 200)) throw new ConfigError(`${where}: one line each, at most 200 characters`);
  return lines;
}

export function asHttpsUrl(value: unknown, where: string): string {
  const url = asString(value, where);
  if (!URL.canParse(url) || new URL(url).protocol !== 'https:') throw new ConfigError(`${where}: must be an https URL`);
  return url;
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
