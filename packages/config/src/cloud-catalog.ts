import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { asHttpsUrl, asStrengths } from './catalog.ts';
import { CLOUD_MODEL_NAME, CLOUD_MODELS, inFamily, type CloudExecutor, type CloudModel } from './cloud.ts';
import { asArray, asInteger, asOneOf, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

/**
 * The cards of the cloud models (I-3): a file in git written by hand, one
 * entry per alias of the router, every fact with the page it comes from and
 * the day it was read. Never fetched at runtime: a value nobody could check
 * is left out, not guessed.
 */
export const CLOUD_CATALOG_FILE = join('config', 'cloud-models.catalog.yaml');

/** The binary each alias runs on: the same split as the router's (docs/ROUTER-SPEC.md). */
export const CLOUD_MODEL_EXECUTOR: Readonly<Record<CloudModel, CloudExecutor>> = {
  sonnet: 'claude',
  opus: 'claude',
  fable: 'claude',
  luna: 'codex',
  sol: 'codex',
  astra: 'codex',
};

/** Where a fact comes from: a page and the day it was read (YYYY-MM-DD). */
export interface CloudSource {
  id: string;
  url: string;
  read: string;
}

/** One exact name the binary accepts with `--model`, with what its source says of it. */
export interface CloudModelName {
  name: string;
  source: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  /** The provider's own short description, translated. */
  description?: string;
}

/** A line of strengths, with its source. */
export interface CloudStrength {
  text: string;
  source: string;
}

/**
 * The provider's price for the API, in dollars per million tokens. Not what a
 * subscription costs: it says only how heavy a model is next to another.
 */
export interface ApiPrice {
  input: number;
  output: number;
  source: string;
}

/**
 * How much faster than another alias this one uses the subscription quota,
 * as the provider writes it (I-3: "Opus about N times Sonnet").
 */
export interface QuotaRatio {
  relativeTo: CloudModel;
  times: number;
  source: string;
}

export interface CloudCatalogEntry {
  alias: CloudModel;
  provider: string;
  family: string;
  executor: CloudExecutor;
  names: CloudModelName[];
  strengths: CloudStrength[];
  apiPrice?: ApiPrice;
  quotaRatio?: QuotaRatio;
  /** The provider's terms, a page. */
  terms?: string;
  notes?: string;
}

export interface CloudCatalog {
  version: 1;
  sources: CloudSource[];
  models: CloudCatalogEntry[];
}

export const EMPTY_CLOUD_CATALOG: CloudCatalog = { version: 1, sources: [], models: [] };

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function asDay(value: unknown, where: string): string {
  const day = asString(value, where);
  const match = DAY.exec(day);
  const date = match === null ? undefined : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date === undefined || date.toISOString().slice(0, 10) !== day) throw new ConfigError(`${where}: expected a day as YYYY-MM-DD`);
  return day;
}

function asPositive(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new ConfigError(`${where}: expected a positive number`);
  }
  return value;
}

function parseSource(raw: unknown, where: string): CloudSource {
  const source = asTable(raw, where);
  onlyKeys(source, ['id', 'url', 'read'], where);
  const id = asString(source.id, `${where}.id`);
  if (!SOURCE_ID.test(id)) throw new ConfigError(`${where}.id: use lowercase letters, digits and dashes`);
  return { id, url: asHttpsUrl(source.url, `${where}.url`), read: asDay(source.read, `${where}.read`) };
}

