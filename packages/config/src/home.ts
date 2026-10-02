import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ConfigError } from './validate.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/**
 * The single folder that holds code, config and data (docs/INSTALLER-PORTABILITY.md).
 * Defaults to the repository this code runs from; ARIANNA_HOME overrides it.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.ARIANNA_HOME;
  return fromEnv === undefined || fromEnv === '' ? REPO_ROOT : resolve(fromEnv);
}

/** Resolves a configured path inside ARIANNA_HOME. Absolute paths and escapes are rejected. */
export function resolveInHome(home: string, path: string, where: string): string {
  if (isAbsolute(path)) {
    throw new ConfigError(`${where}: absolute paths are not allowed, use a path relative to ARIANNA_HOME`);
  }
  const absolute = resolve(home, path);
  const fromHome = relative(home, absolute);
  if (fromHome === '..' || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    throw new ConfigError(`${where}: path escapes ARIANNA_HOME`);
  }
  return absolute;
}
