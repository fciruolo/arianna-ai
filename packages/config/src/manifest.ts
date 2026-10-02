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

export const MANIFEST_FILE = join('config', 'models.manifest.yaml');

export const MODEL_ROLES = ['orchestrator', 'extractor', 'embedder', 'voice'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const MODEL_RUNTIMES = ['mlx', 'llama.cpp', 'vllm'] as const;
export type ModelRuntime = (typeof MODEL_RUNTIMES)[number];

/** One downloadable file of a model; stored at `data/models/<model name>/<path>`. */
export interface ModelFile {
  path: string;
  url: string;
  sizeBytes: number;
  sha256: string;
}

/** The same role can have one entry per runtime (MLX on the Mac, llama.cpp or vLLM on Linux). */
export interface ModelEntry {
  name: string;
  role: ModelRole;
  runtime: ModelRuntime;
  files: ModelFile[];
}

export interface ModelManifest {
  version: 1;
  models: ModelEntry[];
}

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
  if (!url.startsWith('https://')) throw new ConfigError(`${where}.url: must be an https URL`);
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

function parseEntry(raw: unknown, where: string): ModelEntry {
  const entry = asTable(raw, where);
  onlyKeys(entry, ['name', 'role', 'runtime', 'files'], where);

  const name = asString(entry.name, `${where}.name`);
  if (!NAME.test(name)) {
    throw new ConfigError(`${where}.name: use lowercase letters, digits, dot, dash, underscore`);
  }
  const files = asArray(entry.files, `${where}.files`).map((file, index) =>
    parseFile(file, `${where}.files[${String(index)}]`),
  );
  if (files.length === 0) throw new ConfigError(`${where}.files: at least one file is required`);

  return {
    name,
    role: asOneOf(entry.role, MODEL_ROLES, `${where}.role`),
    runtime: asOneOf(entry.runtime, MODEL_RUNTIMES, `${where}.runtime`),
    files,
  };
}

export function parseManifest(text: string): ModelManifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = asTable(raw, 'manifest');
  onlyKeys(root, ['version', 'models'], 'manifest');
  if (root.version !== 1) throw new ConfigError('manifest.version: only version 1 is supported');

  const models = asArray(root.models, 'manifest.models').map((entry, index) =>
    parseEntry(entry, `manifest.models[${String(index)}]`),
  );
  const names = models.map((model) => model.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new ConfigError(`manifest.models: duplicate name ${duplicate}`);
  }
  return { version: 1, models };
}

/** Reads `config/models.manifest.yaml` from ARIANNA_HOME. */
export function loadManifest(home: string): ModelManifest {
  return parseManifest(readFileSync(join(home, MANIFEST_FILE), 'utf8'));
}