function parseEntry(raw: unknown, where: string, sourceOf: (value: unknown, where: string) => string): CloudCatalogEntry {
  const entry = asTable(raw, where);
  onlyKeys(entry, ['alias', 'provider', 'family', 'executor', 'names', 'strengths', 'api_price', 'quota_ratio', 'terms', 'notes'], where);
  const alias = asOneOf(entry.alias, CLOUD_MODELS, `${where}.alias`);
  const executor = asOneOf(entry.executor, ['claude', 'codex'] as const, `${where}.executor`);
  if (executor !== CLOUD_MODEL_EXECUTOR[alias]) throw new ConfigError(`${where}.executor: ${alias} runs on ${CLOUD_MODEL_EXECUTOR[alias]}`);

  const names = asArray(entry.names ?? [], `${where}.names`).map((item, index) => {
    const at = `${where}.names[${String(index)}]`;
    const table = asTable(item, at);
    onlyKeys(table, ['name', 'source', 'context_tokens', 'max_output_tokens', 'description'], at);
    const name = asString(table.name, `${at}.name`);
    if (!CLOUD_MODEL_NAME.test(name)) throw new ConfigError(`${at}.name: letters, digits, . - _ [ ], starting with a letter or a digit`);
    // The same rule as [cloud.models]: a name the page offers must be one the user may write there.
    if (!inFamily(alias, name)) throw new ConfigError(`${at}.name: not of the ${alias} family`);
    const found: CloudModelName = { name, source: sourceOf(table.source, `${at}.source`) };
    if (table.context_tokens !== undefined) found.contextTokens = asInteger(table.context_tokens, `${at}.context_tokens`, 1, 100_000_000);
    if (table.max_output_tokens !== undefined) found.maxOutputTokens = asInteger(table.max_output_tokens, `${at}.max_output_tokens`, 1, 100_000_000);
    if (table.description !== undefined) found.description = asString(table.description, `${at}.description`);
    return found;
  });
  if (new Set(names.map(({ name }) => name)).size !== names.length) throw new ConfigError(`${where}.names: a name is listed twice`);

  const strengths: CloudStrength[] = asArray(entry.strengths ?? [], `${where}.strengths`).map((item, index) => {
    const at = `${where}.strengths[${String(index)}]`;
    const table = asTable(item, at);
    onlyKeys(table, ['text', 'source'], at);
    return { text: asString(table.text, `${at}.text`), source: sourceOf(table.source, `${at}.source`) };
  });
  // Same limits as the local catalog: 1-4 short lines.
  if (entry.strengths !== undefined) asStrengths(strengths.map(({ text }) => text), `${where}.strengths`);

  const found: CloudCatalogEntry = {
    alias,
    provider: asString(entry.provider, `${where}.provider`),
    family: asString(entry.family, `${where}.family`),
    executor,
    names,
    strengths,
  };
  if (entry.api_price !== undefined) {
    const at = `${where}.api_price`;
    const price = asTable(entry.api_price, at);
    onlyKeys(price, ['input', 'output', 'source'], at);
    found.apiPrice = { input: asPositive(price.input, `${at}.input`), output: asPositive(price.output, `${at}.output`), source: sourceOf(price.source, `${at}.source`) };
  }
  if (entry.quota_ratio !== undefined) {
    const at = `${where}.quota_ratio`;
    const ratio = asTable(entry.quota_ratio, at);
    onlyKeys(ratio, ['relative_to', 'times', 'source'], at);
    const relativeTo = asOneOf(ratio.relative_to, CLOUD_MODELS, `${at}.relative_to`);
    if (relativeTo === alias) throw new ConfigError(`${at}.relative_to: another alias than ${alias}`);
    found.quotaRatio = { relativeTo, times: asPositive(ratio.times, `${at}.times`), source: sourceOf(ratio.source, `${at}.source`) };
  }
  if (entry.terms !== undefined) found.terms = asHttpsUrl(entry.terms, `${where}.terms`);
  if (entry.notes !== undefined) found.notes = asString(entry.notes, `${where}.notes`);
  return found;
}

export function parseCloudCatalog(text: string): CloudCatalog {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`cloud catalog: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = asTable(raw, 'cloud catalog');
  onlyKeys(root, ['version', 'sources', 'models'], 'cloud catalog');
  if (root.version !== 1) throw new ConfigError('cloud catalog.version: only version 1 is supported');

  const sources = asArray(root.sources, 'cloud catalog.sources').map((source, index) => parseSource(source, `cloud catalog.sources[${String(index)}]`));
  const ids = new Set(sources.map(({ id }) => id));
  if (ids.size !== sources.length) throw new ConfigError('cloud catalog.sources: an id is listed twice');
  const used = new Set<string>();
  // Every fact names a source of the list: a fact without one is not written.
  const sourceOf = (value: unknown, where: string): string => {
    const id = asString(value, where);
    if (!ids.has(id)) throw new ConfigError(`${where}: ${id} is not in sources`);
    used.add(id);
    return id;
  };

  const models = asArray(root.models, 'cloud catalog.models').map((entry, index) => parseEntry(entry, `cloud catalog.models[${String(index)}]`, sourceOf));
  const aliases = models.map(({ alias }) => alias);
  const duplicate = aliases.find((alias, index) => aliases.indexOf(alias) !== index);
  if (duplicate !== undefined) throw new ConfigError(`cloud catalog.models: ${duplicate} is listed twice`);
  const unused = sources.find(({ id }) => !used.has(id));
  if (unused !== undefined) throw new ConfigError(`cloud catalog.sources: ${unused.id} is not used by any fact`);
  return { version: 1, sources, models };
}

/**
 * The exact name a Codex alias runs when `[cloud.models]` gives none (D-141):
 * the first of its card. The binary knows no alias, and its own default
 * would run under any of them. Undefined when the card names none.
 */
export function catalogModelName(catalog: CloudCatalog, alias: CloudModel): string | undefined {
  return catalog.models.find((entry) => entry.alias === alias)?.names[0]?.name;
}

/** Reads `config/cloud-models.catalog.yaml` from ARIANNA_HOME. */
export function loadCloudCatalog(home: string): CloudCatalog {
  return parseCloudCatalog(readFileSync(join(home, CLOUD_CATALOG_FILE), 'utf8'));
}
