/**
 * A local inference endpoint: an OpenAI-compatible server (oMLX today, any
 * other runtime tomorrow) that runs on this machine.
 *
 * "Local" is where inference happens, not the name of the binary
 * (docs/PRIVACY-POLICY-SPEC.md): the gateway trusts the locality an executor
 * declares, and this module is what makes the declaration true. Requests carry
 * L2 data in clear, so only loopback addresses are accepted, and the HTTP
 * client (`http.ts`) never uses a proxy.
 */
export interface LocalEndpoint {
  /** Short name used in logs and events, e.g. "omlx". */
  id: string;
  /** Base URL of the OpenAI-compatible API, e.g. "http://127.0.0.1:8000/v1". */
  url: string;
  /** Model alias (e.g. "local-large") → model name on this server. */
  models: Readonly<Record<string, string>>;
}

export class LocalEndpointError extends Error {
  override name = 'LocalEndpointError';
}

// Addresses, not names: "localhost" goes through name resolution, and
// /etc/hosts could point it elsewhere.
const LOOPBACK_HOSTNAMES = ['127.0.0.1', '[::1]'];

/**
 * Checks that `url` points to this machine and returns it normalized without a
 * trailing slash. Credentials, query and fragment are rejected: they would
 * end up in logs, and no local server needs them.
 */
export function localEndpointUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LocalEndpointError(`not a URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LocalEndpointError(`${parsed.protocol} is not http or https`);
  }
  if (!LOOPBACK_HOSTNAMES.includes(parsed.hostname)) {
    throw new LocalEndpointError(`${parsed.hostname} is not a loopback address`);
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new LocalEndpointError('credentials, query and fragment are not allowed');
  }
  return parsed.href.replace(/\/+$/, '');
}

/** Validates an endpoint and returns a frozen copy. */
export function localEndpoint(endpoint: LocalEndpoint): LocalEndpoint {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(endpoint.id)) {
    throw new LocalEndpointError(`invalid endpoint id ${JSON.stringify(endpoint.id)}`);
  }
  return Object.freeze({
    id: endpoint.id,
    url: localEndpointUrl(endpoint.url),
    models: Object.freeze({ ...endpoint.models }),
  });
}
