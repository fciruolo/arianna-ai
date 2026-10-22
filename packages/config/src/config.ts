import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml, TomlError } from 'smol-toml';

import { parseAgents, type AgentsSettings } from './agents.ts';
import { EMPTY_CATALOG, loadCatalog, type ModelCatalog } from './catalog.ts';
import { parseCapture, type CaptureConfig } from './capture.ts';
import { parseWeb, type WebConfig } from './web.ts';
import { parseCharacters, type CharacterChoices } from './characters.ts';
import { legacyDefaultModel, parseCloud, type CloudConfig } from './cloud.ts';
import { resolveHome, resolveInHome } from './home.ts';
import { parseLocal, type LocalConfig } from './local.ts';
import { parseNotifications, type NotificationsConfig } from './notifications.ts';
import { parsePersonas, type Personas } from './personas.ts';
import { parseSeries, type SeriesOverrides } from './series.ts';
import { parseProjectRules, type ProjectRules } from './project-rules.ts';
import { configErrorText } from './project-messages.ts';
import { parseProjects, type Project } from './projects.ts';
import { parseRoles, type Roles } from './roles.ts';
import { parseParticipants, type ParticipantsConfig } from './participants.ts';
import { parseSecretary, type SecretaryConfig } from './secretary.ts';
import { parseAppearance, type AppearanceConfig } from './appearance.ts';
import { parseSprites, type SpritesConfig } from './sprites.ts';
import { parseTelegram, type TelegramConfig } from './telegram.ts';
import { asInteger, asString, asTable, asVaultRef, ConfigError, onlyKeys } from './validate.ts';
import { parsePush, parseVoice, type PushConfig, type VoiceConfig } from './voice.ts';

/**
 * The configuration of this installation, written by `pnpm arianna:init` and
 * kept out of git (task 1.18): the repository carries only the example.
 */
export const CONFIG_FILE = join('config', 'arianna.toml');
export const EXAMPLE_CONFIG_FILE = join('config', 'arianna.example.toml');

export const DATA_DIR = 'data';

/**
 * The certificate of the remote port in mode `own` (D-292), under data/:
 * the leaf and its key (0600, folder 0700), the public root for the phone,
 * and the temporary files of `pnpm remote:cert`. The root's key never stays.
 */
export interface RemotePaths {
  dir: string;
  tmp: string;
  root: string;
  cert: string;
  key: string;
}

export function remotePaths(data: string): RemotePaths {
  const dir = join(data, 'remote');
  return { dir, tmp: join(dir, 'tmp'), root: join(dir, 'arianna-root.crt'), cert: join(dir, 'server.crt'), key: join(dir, 'server.key') };
}
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
// The API serves L2 history in clear and without authentication: this machine
// only, until the VPN proxy and authentication (task 1.13). Addresses, not
// "localhost", which depends on /etc/hosts.
const SERVER_HOSTS = ['127.0.0.1', '::1'];
export const DEFAULT_SERVER = { host: '127.0.0.1', port: 7420 };
/**
 * `[server.remote]` (D-292): the port that `tailscale serve` publishes on the
 * tailnet as https://<host>. It listens on 127.0.0.1 only, like `[server]`.
 */
export const DEFAULT_REMOTE_PORT = 7443;
/**
 * Who ends TLS on the remote port (D-292). `own`: the core, with the
 * certificate of `pnpm remote:cert` in data/remote/, and Tailscale forwards
 * TCP without opening it; no certificate of this name in the public
 * Certificate Transparency logs. `tailscale`: Tailscale ends HTTPS with its
 * own certificate and talks HTTP to the core.
 */
export const REMOTE_TLS_MODES = ['own', 'tailscale'] as const;
export type RemoteTlsMode = (typeof REMOTE_TLS_MODES)[number];
export const DEFAULT_REMOTE_TLS: RemoteTlsMode = 'own';
// The MagicDNS name of this Mac on the tailnet: lowercase DNS labels, ending in .ts.net.
const TAILNET_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;

