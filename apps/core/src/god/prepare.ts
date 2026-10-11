import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, DEFAULT_SETTINGS, loadCatalog, writeSettings } from '@arianna/config';

/**
 * Makes a new clone of GOD usable (D-127): the cloud executors work in a
 * sandbox with no network, so the clone gets what they cannot fetch, right
 * after `git clone` and before any agent touches it (its files are then the
 * installation's own commit):
 * - config/arianna.toml with the development defaults, written by this code
 *   (as `pnpm arianna:init --defaults`): without it some tests fail; no
 *   password is in it, so the clone stays a development copy;
 * - node_modules, from the local store of pnpm, offline, with the exact
 *   lockfile and no install scripts.
 * Best effort: a step that fails is reported, the clone stays as it is.
 */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export interface PrepareOptions {
  /** The installation, whose catalog of models the configuration is checked against. */
  home: string;
  /** `pnpm`; tests pass a fake one. */
  pnpm?: string;
  env?: NodeJS.ProcessEnv;
}

/** The environment of pnpm: the path and the user's home (its store), nothing of the core (database, vault, ARIANNA_HOME). */
export function pnpmEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { CI: '1' };
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']) {
    const value = from[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  return env;
}

export function prepareGodClone(options: PrepareOptions): (dir: string) => Promise<void> {
  return async (dir) => {
    if (!existsSync(join(dir, CONFIG_FILE))) writeSettings(dir, loadCatalog(options.home), DEFAULT_SETTINGS);
    await new Promise<void>((resolve, reject) => {
      execFile(
        options.pnpm ?? 'pnpm',
        ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--reporter=silent'],
        { cwd: dir, env: pnpmEnv(options.env ?? process.env), timeout: INSTALL_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, shell: false },
        (error) => {
          if (error === null) resolve();
          else reject(new Error(`pnpm install in the clone did not finish (${error.killed ? 'took too long' : `exit ${String(error.code ?? '?')}`})`));
        },
      );
    });
  };
}
