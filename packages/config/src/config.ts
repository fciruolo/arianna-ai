import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml, TomlError } from 'smol-toml';

import { parseAgents, type AgentsSettings } from './agents.ts';
import { EMPTY_CATALOG, loadCatalog, type ModelCatalog } from './catalog.ts';
import { parseCharacters, type CharacterChoices } from './characters.ts';
import { legacyDefaultModel, parseCloud, type CloudConfig } from './cloud.ts';
import { resolveHome, resolveInHome } from './home.ts';
import { parseLocal, type LocalConfig } from './local.ts';
import { parseNotifications, type NotificationsConfig } from './notifications.ts';
import { parsePersonas, type Personas } from './personas.ts';
import { parseProjects, type Project } from './projects.ts';
import { parseRoles, type Roles } from './roles.ts';
import { parseParticipants, type ParticipantsConfig } from './participants.ts';
import { parseSprites, type SpritesConfig } from './sprites.ts';
import { parseTelegram, type TelegramConfig } from './telegram.ts';
import { asInteger, asString, asTable, asVaultRef, ConfigError, onlyKeys } from './validate.ts';
import { parseVoice, type VoiceConfig } from './voice.ts';

/**
 * The configuration of this installation, written by `pnpm arianna:init` and
 * kept out of git (task 1.18): the repository carries only the example.
 */
export const CONFIG_FILE = join('config', 'arianna.toml');
export const EXAMPLE_CONFIG_FILE = join('config', 'arianna.example.toml');

export const DATA_DIR = 'data';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
// The API serves L2 history in clear and without authentication: this machine
// only, until the VPN proxy and authentication (task 1.13). Addresses, not
// "localhost", which depends on /etc/hosts.
const SERVER_HOSTS = ['127.0.0.1', '::1'];
export const DEFAULT_SERVER = { host: '127.0.0.1', port: 7420 };
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
  /** Role → id in config/models.catalog.yaml (task 1.18). */
  roles: Roles;
  local: LocalConfig;
  cloud: CloudConfig;
  /** The folders a cloud executor may work on (D-058); applied without a restart. */
  projects: Project[];
  /** Agent → "<pack>/<character>" (D-060); applied without a restart. */
  characters: CharacterChoices;
  /** Agent → persona (D-107); an agent without one has the defaults. Applied without a restart. */
  personas: Personas;
  /** Agent → its default model (D-116); applied without a restart. */
  agents: AgentsSettings;
  /** The model that draws a character (D-123); applied without a restart. */
  sprites: SpritesConfig;
  /** `[participants]` (I-8, D-130): when an agent leaves a conversation by itself. */
  participants: ParticipantsConfig;
  /** `[notifications]` (I-1): kinds and quiet hours; absent, the defaults. Applied without a restart. */
  notifications: NotificationsConfig;
  /** Absent when `[telegram]` is not configured: the channel is off. */
  telegram?: TelegramConfig;
  /** Absent when `[voice]` is not configured: no apps/voice, no calls (D-066). */
  voice?: VoiceConfig;
  /**
   * `[installation]` (D-089): `mode = "development"` marks this installation as
   * development even with real passwords; absent, the passwords decide.
   */
  installation?: { mode: InstallationMode };
}

export const INSTALLATION_MODES = ['development', 'production'] as const;
export type InstallationMode = (typeof INSTALLATION_MODES)[number];

/**
 * `catalog` checks `[roles]`: without it no role can be assigned. `userHome`
 * is where the `~/` of a project path points.
 */
export function parseConfig(text: string, home: string, catalog: ModelCatalog = EMPTY_CATALOG, userHome: string = homedir()): AriannaConfig {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    // Only where: the message of smol-toml quotes the lines around the error, values included.
    if (error instanceof TomlError) throw new ConfigError(`arianna.toml: invalid TOML at line ${String(error.line)}, column ${String(error.column)}`);
    throw new ConfigError('arianna.toml: invalid TOML');
  }
  const root = asTable(raw, 'arianna.toml');
  onlyKeys(root, ['paths', 'database', 'server', 'roles', 'local', 'cloud', 'project', 'characters', 'personas', 'agents', 'sprites', 'participants', 'notifications', 'telegram', 'voice', 'installation'], 'arianna.toml');

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
  const voice = parseVoice(root.voice);
  if (voice !== undefined && voice.port === parseServer(root.server).port) throw new ConfigError('voice.port: must differ from server.port');
  const roles = parseRoles(root.roles, catalog);
  const installation = parseInstallation(root.installation);
  const cloud = parseCloud(root.cloud);
  return {
    home,
    paths: { data },
    database: parseDatabase(database, host),
    server: parseServer(root.server),
    roles,
    local: parseLocal(root.local, roles),
    cloud,
    projects: parseProjects(root.project, home, userHome, data),
    characters: parseCharacters(root.characters),
    personas: parsePersonas(root.personas),
    agents: parseAgents(root.agents, legacyDefaultModel(root.cloud)),
    sprites: parseSprites(root.sprites),
    participants: parseParticipants(root.participants),
    notifications: parseNotifications(root.notifications),
    ...(telegram === undefined ? {} : { telegram }),
    ...(voice === undefined ? {} : { voice }),
    ...(installation === undefined ? {} : { installation }),
  };
}

function parseInstallation(value: unknown): AriannaConfig['installation'] {
  if (value === undefined) return undefined;
  const table = asTable(value, 'installation');
  onlyKeys(table, ['mode'], 'installation');
  if (table.mode === undefined) return undefined;
  const mode = asString(table.mode, 'installation.mode');
  const known = INSTALLATION_MODES.find((item) => item === mode);
  if (known === undefined) throw new ConfigError(`installation.mode: must be one of ${INSTALLATION_MODES.join(', ')}`);
  return { mode: known };
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

/** The user's home, where `~/` of a project points: HOME, or the account's when it is unset. */
export function userHomeOf(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.HOME;
  return fromEnv === undefined || fromEnv === '' ? homedir() : fromEnv;
}

/** Reads `config/arianna.toml` from ARIANNA_HOME, with the catalog its roles refer to. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AriannaConfig {
  const home = resolveHome(env);
  const path = join(home, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new ConfigError(`${CONFIG_FILE} is missing: run pnpm arianna:init (pnpm arianna:init --defaults for development)`);
  }
  return parseConfig(readFileSync(path, 'utf8'), home, loadCatalog(home), userHomeOf(env));
}