export interface RemoteServerConfig {
  /** The `*.ts.net` name the phone opens: the only Host and Origin the remote port accepts. */
  host: string;
  /** Loopback port behind `tailscale serve`; never the port of `[server]`. */
  port: number;
  tls: RemoteTlsMode;
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Absent: no remote port, the chat is reachable from this Mac only. */
  remote?: RemoteServerConfig;
}
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
  /** API, WebSocket and web chat of the core (task 1.11); `remote` the port behind Tailscale (D-292). */
  server: ServerConfig;
  /** Role → id in config/models.catalog.yaml (task 1.18). */
  roles: Roles;
  local: LocalConfig;
  cloud: CloudConfig;
  /** The folders a cloud executor may work on (D-058); applied without a restart. */
  projects: Project[];
  /** `[project_rules]` (I-14, D-174): the rules a delegation on a project reads; applied without a restart. */
  projectRules: ProjectRules;
  /** Agent → "<pack>/<character>" (D-060); applied without a restart. */
  characters: CharacterChoices;
  /** Agent → persona (D-107); an agent without one has the defaults. Applied without a restart. */
  personas: Personas;
  /** `[series.<id>]` (D-223): what the user rewrote of the people of the series. */
  series: SeriesOverrides;
  /** Agent → its default model (D-116); applied without a restart. */
  agents: AgentsSettings;
  /** The model that draws a character (D-123); applied without a restart. */
  sprites: SpritesConfig;
  /** `[participants]` (I-8, D-130): when an agent leaves a conversation by itself. */
  participants: ParticipantsConfig;
  /** `[notifications]` (I-1): kinds and quiet hours; absent, the defaults. Applied without a restart. */
  notifications: NotificationsConfig;
  /** `[secretary]` (I-12, D-144): reminders on or off, the three moments and the days; absent, the defaults. Applied without a restart. */
  secretary: SecretaryConfig;
  /** `[appearance]` (D-103): the theme of the web chat on every device; absent, Base. Applied without a restart. */
  appearance: AppearanceConfig;
  /** `[capture]` (D-154): the sites whose links are fetched and summarized by themselves; absent, none. Applied without a restart. */
  capture: CaptureConfig;
  /** `[web]` (D-262): the sites whose pages the Coder on Claude reads by itself; absent, none. Applied without a restart. */
  web: WebConfig;
  /** Absent when `[telegram]` is not configured: the channel is off. */
  telegram?: TelegramConfig;
  /** Absent when `[voice]` is not configured: no apps/voice, no calls (D-066). */
  voice?: VoiceConfig;
  /**
   * Web Push (D-066, D-292): `[push]`, or `[voice.push]` of the files written
   * before it; absent, no notification reaches a closed chat. Independent of
   * the voice service: the chat notifications need only the keys.
   */
  push?: PushConfig;
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
  onlyKeys(root, ['paths', 'database', 'server', 'roles', 'local', 'cloud', 'project', 'project_rules', 'characters', 'personas', 'series', 'agents', 'sprites', 'participants', 'notifications', 'secretary', 'appearance', 'capture', 'web', 'telegram', 'voice', 'push', 'installation'], 'arianna.toml');

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
  const server = parseServer(root.server);
  if (voice !== undefined && voice.port === server.port) throw new ConfigError('voice.port: must differ from server.port');
  if (voice !== undefined && voice.port === server.remote?.port) throw new ConfigError('voice.port: must differ from server.remote.port');
  if (root.push !== undefined && voice?.push !== undefined) throw new ConfigError('push: set Web Push in [push] or in [voice.push], not both');
  const push = root.push === undefined ? voice?.push : parsePush(root.push, 'push');
  const roles = parseRoles(root.roles, catalog);
  const installation = parseInstallation(root.installation);
  const cloud = parseCloud(root.cloud);
  return {
    home,
    paths: { data },
    database: parseDatabase(database, host),
    server,
    roles,
    local: parseLocal(root.local, roles),
    cloud,
    projects: parseProjects(root.project, home, userHome, data),
    projectRules: parseProjectRules(root.project_rules),
    characters: parseCharacters(root.characters),
    personas: parsePersonas(root.personas),
    series: parseSeries(root.series),
    agents: parseAgents(root.agents, legacyDefaultModel(root.cloud)),
    sprites: parseSprites(root.sprites),
    participants: parseParticipants(root.participants),
    notifications: parseNotifications(root.notifications),
    secretary: parseSecretary(root.secretary),
    appearance: parseAppearance(root.appearance),
    capture: parseCapture(root.capture),
    web: parseWeb(root.web),
    ...(telegram === undefined ? {} : { telegram }),
    ...(voice === undefined ? {} : { voice }),
    ...(push === undefined ? {} : { push }),
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
  onlyKeys(server, ['host', 'port', 'remote'], 'server');
  const host = server.host === undefined ? DEFAULT_SERVER.host : asString(server.host, 'server.host');
  if (!SERVER_HOSTS.includes(host)) throw new ConfigError(`server.host: must be one of ${SERVER_HOSTS.join(', ')}`);
  const port = server.port === undefined ? DEFAULT_SERVER.port : asInteger(server.port, 'server.port', 1, 65535);
  const remote = parseRemote(server.remote, port);
  return { host, port, ...(remote === undefined ? {} : { remote }) };
}

/** `[server.remote]` (D-292): a name, a port and who ends TLS; the address is always 127.0.0.1. */
function parseRemote(value: unknown, serverPort: number): RemoteServerConfig | undefined {
  if (value === undefined) return undefined;
  const remote = asTable(value, 'server.remote');
  onlyKeys(remote, ['host', 'port', 'tls'], 'server.remote');
  const host = asString(remote.host, 'server.remote.host');
  if (host.length > 253 || !TAILNET_NAME.test(host)) {
    throw new ConfigError('server.remote.host: the Tailscale name of this Mac, lowercase, ending in .ts.net (e.g. "mac-studio.tail1234.ts.net")');
  }
  const port = remote.port === undefined ? DEFAULT_REMOTE_PORT : asInteger(remote.port, 'server.remote.port', 1024, 65535);
  if (port === serverPort) throw new ConfigError('server.remote.port: must differ from server.port');
  const tlsText = remote.tls === undefined ? DEFAULT_REMOTE_TLS : asString(remote.tls, 'server.remote.tls');
  const tls = REMOTE_TLS_MODES.find((mode) => mode === tlsText);
  if (tls === undefined) throw new ConfigError(`server.remote.tls: must be one of ${REMOTE_TLS_MODES.join(', ')}`);
  return { host, port, tls };
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

/**
 * `loadConfig` for a command the user runs (`pnpm start`, `pnpm db:up`…,
 * D-289): a refused arianna.toml prints its reason, a refused project in
 * Italian with what to do, without the stack trace, and exits with 1. Any
 * other error is thrown as it is.
 */
export function loadConfigOrExit(env: NodeJS.ProcessEnv = process.env): AriannaConfig {
  try {
    return loadConfig(env);
  } catch (error) {
    const text = configErrorText(error);
    if (text === undefined) throw error;
    console.error(text);
    process.exit(1);
  }
}
