// Reading and writing config/arianna.toml for the wizard (task 1.18); the
// writing itself is in @arianna/config, shared with the settings page.
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import {
  CLOUD_EXECUTORS,
  CONFIG_FILE,
  readSettings,
  userHomeOf,
  writeSettings,
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

/** Written as the settings page writes it (D-071). */
export { writeSettings };

/**
 * Whether each official binary is on PATH. Looked up, not run: the cloud
 * executors are started only from @arianna/executors.
 */
export function installedExecutors(env: NodeJS.ProcessEnv = process.env): Record<CloudExecutor, boolean> {
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '');
  const found = (binary: string): boolean => dirs.some((dir) => existsSync(join(dir, binary)));
  return Object.fromEntries(CLOUD_EXECUTORS.map((executor) => [executor, found(executor)])) as Record<CloudExecutor, boolean>;
}
