// Writing config/arianna.toml (task 1.18): validated exactly as loadConfig reads
// it, then written beside it and renamed, so the running core, which checks
// the file every second, never reads half of it.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import {
  CLOUD_EXECUTORS,
  CONFIG_FILE,
  parseConfig,
  readSettings,
  renderSettings,
  userHomeOf,
  type CloudExecutor,
  type ModelCatalog,
  type Settings,
} from '@arianna/config';

export function configPath(home: string): string {
  return join(home, CONFIG_FILE);
}

/** The settings in the file, or `undefined` when there is no file yet. */
export function currentSettings(home: string, catalog: ModelCatalog): Settings | undefined {
  const path = configPath(home);
  return existsSync(path) ? readSettings(readFileSync(path, 'utf8'), home, catalog, userHomeOf()) : undefined;
}

export function writeSettings(home: string, catalog: ModelCatalog, settings: Settings): void {
  const text = renderSettings(settings);
  // The same home the wizard and the links use (HOME), not the account's when they differ.
  parseConfig(text, home, catalog, userHomeOf());
  const path = configPath(home);
  const temporary = join(dirname(path), `.arianna.toml.${String(process.pid)}`);
  try {
    writeFileSync(temporary, text, { mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Whether each official binary is on PATH. Looked up, not run: the cloud
 * executors are started only from @arianna/executors.
 */
export function installedExecutors(env: NodeJS.ProcessEnv = process.env): Record<CloudExecutor, boolean> {
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '');
  const found = (binary: string): boolean => dirs.some((dir) => existsSync(join(dir, binary)));
  return Object.fromEntries(CLOUD_EXECUTORS.map((executor) => [executor, found(executor)])) as Record<CloudExecutor, boolean>;
}
