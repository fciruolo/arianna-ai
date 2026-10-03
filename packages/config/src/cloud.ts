import { asArray, asOneOf, asTable, ConfigError, onlyKeys } from './validate.ts';

/** The official binaries a step may run on (CLAUDE.md: never modified, login manual). */
export const CLOUD_EXECUTORS = ['claude', 'codex'] as const;
export type CloudExecutor = (typeof CLOUD_EXECUTORS)[number];

/** Cloud executors (docs/PRIVACY-POLICY-SPEC.md, "Confinamento"). */
export interface CloudConfig {
  /**
   * Cloud executors the user enabled (task 1.18). None by default. Changing it
   * is a privacy setting: only the user edits it.
   */
  executors: CloudExecutor[];
}

/**
 * `[cloud]`. The folders the executors may work on are the `[[project]]`
 * sections (D-058); an `allowlist` from before is refused with the way out,
 * never converted: the label of each folder was in labels.toml, and only the
 * user says which label a project has.
 */
export function parseCloud(value: unknown): CloudConfig {
  if (value === undefined) return { executors: [] };
  const cloud = asTable(value, 'cloud');
  onlyKeys(cloud, ['allowlist', 'executors'], 'cloud');
  if (cloud.allowlist !== undefined && asArray(cloud.allowlist, 'cloud.allowlist').length > 0) {
    throw new ConfigError('cloud.allowlist: replaced by [[project]] sections (D-058): run pnpm arianna:init --reconfigure, or write them by hand');
  }
  const executors = asArray(cloud.executors ?? [], 'cloud.executors').map((item, index) =>
    asOneOf(item, CLOUD_EXECUTORS, `cloud.executors[${String(index)}]`),
  );
  if (new Set(executors).size !== executors.length) throw new ConfigError('cloud.executors: an executor is listed twice');
  return { executors };
}
