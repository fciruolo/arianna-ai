import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { resolveHome, resolveInHome } from './home.ts';
import { asInteger, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

export const CONFIG_FILE = join('config', 'arianna.toml');

const DATA_DIR = 'data';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export interface AriannaConfig {
  /** Absolute path of ARIANNA_HOME. */
  home: string;
  /** Absolute paths, always inside `home`. */
  paths: { data: string };
  database: { host: string; port: number; name: string; user: string };
}

export function parseConfig(text: string, home: string): AriannaConfig {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new ConfigError(`arianna.toml: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = asTable(raw, 'arianna.toml');
  onlyKeys(root, ['paths', 'database'], 'arianna.toml');

  const paths = asTable(root.paths, 'paths');
  onlyKeys(paths, ['data'], 'paths');

  const database = asTable(root.database, 'database');
  onlyKeys(database, ['host', 'port', 'name', 'user'], 'database');

  const data = resolveInHome(home, asString(paths.data, 'paths.data'), 'paths.data');
  // .gitignore, lint and tests exclude exactly this folder: any other name would
  // let private data into git. The installer (task 1.17) will lift the limit.
  if (data !== join(home, DATA_DIR)) {
    throw new ConfigError(`paths.data: must be "${DATA_DIR}" for now`);
  }

  // The driver connects without TLS, so the database must be on this machine.
  const host = asString(database.host, 'database.host');
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new ConfigError(`database.host: must be one of ${LOOPBACK_HOSTS.join(', ')}`);
  }

  return {
    home,
    paths: { data },
    database: {
      host,
      port: asInteger(database.port, 'database.port', 1, 65535),
      name: asString(database.name, 'database.name'),
      user: asString(database.user, 'database.user'),
    },
  };
}

/** Reads `config/arianna.toml` from ARIANNA_HOME. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AriannaConfig {
  const home = resolveHome(env);
  return parseConfig(readFileSync(join(home, CONFIG_FILE), 'utf8'), home);
}
