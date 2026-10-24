import { aliasesOf, type Roles } from './roles.ts';
import { asArray, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

/** Local inference (task 1.3): OpenAI-compatible servers on this machine. */
export interface LocalConfig {
  /** In order of preference: the first is the main server, the others are fallbacks. */
  endpoints: LocalEndpointConfig[];
  /**
   * `idle_unload_minutes` (D-316): minutes without a request to a local model
   * before the core unloads it from the server; 0 never, 30 when absent.
   */
  idleUnloadMinutes: number;
}

export const DEFAULT_IDLE_UNLOAD_MINUTES = 30;
export const MAX_IDLE_UNLOAD_MINUTES = 1440;

export function isIdleUnloadMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_IDLE_UNLOAD_MINUTES;
}

export interface LocalEndpointConfig {
  id: string;
  url: string;
  /** argv that starts the server, so the watchdog can restart it. */
  command?: string[];
  /**
   * Model alias (e.g. "local-large") → model name on this server. Without
   * `models` in the file, the names come from `[roles]` (task 1.18).
   */
  models: Record<string, string>;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
// Same rule as @arianna/executors (endpoint.ts), which checks again; a test
// keeps the two in step. Addresses only: "localhost" depends on /etc/hosts.
const LOOPBACK_HOSTNAMES = ['127.0.0.1', '[::1]'];

export function parseLocal(value: unknown, roles: Roles = {}): LocalConfig {
  if (value === undefined) return { endpoints: [], idleUnloadMinutes: DEFAULT_IDLE_UNLOAD_MINUTES };
  const local = asTable(value, 'local');
  onlyKeys(local, ['endpoints', 'idle_unload_minutes'], 'local');
  const idle = local.idle_unload_minutes ?? DEFAULT_IDLE_UNLOAD_MINUTES;
  if (!isIdleUnloadMinutes(idle)) throw new ConfigError(`local.idle_unload_minutes: a whole number from 0 (never) to ${String(MAX_IDLE_UNLOAD_MINUTES)}`);
  const endpoints = asArray(local.endpoints ?? [], 'local.endpoints').map((item, index) =>
    parseEndpoint(item, `local.endpoints[${String(index)}]`, roles),
  );
  const ids = endpoints.map(({ id }) => id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new ConfigError(`local.endpoints: duplicate id ${duplicate}`);
  return { endpoints, idleUnloadMinutes: idle };
}

function parseEndpoint(value: unknown, where: string, roles: Roles): LocalEndpointConfig {
  const table = asTable(value, where);
  onlyKeys(table, ['id', 'url', 'command', 'models'], where);

  const id = asString(table.id, `${where}.id`);
  if (!NAME.test(id)) throw new ConfigError(`${where}.id: lowercase letters, digits and dashes only`);

  const models: Record<string, string> = table.models === undefined ? aliasesOf(roles) : {};
  for (const [alias, name] of Object.entries(table.models === undefined ? {} : asTable(table.models, `${where}.models`))) {
    if (!NAME.test(alias)) throw new ConfigError(`${where}.models: invalid alias ${JSON.stringify(alias)}`);
    models[alias] = asString(name, `${where}.models.${alias}`);
  }
  if (Object.keys(models).length === 0) {
    throw new ConfigError(`${where}.models: list the models, or assign them in [roles] (pnpm arianna:init)`);
  }

  const endpoint: LocalEndpointConfig = { id, url: loopbackUrl(table.url, `${where}.url`), models };
  if (table.command !== undefined) {
    const command = asArray(table.command, `${where}.command`).map((arg, index) =>
      asString(arg, `${where}.command[${String(index)}]`),
    );
    if (command.length === 0) throw new ConfigError(`${where}.command: must not be empty`);
    // D-203: data/guard/models holds the models of apps/guard; a local server never reads them.
    if (command.some(readsGuardModels)) throw new ConfigError(`${where}.command: data/guard/models is only for apps/guard, a local server never reads it`);
    endpoint.command = command;
  }
  return endpoint;
}

/**
 * An argument that names data/guard/models or a folder inside it (`--model-dir=…` included).
 * A parent folder (`data`, `data/guard`) or a path through `~` or a variable is not caught:
 * the doctor still finds a copy in data/models, and oMLX is started with data/models.
 */
function readsGuardModels(arg: string): boolean {
  const parts = arg.split(/[\\/=]/).filter((part) => part !== '' && part !== '.');
  return parts.some((part, index) => part === 'guard' && parts[index + 1] === 'models');
}

/**
 * Requests to a local endpoint carry L2 data in clear: the server must be on
 * this machine. A server elsewhere on the network needs its own decision.
 */
function loopbackUrl(value: unknown, where: string): string {
  const text = asString(value, where);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`${where}: not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${where}: must be http or https`);
  if (!LOOPBACK_HOSTNAMES.includes(url.hostname)) {
    throw new ConfigError(`${where}: must be on this machine (${LOOPBACK_HOSTNAMES.join(', ')})`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${where}: credentials, query and fragment are not allowed`);
  }
  return text;
}
