import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { parseCloud, type CloudConfig } from './cloud.ts';
import { resolveHome, resolveInHome } from './home.ts';
import { parseLocal, type LocalConfig } from './local.ts';
import { asInteger, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

export const CONFIG_FILE = join('config', 'arianna.toml');

const DATA_DIR = 'data';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
// The API serves L2 history in clear and without authentication: this machine
// only, until the VPN proxy and authentication (task 1.13). Addresses, not
// "localhost", which depends on /etc/hosts.
const SERVER_HOSTS = ['127.0.0.1', '::1'];
const DEFAULT_SERVER = { host: '127.0.0.1', port: 7420 };

export interface AriannaConfig {
  /** Absolute path of ARIANNA_HOME. */
  home: string;
  /** Absolute paths, always inside `home`. */
  paths: { data: string };
  database: { host: string; port: number; name: string; user: string };
  /** API, WebSocket and web chat of the core (task 1.11). */
  server: { host: string; port: number };
  local: LocalConfig;
  cloud: CloudConfig;
}

export function parseConfig(text: string, home: string): AriannaConfig {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new ConfigError(`arianna.toml: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = asTable(raw, 'arianna.toml');
  onlyKeys(root, ['paths', 'database', 'server', 'local', 'cloud'], 'arianna.toml');

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
    server: parseServer(root.server),
    local: parseLocal(root.local),
    cloud: parseCloud(root.cloud, home, data),
  };
}

function parseServer(value: unknown): AriannaConfig['server'] {
  if (value === undefined) return { ...DEFAULT_SERVER };
  const server = asTable(value, 'server');
  onlyKeys(server, ['host', 'port'], 'server');
  const host = server.host === undefined ? DEFAULT_SERVER.host : asString(server.host, 'server.host');
  if (!SERVER_HOSTS.includes(host)) throw new ConfigError(`server.host: must be one of ${SERVER_HOSTS.join(', ')}`);
  const port = server.port === undefined ? DEFAULT_SERVER.port : asInteger(server.port, 'server.port', 1, 65535);
  return { host, port };
}

/** Reads `config/arianna.toml` from ARIANNA_HOME. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AriannaConfig {
  const home = resolveHome(env);
  return parseConfig(readFileSync(join(home, CONFIG_FILE), 'utf8'), home);
}
