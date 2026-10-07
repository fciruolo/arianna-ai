import { asArray, asOneOf, asTable, ConfigError, onlyKeys } from './validate.ts';

/** The official binaries a step may run on (CLAUDE.md: never modified, login manual). */
export const CLOUD_EXECUTORS = ['claude', 'codex'] as const;
export type CloudExecutor = (typeof CLOUD_EXECUTORS)[number];

/** The cloud model aliases of the router (docs/ROUTER-SPEC.md), each on its executor: Claude's, then Codex's (D-141). */
export const CLOUD_MODELS = ['sonnet', 'opus', 'fable', 'luna', 'sol', 'astra'] as const;
export type CloudModel = (typeof CLOUD_MODELS)[number];

/** The aliases of Codex's models (D-141); the others run on claude. */
export const CODEX_ALIASES: readonly CloudModel[] = ['luna', 'sol', 'astra'];

/** The executor of a cloud alias. */
export function executorOfCloudModel(model: CloudModel): CloudExecutor {
  return CODEX_ALIASES.includes(model) ? 'codex' : 'claude';
}

/**
 * The single alias `codex` from before D-141 (the binary's default model):
 * read as `sol`, the model of the tier it stood on, in `[cloud.models]`,
 * `[agents.<id>] model` and the old `default`.
 */
export const LEGACY_CODEX_ALIAS = 'codex';
export const LEGACY_CODEX_AS: CloudModel = 'sol';

/**
 * An exact model name for `--model` (D-071): letters, digits, `.`, `-`, `_`,
 * `[` and `]` (`claude-opus-5-5[1m]`), starting with a letter or a digit so
 * that the binary never reads it as a flag. Same rule as MODEL_NAME in
 * @arianna/executors, which checks again when launching.
 */
export const CLOUD_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/;

/**
 * A name stays in the family of its alias: for Claude `opus`,
 * `claude-opus-5-5`, `opus[1m]`; for Codex `gpt-6.1-sol` (D-141). The
 * router, its budget approval and the records see the alias, so `sonnet =
 * "claude-fable-5-1"` would run Fable without the approval. Same rules as
 * claudeArgs and codexArgs in @arianna/executors.
 */
export function inFamily(model: CloudModel, name: string): boolean {
  if (CODEX_ALIASES.includes(model)) return new RegExp(`^gpt-[0-9][0-9.]*-${model}$`).test(name);
  return new RegExp(`^(claude-)?${model}(?![A-Za-z0-9])`).test(name);
}

/** One alias of `[cloud.models]`. */
export interface CloudModelSetting {
  /** Off: out of the router's candidates and of the conversation selector. */
  enabled: boolean;
  /** Passed to `--model` instead of the alias; absent, the alias (the newest model for the binary). */
  name?: string;
}

/** Cloud executors (docs/PRIVACY-POLICY-SPEC.md, "Confinamento"). */
export interface CloudConfig {
  /**
   * Cloud executors the user enabled (task 1.18). None by default. Changing it
   * is a privacy setting: only the user edits it.
   */
  executors: CloudExecutor[];
  /**
   * `[cloud.models]` (D-071): which model of an enabled executor runs. Not a
   * privacy setting: it never turns an executor on.
   */
  models: Record<CloudModel, CloudModelSetting>;
}

/** Every alias on, under its own name: the models before `[cloud.models]`. */
export function defaultCloudModels(): Record<CloudModel, CloudModelSetting> {
  return { sonnet: { enabled: true }, opus: { enabled: true }, fable: { enabled: true }, luna: { enabled: true }, sol: { enabled: true }, astra: { enabled: true } };
}

/** The aliases turned on, in the order of CLOUD_MODELS. */
export function enabledCloudModels(cloud: Pick<CloudConfig, 'models'>): CloudModel[] {
  return CLOUD_MODELS.filter((model) => cloud.models[model].enabled);
}

/** What `--model` gets for an alias: the exact name when the user gave one (a Codex alias needs one from the cloud catalog otherwise, D-141). */
export function cloudModelName(cloud: Pick<CloudConfig, 'models'>, model: CloudModel): string {
  return cloud.models[model].name ?? model;
}

/**
 * `[cloud.models]`: per alias `true` (on), `false` (off) or the exact name to
 * pass to `--model` (on); a missing alias is on. `default` is from before
 * D-116: see legacyDefaultModel.
 */
