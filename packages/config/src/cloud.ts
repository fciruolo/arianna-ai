import { isAbsolute, relative, sep } from 'node:path';

import { resolveInHome } from './home.ts';
import { asArray, asOneOf, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

/** The official binaries a step may run on (CLAUDE.md: never modified, login manual). */
export const CLOUD_EXECUTORS = ['claude', 'codex'] as const;
export type CloudExecutor = (typeof CLOUD_EXECUTORS)[number];

/** Cloud executors (docs/PRIVACY-POLICY-SPEC.md, "Confinamento"). */
export interface CloudConfig {
  /**
   * Repositories a cloud executor may work on, relative to ARIANNA_HOME with
   * `/` separators. Changing it is a privacy setting: only the user edits it.
   */
  allowlist: string[];
  /**
   * Cloud executors the user enabled (task 1.18). None by default. Changing it
   * is a privacy setting: only the user edits it.
   */
  executors: CloudExecutor[];
}

/** True when `inner` is `outer` or inside it; a folder named `..x` is inside. */
function within(inner: string, outer: string): boolean {
  const fromOuter = relative(outer, inner);
  return fromOuter === '' || (fromOuter !== '..' && !fromOuter.startsWith(`..${sep}`) && !isAbsolute(fromOuter));
}

/** NFC and lowercase: on a case-insensitive disk `repos/A` and `repos/a` are one folder. */
function fold(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * Each entry: inside ARIANNA_HOME, not ARIANNA_HOME itself (it holds `data/`),
 * not inside or around `data/`, no duplicates and no entry inside another, also
 * when they differ only in case. Whether the folder is a real folder and not a
 * symbolic link is checked when a workspace is prepared.
 */
export function parseCloud(value: unknown, home: string, data: string): CloudConfig {
  if (value === undefined) return { allowlist: [], executors: [] };
  const cloud = asTable(value, 'cloud');
  onlyKeys(cloud, ['allowlist', 'executors'], 'cloud');
  const executors = asArray(cloud.executors ?? [], 'cloud.executors').map((item, index) =>
    asOneOf(item, CLOUD_EXECUTORS, `cloud.executors[${String(index)}]`),
  );
  if (new Set(executors).size !== executors.length) throw new ConfigError('cloud.executors: an executor is listed twice');
  const allowlist = asArray(cloud.allowlist ?? [], 'cloud.allowlist').map((item, index) => {
    const where = `cloud.allowlist[${String(index)}]`;
    const absolute = resolveInHome(home, asString(item, where), where);
    const fromHome = relative(home, absolute);
    if (fromHome === '') throw new ConfigError(`${where}: ARIANNA_HOME itself cannot be allowlisted, it contains data/`);
    if (within(absolute, data) || within(data, absolute)) {
      throw new ConfigError(`${where}: must not contain or be inside data/`);
    }
    return fromHome.split(sep).join('/');
  });
  const folded = allowlist.map(fold);
  for (const [index, entry] of folded.entries()) {
    for (const other of folded.slice(index + 1)) {
      if (entry === other) throw new ConfigError(`cloud.allowlist: ${entry} is listed twice`);
      if (other.startsWith(`${entry}/`) || entry.startsWith(`${other}/`)) {
        throw new ConfigError(`cloud.allowlist: ${entry} and ${other} are nested`);
      }
    }
  }
  return { allowlist, executors };
}
