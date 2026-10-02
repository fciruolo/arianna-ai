import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { parseCloud, type CloudConfig } from './cloud.ts';
import { resolveHome, resolveInHome } from './home.ts';
import { parseLocal, type LocalConfig } from './local.ts';
import { parseTelegram, type TelegramConfig } from './telegram.ts';
import { asInteger, asString, asTable, asVaultRef, ConfigError, onlyKeys } from './validate.ts';

export const CONFIG_FILE = join('config', 'arianna.toml');

const DATA_DIR = 'data';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
// The API serves L2 history in clear and without authentication: this machine
// only, until the VPN proxy and authentication (task 1.13). Addresses, not
// "localhost", which depends on /etc/hosts.
const SERVER_HOSTS = ['127.0.0.1', '::1'];
const DEFAULT_SERVER = { host: '127.0.0.1', port: 7420 };
// The role the core works as (task 1.13, D-046), created by migration 0007:
// fixed, because migrations are in git and cannot read this file.
const APP_ROLE = 'arianna_app';

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  /** Owner of the schema: migrations and setup only. */
  user: string;
  /**
   * `vault://name` of the owner's password and of the password of the
   * application role. Absent: the development defaults, for fake data only;
   * `pnpm arianna:doctor` fails until both are set.
   */
  password?: string;
  appPassword?: string;
}

export interface AriannaConfig {
  /** Absolute path of ARIANNA_HOME. */
  home: string;
  /** Absolute paths, always inside `home`. */
  paths: { data: string };
  database: DatabaseConfig;
  /** API, WebSocket and web chat of the core (task 1.11). */
  server: { host: string; port: number };
  local: LocalConfig;
  cloud: CloudConfig;
  /** Absent when `[telegram]` is not configured: the channel is off. */
  telegram?: TelegramConfig;
}

export function parseConfig(text: string, home: string): AriannaConfig {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new ConfigError(`arianna.toml: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = asTable(raw, 'arianna.toml');
  onlyKeys(root, ['paths', 'database', 'server', 'local', 'cloud', 'telegram'], 'arianna.toml');

  const paths = asTable(root.paths, 'paths');
  onlyKeys(paths, ['data'], 'paths');

  const database = asTable(root.database, 'database');
  onlyKeys(database, ['host', 'port', 'name', 'user', 'password', 'app_password'], 'database');

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

  const telegram = parseTelegram(root.telegram);
  return {
    home,
    paths: { data },
    database: parseDatabase(database, host),
    server: parseServer(root.server),
    local: parseLocal(root.local),
    cloud: parseCloud(root.cloud, home, data),
    ...(telegram === undefined ? {} : { telegram }),
  };
}

function parseDatabase(database: Record<string, unknown>, host: string): DatabaseConfig {
  const user = asString(database.user, 'database.user');
  if (user === APP_ROLE) throw new ConfigError(`database.user: ${APP_ROLE} is the application role, not the owner`);
  const password = database.password === undefined ? undefined : asVaultRef(database.password, 'database.password');
  const appPassword =
    database.app_password === undefined ? undefined : asVaultRef(database.app_password, 'database.app_password');
  if ((password === undefined) !== (appPassword === undefined)) {
    throw new ConfigError('database: set password and app_password together, or neither');
  }
  if (password !== undefined && password === appPassword) {
    throw new ConfigError('database.app_password: must be a different secret from database.password');
  }
  return {
    host,
    port: asInteger(database.port, 'database.port', 1, 65535),
    name: asString(database.name, 'database.name'),
    user,
    ...(password === undefined ? {} : { password }),
    ...(appPassword === undefined ? {} : { appPassword }),
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
