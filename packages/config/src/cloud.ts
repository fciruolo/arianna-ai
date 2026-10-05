import { asArray, asOneOf, asTable, ConfigError, onlyKeys } from './validate.ts';

/** The official binaries a step may run on (CLAUDE.md: never modified, login manual). */
export const CLOUD_EXECUTORS = ['claude', 'codex'] as const;
export type CloudExecutor = (typeof CLOUD_EXECUTORS)[number];

/** The cloud model aliases of the router (docs/ROUTER-SPEC.md), each on its executor. */
export const CLOUD_MODELS = ['sonnet', 'opus', 'fable', 'codex'] as const;
export type CloudModel = (typeof CLOUD_MODELS)[number];

/**
 * An exact model name for `--model` (D-071): letters, digits, `.`, `-`, `_`,
 * `[` and `]` (`claude-opus-5-5[1m]`), starting with a letter or a digit so
 * that the binary never reads it as a flag. Same rule as MODEL_NAME in
 * @arianna/executors, which checks again when launching.
 */
export const CLOUD_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/;

/**
 * A Claude name stays in the family of its alias (`opus`, `claude-opus-5-5`,
 * `opus[1m]`): the router, its budget approval and the records see the alias,
 * so `sonnet = "claude-fable-5-1"` would run Fable without the approval.
 * Same rule as claudeArgs in @arianna/executors.
 */
function inFamily(model: CloudModel, name: string): boolean {
  return model === 'codex' || new RegExp(`^(claude-)?${model}(?![A-Za-z0-9])`).test(name);
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
  return { sonnet: { enabled: true }, opus: { enabled: true }, fable: { enabled: true }, codex: { enabled: true } };
}

/** The aliases turned on, in the order of CLOUD_MODELS. */
export function enabledCloudModels(cloud: Pick<CloudConfig, 'models'>): CloudModel[] {
  return CLOUD_MODELS.filter((model) => cloud.models[model].enabled);
}

/** What `--model` gets for an alias: the exact name when the user gave one. */
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
  const table = asTable(value, 'cloud.models');
  onlyKeys(table, [...CLOUD_MODELS, 'default'], 'cloud.models');
  for (const model of CLOUD_MODELS) {
    const given = table[model];
    const where = `cloud.models.${model}`;
    if (given === undefined || given === true) continue;
    if (given === false) models[model] = { enabled: false };
    else if (typeof given === 'string' && CLOUD_MODEL_NAME.test(given)) {
      if (!inFamily(model, given)) throw new ConfigError(`${where}: the name must be of the ${model} family, e.g. claude-${model}-<version>`);
      models[model] = { enabled: true, name: given };
    } else throw new ConfigError(`${where}: expected true, false or a model name (letters, digits, . - _ [ ], starting with a letter or a digit)`);
  }
  return models;
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
