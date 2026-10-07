import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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

/**
 * The models the user added from Hugging Face on the "Modelli" page (I-10,
 * D-139): outside the repository history like arianna.toml, written by the
 * core only. Same format as the curated catalog; an entry may have no role
 * until the user promotes it, and every file comes from one commit of one
 * repository of huggingface.co.
 */
export const USER_CATALOG_FILE = join('config', 'models.user-catalog.yaml');

/** The only host of the user catalog: its pages and the files of a commit. */
export const HUB_URL = 'https://huggingface.co';

/** `owner/name` of a repository of huggingface.co. */
export const HUB_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;

/** A full commit id: the files of a user entry are pinned to one. */
export const HUB_REVISION = /^[0-9a-f]{40}$/;

export function isHubRepo(value: unknown): value is string {
  return typeof value === 'string' && HUB_REPO.test(value) && !value.includes('..');
}

/** The download address of one file of a commit, as the user catalog must write it. */
export function hubFileUrl(repo: string, revision: string, path: string): string {
  return `${HUB_URL}/${repo}/resolve/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Where a catalog entry comes from: the curated file, or Hugging Face through the "Modelli" page. */
export type CatalogOrigin = 'catalog' | 'huggingface';

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
   * by hand: who makes it, the context as the local server serves it, 1-4 short lines on
   * what it is good at, its license, a note, and the page of the model.
   * Never fetched at runtime.
   */
  provider?: string;
  contextTokens?: number;
  strengths?: string[];
  license?: string;
  notes?: string;
  source?: string;
  /** Set when loaded: `huggingface` for the entries of the user catalog (I-10); absent for the curated ones. */
  origin?: 'huggingface';
}

/** At most this many lines of strengths for a model (I-3: 1-4 short lines, never padded). */
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

function parseEntry(raw: unknown, where: string, user: boolean): CatalogEntry {
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
  // data/models/eliminati is the bin of the removed models (I-3, M4).
  if (id === 'eliminati') throw new ConfigError(`${where}.id: "eliminati" is the bin of data/models`);
  const roles = asArray(entry.roles, `${where}.roles`).map((role, index) =>
    asOneOf(role, MODEL_ROLES, `${where}.roles[${String(index)}]`),
  );
  // A model added from Hugging Face has no role until the user promotes it (I-10).
  if (roles.length === 0 && !user) throw new ConfigError(`${where}.roles: at least one role is required`);
  if (new Set(roles).size !== roles.length) throw new ConfigError(`${where}.roles: a role is listed twice`);
  const files = asArray(entry.files, `${where}.files`).map((file, index) =>
    parseFile(file, `${where}.files[${String(index)}]`),
  );
  if (files.length === 0) throw new ConfigError(`${where}.files: at least one file is required`);
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw new ConfigError(`${where}.files: a path is listed twice`);

  const parsed: CatalogEntry = {
    id,
    family: asString(entry.family, `${where}.family`),
    runtime: asOneOf(entry.runtime, MODEL_RUNTIMES, `${where}.runtime`),
    ramMinGib: asInteger(entry.ram_min_gib, `${where}.ram_min_gib`, 1, 4096),
    roles,
    status: asOneOf(entry.status, MODEL_STATUSES, `${where}.status`),
    files,
    ...describedBy(entry, where),
  };
  if (user) {
    checkHubEntry(parsed, where);
    parsed.origin = 'huggingface';
  }
  return parsed;
}

/**
 * An entry of the user catalog: its page is a repository of huggingface.co
 * and every file is that repository at one commit, at the address the core
 * writes. A hand edit that points a file anywhere else is refused.
 */
function checkHubEntry(entry: CatalogEntry, where: string): void {
  const repo = entry.source?.startsWith(`${HUB_URL}/`) === true ? entry.source.slice(HUB_URL.length + 1) : undefined;
  if (repo === undefined || !isHubRepo(repo)) throw new ConfigError(`${where}.source: must be the page of a repository of huggingface.co`);
  const revision = /\/resolve\/([0-9a-f]{40})\//.exec(entry.files[0]?.url ?? '')?.[1];
  if (revision === undefined) throw new ConfigError(`${where}.files: must come from one commit of ${repo}`);
  for (const [index, file] of entry.files.entries()) {
    if (file.url !== hubFileUrl(repo, revision, file.path)) {
      throw new ConfigError(`${where}.files[${String(index)}].url: must be ${repo} at commit ${revision}, on huggingface.co`);
    }
  }
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

/** With `user`, the rules of the user catalog (I-10): no role needed, files from huggingface.co only. */
export function parseCatalog(text: string, options: { user?: boolean } = {}): ModelCatalog {
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
    parseEntry(entry, `${options.user === true ? 'user catalog' : 'catalog'}.models[${String(index)}]`, options.user === true),
  );
  const ids = models.map((model) => model.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new ConfigError(`catalog.models: duplicate id ${duplicate}`);
  }
  return { version: 1, models };
}

/** Reads `config/models.catalog.yaml` from ARIANNA_HOME, without the user catalog. */
export function loadCuratedCatalog(home: string): ModelCatalog {
  return parseCatalog(readFileSync(join(home, CATALOG_FILE), 'utf8'));
}

/** Reads `config/models.user-catalog.yaml`; empty when the user never added a model. */
export function loadUserCatalog(home: string): ModelCatalog {
  const path = join(home, USER_CATALOG_FILE);
  if (!existsSync(path)) return { version: 1, models: [] };
  try {
    return parseCatalog(readFileSync(path, 'utf8'), { user: true });
  } catch (error) {
    // Every error names the user catalog, also those of the root and of the YAML.
    if (error instanceof ConfigError && !error.message.startsWith('user catalog')) throw new ConfigError(`user catalog: ${error.message}`);
    throw error;
  }
}

/**
 * The curated entries, then the user ones. An id in both is the curated one:
 * an update of the repository that adds a model the user had already added
 * never stops the core; the user entry stays in its file, unused.
 */
export function mergeCatalogs(curated: ModelCatalog, user: ModelCatalog): ModelCatalog {
  const ids = new Set(curated.models.map((model) => model.id));
  return { version: 1, models: [...curated.models, ...user.models.filter((model) => !ids.has(model.id))] };
}

/** Reads the catalog of ARIANNA_HOME: `config/models.catalog.yaml` and the models added from Hugging Face (I-10). */
export function loadCatalog(home: string): ModelCatalog {
  return mergeCatalogs(loadCuratedCatalog(home), loadUserCatalog(home));
}

const USER_CATALOG_HEADER = [
  '# Models added from Hugging Face on the "Modelli" page (I-10, D-139).',
  '# Written by the core: edit it only with the core stopped. Never committed.',
  '',
].join('\n');

/** The YAML of the user catalog, as the core writes it. */
export function renderUserCatalog(catalog: ModelCatalog): string {
  const models = catalog.models.map((model) => ({
    id: model.id,
    family: model.family,
    runtime: model.runtime,
    ram_min_gib: model.ramMinGib,
    roles: model.roles,
    status: model.status,
    ...(model.provider === undefined ? {} : { provider: model.provider }),
    ...(model.contextTokens === undefined ? {} : { context_tokens: model.contextTokens }),
    ...(model.strengths === undefined ? {} : { strengths: model.strengths }),
    ...(model.license === undefined ? {} : { license: model.license }),
    ...(model.notes === undefined ? {} : { notes: model.notes }),
    ...(model.source === undefined ? {} : { source: model.source }),
    files: model.files.map((file) => ({ path: file.path, url: file.url, size_bytes: file.sizeBytes, sha256: file.sha256 })),
  }));
  return `${USER_CATALOG_HEADER}${stringifyYaml({ version: 1, models }, { lineWidth: 0 })}`;
}

/** Writes the user catalog after checking it parses back under the same rules; atomic (a rename). */
export function writeUserCatalog(home: string, catalog: ModelCatalog): void {
  const text = renderUserCatalog(catalog);
  parseCatalog(text, { user: true });
  const path = join(home, USER_CATALOG_FILE);
  const temporary = join(dirname(path), `.models.user-catalog.yaml.${String(process.pid)}`);
  try {
    writeFileSync(temporary, text, { mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Total download size of a model. */
export function modelSize(entry: CatalogEntry): number {
  return entry.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}
