import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { resolveHome, resolveInHome } from './home.ts';
import { asInteger, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

export const CONFIG_FILE = join('config', 'arianna.toml');

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

  return {
    home,
    paths: { data: resolveInHome(home, asString(paths.data, 'paths.data'), 'paths.data') },
    database: {
      host: asString(database.host, 'database.host'),
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