function parseModels(value: unknown): CloudConfig['models'] {
  const models = defaultCloudModels();
  if (value === undefined) return models;
  const raw = asTable(value, 'cloud.models');
  onlyKeys(raw, [...CLOUD_MODELS, LEGACY_CODEX_ALIAS, 'default'], 'cloud.models');
  const table = readLegacyCodex(raw);
  for (const model of CLOUD_MODELS) {
    const given = table[model];
    const where = `cloud.models.${model}`;
    if (given === undefined || given === true) continue;
    if (given === false) models[model] = { enabled: false };
    else if (typeof given === 'string' && CLOUD_MODEL_NAME.test(given)) {
      if (!inFamily(model, given)) {
        const example = CODEX_ALIASES.includes(model) ? `gpt-<version>-${model}` : `claude-${model}-<version>`;
        throw new ConfigError(`${where}: the name must be of the ${model} family, e.g. ${example}`);
      }
      models[model] = { enabled: true, name: given };
    } else throw new ConfigError(`${where}: expected true, false or a model name (letters, digits, . - _ [ ], starting with a letter or a digit)`);
  }
  return models;
}

/**
 * The single `codex` of `[cloud.models]` from before D-141, written into the
 * three aliases: `true` changes nothing, `false` turns the three off (Codex's
 * model was off: none of them may start running), an exact name goes to the
 * alias of its family. Never next to the new keys. Returns the table without it.
 */
function readLegacyCodex(raw: Record<string, unknown>): Record<string, unknown> {
  const table = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== LEGACY_CODEX_ALIAS));
  const old = raw[LEGACY_CODEX_ALIAS];
  if (old === undefined) return table;
  const where = `cloud.models.${LEGACY_CODEX_ALIAS}`;
  if (CODEX_ALIASES.some((alias) => table[alias] !== undefined)) {
    throw new ConfigError(`${where}: the old single model of Codex (D-141): keep only ${CODEX_ALIASES.join(', ')}`);
  }
  if (old === true) return table;
  if (old === false) {
    for (const alias of CODEX_ALIASES) table[alias] = false;
    return table;
  }
  const family = typeof old === 'string' ? CODEX_ALIASES.find((alias) => inFamily(alias, old)) : undefined;
  if (family === undefined) throw new ConfigError(`${where}: Codex has three models since D-141: write the name under luna, sol or astra`);
  table[family] = old;
  return table;
}

/**
 * `default` of `[cloud.models]`, the model of a new work conversation before
 * D-116: now the Coder's model in `[agents.coder]`, which the page writes in
 * its place. Read here, after parseCloud checked the table.
 */
export function legacyDefaultModel(value: unknown): CloudModel | undefined {
  if (value === undefined) return undefined;
  const models = asTable(value, 'cloud').models;
  if (models === undefined) return undefined;
  const given = asTable(models, 'cloud.models').default;
  if (given === LEGACY_CODEX_ALIAS) return LEGACY_CODEX_AS;
  return given === undefined ? undefined : asOneOf(given, CLOUD_MODELS, 'cloud.models.default');
}

/**
 * `[cloud]`. The folders the executors may work on are the `[[project]]`
 * sections (D-058); an `allowlist` from before is refused with the way out,
 * never converted: the label of each folder was in labels.toml, and only the
 * user says which label a project has.
 */
export function parseCloud(value: unknown): CloudConfig {
  if (value === undefined) return { executors: [], models: defaultCloudModels() };
  const cloud = asTable(value, 'cloud');
  onlyKeys(cloud, ['allowlist', 'executors', 'models'], 'cloud');
  if (cloud.allowlist !== undefined && asArray(cloud.allowlist, 'cloud.allowlist').length > 0) {
    throw new ConfigError('cloud.allowlist: replaced by [[project]] sections (D-058): run pnpm arianna:init --reconfigure, or write them by hand');
  }
  const executors = asArray(cloud.executors ?? [], 'cloud.executors').map((item, index) =>
    asOneOf(item, CLOUD_EXECUTORS, `cloud.executors[${String(index)}]`),
  );
  if (new Set(executors).size !== executors.length) throw new ConfigError('cloud.executors: an executor is listed twice');
  return { executors, models: parseModels(cloud.models) };
}
