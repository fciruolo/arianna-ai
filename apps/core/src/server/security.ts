/**
 * Request checks of the API (D-039). A browser reaches 127.0.0.1 from any web
 * site: without these, a hostile page could read the L2 history through DNS
 * rebinding, or approve a declassification with a cross-site request.
 * Pure functions, tested without a server.
 */
export interface RequestFacts {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  contentType: string | undefined;
  /** An upgrade to WebSocket: browsers always send Origin there, so it is required. */
  upgrade?: boolean;
}

export type CheckResult = { ok: true } | { ok: false; status: 403 | 415; reason: string };

/** The Host values that name this server: its address and `localhost`, with the port. */
export function allowedHosts(host: string, port: number): Set<string> {
  const address = host.includes(':') ? `[${host}]` : host;
  return new Set([`${address}:${String(port)}`, `localhost:${String(port)}`]);
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function checkRequest(facts: RequestFacts, hosts: ReadonlySet<string>): CheckResult {
  const host = facts.host?.toLowerCase();
  // DNS rebinding: the attacker's name resolves to 127.0.0.1, but the browser still sends it as Host.
  if (host === undefined || !hosts.has(host)) return { ok: false, status: 403, reason: 'unknown host' };

  // Same origin only. A page on another site always sends its own Origin on
  // cross-site POSTs and WebSocket handshakes.
  if (facts.origin !== undefined && facts.origin !== `http://${host}`) {
    return { ok: false, status: 403, reason: 'cross-origin request' };
  }
  if (facts.upgrade === true && facts.origin === undefined) return { ok: false, status: 403, reason: 'missing origin' };

  if (STATE_CHANGING.has(facts.method)) {
    // A form or a "simple" fetch cannot send application/json without a preflight, which gets no CORS headers.
    const type = facts.contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'application/json') return { ok: false, status: 415, reason: 'content type must be application/json' };
  }
  return { ok: true };
}

/** Headers of every response. */
export function securityHeaders(host: string): Record<string, string> {
  return {
    'content-security-policy': [
      "default-src 'self'",
      `connect-src 'self' ws://${host}`,
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-frame-options': 'DENY',
  };
}
