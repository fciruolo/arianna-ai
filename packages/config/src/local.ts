import { asArray, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

/** Local inference (task 1.3): OpenAI-compatible servers on this machine. */
export interface LocalConfig {
  /** In order of preference: the first is the main server, the others are fallbacks. */
  endpoints: LocalEndpointConfig[];
}

export interface LocalEndpointConfig {
  id: string;
  url: string;
  /** argv that starts the server, so the watchdog can restart it. */
  command?: string[];
  /** Model alias (e.g. "local-large") → model name on this server. */
  models: Record<string, string>;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
// Same rule as @arianna/executors (endpoint.ts), which checks again; a test
// keeps the two in step. Addresses only: "localhost" depends on /etc/hosts.
const LOOPBACK_HOSTNAMES = ['127.0.0.1', '[::1]'];

export function parseLocal(value: unknown): LocalConfig {
  if (value === undefined) return { endpoints: [] };
  const local = asTable(value, 'local');
  onlyKeys(local, ['endpoints'], 'local');
  const endpoints = asArray(local.endpoints ?? [], 'local.endpoints').map((item, index) =>
    parseEndpoint(item, `local.endpoints[${String(index)}]`),
  );
  const ids = endpoints.map(({ id }) => id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new ConfigError(`local.endpoints: duplicate id ${duplicate}`);
  return { endpoints };
}

function parseEndpoint(value: unknown, where: string): LocalEndpointConfig {
  const table = asTable(value, where);
  onlyKeys(table, ['id', 'url', 'command', 'models'], where);

  const id = asString(table.id, `${where}.id`);
  if (!NAME.test(id)) throw new ConfigError(`${where}.id: lowercase letters, digits and dashes only`);

  const models: Record<string, string> = {};
  for (const [alias, name] of Object.entries(asTable(table.models, `${where}.models`))) {
    if (!NAME.test(alias)) throw new ConfigError(`${where}.models: invalid alias ${JSON.stringify(alias)}`);
    models[alias] = asString(name, `${where}.models.${alias}`);
  }

  const endpoint: LocalEndpointConfig = { id, url: loopbackUrl(table.url, `${where}.url`), models };
  if (table.command !== undefined) {
    const command = asArray(table.command, `${where}.command`).map((arg, index) =>
      asString(arg, `${where}.command[${String(index)}]`),
    );
    if (command.length === 0) throw new ConfigError(`${where}.command: must not be empty`);
    endpoint.command = command;
  }
  return endpoint;
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
