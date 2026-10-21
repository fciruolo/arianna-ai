import type { OutgoingHttpHeaders } from 'node:http';

import { MAX_RESOURCE_BODY, type ResourceType } from '@arianna/policy';

import { checkFetchUrl, createPublicAgents, NetError, publicRequest, type AddressOptions, type PublicAgents, type Resolver } from '../public-net.ts';

/**
 * The network of the agent's browser (D-264, passo 2): the container has no
 * network, every request of Chromium stops in the core, passes the gateway
 * (`resource-gate.ts`) and is downloaded here, one request, by the network of
 * `public-net.ts` (no private address, DNS fixed on the socket). One request
 * here, no redirect followed: the 3xx comes back with its `Location`, and
 * `network.ts` follows it (Playwright would send the next hop on without the
 * interception), each hop through the gateway again.
 *
 * What leaves is only what is listed here: a few headers rebuilt by the core
 * (never the cookies, credentials, referrer, conditional or range headers,
 * client hints or `X-*` of the browser) and, for a POST, its body. What comes
 * back loses the headers that would set state in the browser or describe a
 * body that is no longer that one (it is decompressed here).
 */

export const RESOURCE_TIMEOUT_MS = 15_000;
/** Requests of one job on the network at the same time; the others wait for a slot. */
export const RESOURCE_CONCURRENCY = 8;
export const ACCEPT_LANGUAGE = 'it,en;q=0.8';

const MB = 1024 * 1024;

interface TypeRule {
  maxBytes: number;
  /** Media types accepted for this kind of resource, lowercase, without parameters. */
  types: readonly string[];
  /** Media type suffixes accepted (`+json`). */
  suffixes?: readonly string[];
  accept: string;
}

/** Limits and media types per kind of resource (D-264): beyond the limit a body is refused, never cut. */
export const RESOURCE_RULES: Readonly<Record<ResourceType, TypeRule>> = {
  document: { maxBytes: 3 * MB, types: ['text/html', 'application/xhtml+xml', 'text/plain'], accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8' },
  stylesheet: { maxBytes: 2 * MB, types: ['text/css'], accept: 'text/css,*/*;q=0.1' },
  script: { maxBytes: 5 * MB, types: ['text/javascript', 'application/javascript', 'application/x-javascript', 'application/ecmascript', 'text/ecmascript'], accept: '*/*' },
  image: {
    maxBytes: 5 * MB,
    types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'],
    accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
  },
  // Fonts are often served as octet-stream: they are read only by the font parser of Chromium.
  font: {
    maxBytes: 2 * MB,
    types: ['font/woff2', 'font/woff', 'font/ttf', 'font/otf', 'font/sfnt', 'application/font-woff', 'application/font-woff2', 'application/x-font-woff', 'application/x-font-ttf', 'application/x-font-otf', 'application/vnd.ms-fontobject', 'application/octet-stream'],
    accept: '*/*',
  },
  // fetch and XMLHttpRequest: JSON allowed (choice of the user, 2026-10-21), text and HTML fragments.
  fetch: { maxBytes: 2 * MB, types: ['application/json', 'text/json', 'text/plain', 'text/html'], suffixes: ['+json'], accept: '*/*' },
};

function accepts(rule: TypeRule, type: string): boolean {
  return rule.types.includes(type) || (rule.suffixes ?? []).some((suffix) => type.startsWith('application/') && type.endsWith(suffix));
}

/** Why a resource was not given to the browser: a closed list, safe for an event. */
export const RESOURCE_FAILURES = [
  'invalid-url',
  'private-address',
  'dns',
  'timeout',
  'unsupported-type',
  'too-large',
  'bad-response',
  'network',
  // The request itself: a method other than GET, HEAD and POST, a body with GET or HEAD.
  'invalid-request',
  'body-too-large',
  // A body that is not UTF-8 text: the gateway could not read it.
  'unreadable-body',
  // A redirect from https down to http, or towards anything that is not http(s).
  'insecure-redirect',
  // An iframe navigation outside the sites a `user` or `sites` consent allows (network.ts).
  'other-site',
  // A redirect of a script call towards another origin that does not allow the page (CORS, network.ts).
  'cors',
  'blocked',
  'interrupted',
] as const;
export type ResourceFailure = (typeof RESOURCE_FAILURES)[number];

export interface ResourceInput {
  url: string;
  /** As the browser says it; only GET, HEAD and POST are requested. */
  method: string;
  /** The headers of the browser (names in any case): only those of the list are read. */
  headers: Readonly<Record<string, string>>;
  body?: Buffer;
  type: ResourceType;
  /**
   * The `Cookie` header of the site of an access made by the user (D-276):
   * set only by the core (network.ts, from its cookie jar, after the gateway
   * allowed a request of that site), never from the headers of the page.
   */
  cookie?: string;
}

export type ResourceResult =
  | {
      ok: true;
      status: number;
      /** The headers of the answer, without those that set state or describe the original body. */
      headers: [string, string][];
      body: Buffer;
      /** For a 3xx: where it points, as an absolute http(s) address (not followed). */
      location?: string;
      /** The Set-Cookie lines of the answer, never given to the browser: the cookie jar of network.ts decides (D-276). */
      setCookies?: string[];
    }
  | { ok: false; reason: ResourceFailure };

/** The network of one job: agents with keep-alive and a limit of requests at the same time. */
export interface ResourcePool {
  readonly agents: PublicAgents;
  /** Runs `task` when a slot is free; a signal aborted while waiting gives up the turn. */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Closes every connection; requests waiting for a slot are refused. */
  destroy(): void;
  readonly destroyed: boolean;
}

class PoolClosed extends Error {}

export function createResourcePool(options: AddressOptions & { resolve?: Resolver; concurrency?: number } = {}): ResourcePool {
  const limit = options.concurrency ?? RESOURCE_CONCURRENCY;
  const agents = createPublicAgents({ ...options, maxSockets: limit });
  let active = 0;
  let destroyed = false;
  const waiting: { start: () => void; cancel: (error: Error) => void }[] = [];
  const next = (): void => {
    while (active < limit && waiting.length > 0) waiting.shift()?.start();
  };
  return {
    agents,
    get destroyed() {
      return destroyed;
    },
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (destroyed) return Promise.reject(new PoolClosed());
      return new Promise<T>((resolve, reject) => {
        const entry = {
          start: () => {
            signal?.removeEventListener('abort', onAbort);
            active += 1;
            task()
              .then(resolve, reject)
              .finally(() => {
                active -= 1;
                next();
              });
          },
          cancel: (error: Error) => {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        };
        const onAbort = (): void => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          entry.cancel(new PoolClosed());
        };
        if (signal?.aborted === true) {
          reject(new PoolClosed());
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        waiting.push(entry);
        next();
      });
    },
    destroy() {
      destroyed = true;
      for (const entry of waiting.splice(0)) entry.cancel(new PoolClosed());
      agents.destroy();
    },
  };
}

export interface ResourceOptions extends AddressOptions {
  /** The User-Agent of the Chromium of the container (choice of the user, 2026-10-21). */
  userAgent: string;
  pool: ResourcePool;
  timeoutMs?: number;
  resolve?: Resolver;
}

/** Headers of the answer never given to the browser. */
const DROPPED_IN = new Set([
  'set-cookie',
  'set-cookie2',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'alt-svc',
  'www-authenticate',
  'clear-site-data',
  // Hop by hop: they describe the connection of the core, not the answer.
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'trailer',
  'upgrade',
]);

/** A header value as it may leave: printable ASCII, not too long. */
function headerValue(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= max && /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : undefined;
}

function headerOf(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

/** `Origin` reduced to scheme and host (and port); anything else (`null` among them) is not sent. */
function originOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Media types a POST body may declare: what forms and scripts send most. */
const POST_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', 'application/json'];
const CHARSETS = ['utf-8', 'utf8', 'iso-8859-1', 'us-ascii', 'windows-1252'];
/** The boundary Chromium writes for multipart bodies, forms and FormData alike: nothing else fits in it. */
const BOUNDARY = /^-{0,8}WebKitFormBoundary[A-Za-z0-9]{16}$/;

/**
 * The `Content-Type` of a POST from a closed list, rebuilt here: the media
 * type, at most a `charset` from a list, and for multipart a boundary in the
 * form Chromium writes that the body itself uses (`--<boundary>`, in the text
 * the gateway read): a boundary nothing reads is not sent. Anything else is not sent (the body still is: the
 * gateway read it): a value written by the page would leave unread by vault
 * and scanner.
 */
export function postContentType(value: string | undefined, body?: Buffer): string | undefined {
  if (value === undefined || value.length > 200) return undefined;
  const [rawType = '', ...params] = value.split(';').map((part) => part.trim());
  const type = rawType.toLowerCase();
  if (!POST_TYPES.includes(type)) return undefined;
  let charset: string | undefined;
  let boundary: string | undefined;
  for (const param of params) {
    const match = /^([A-Za-z-]+)\s*=\s*"?([^";]*)"?$/.exec(param);
    if (match === null) return undefined;
    const name = (match[1] ?? '').toLowerCase();
    const argument = match[2] ?? '';
    if (name === 'charset' && charset === undefined && CHARSETS.includes(argument.toLowerCase())) charset = argument.toLowerCase();
    else if (name === 'boundary' && boundary === undefined && type === 'multipart/form-data' && BOUNDARY.test(argument)) boundary = argument;
    else return undefined;
  }
  if (type === 'multipart/form-data' && (boundary === undefined || body?.includes(`--${boundary}`) !== true)) return undefined;
  return `${type}${boundary === undefined ? '' : `; boundary=${boundary}`}${charset === undefined ? '' : `; charset=${charset}`}`;
}

/**
 * The only headers that leave (D-264), none of them written by the page:
 * `Accept` fixed by kind, `Accept-Language` fixed, `Accept-Encoding` fixed
 * (set by `public-net.ts`, which decompresses), `Content-Type` only with
 * POST and from a closed list (`postContentType`), `Origin` as scheme and
 * host of the page (an address the gateway already let go), `User-Agent` of
 * the Chromium of the container. Every other header of the browser stays here.
 */
export function outgoingHeaders(input: Pick<ResourceInput, 'headers' | 'type' | 'body' | 'cookie'>, method: 'GET' | 'HEAD' | 'POST', userAgent: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    accept: RESOURCE_RULES[input.type].accept,
    'accept-language': ACCEPT_LANGUAGE,
    'user-agent': headerValue(userAgent, 500) ?? 'Mozilla/5.0',
  };
  const origin = originOf(headerOf(input.headers, 'origin'));
  if (origin !== undefined) headers.origin = origin;
  // The cookies of the site of an access (D-276): from the jar of the core, never from the page.
  const cookie = headerValue(input.cookie, 8192);
  if (cookie !== undefined) headers.cookie = cookie;
  if (method === 'POST') {
    const type = postContentType(headerOf(input.headers, 'content-type'), input.body);
    if (type !== undefined) headers['content-type'] = type;
  }
  return headers;
}

/** The method and body of a request as they may leave, or why not. */
export function checkRequest(input: Pick<ResourceInput, 'method' | 'body'>): { method: 'GET' | 'HEAD' | 'POST'; body?: Buffer } | ResourceFailure {
  const method = input.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return 'invalid-request';
  const body = input.body !== undefined && input.body.length > 0 ? input.body : undefined;
  if (body !== undefined && method !== 'POST') return 'invalid-request';
  if (body !== undefined && body.length > MAX_RESOURCE_BODY) return 'body-too-large';
  return body === undefined ? { method } : { method, body };
}

/** The address a request goes to: checked as in `public-net.ts`, without the fragment (never sent). */
export function resourceUrl(value: string, options: AddressOptions = {}): URL | ResourceFailure {
  try {
    const url = checkFetchUrl(value, options);
    url.hash = '';
    return url;
  } catch (error) {
    return error instanceof NetError && error.reason === 'private-address' ? 'private-address' : 'invalid-url';
  }
}

/**
 * Where a 3xx points, absolute; refused from https down to http, and towards
 * anything that is not http(s). Downgrades are refused as for links (D-154):
 * the next address, which a site chose and may carry data, would travel in
 * clear, and the mixed-content rules of the browser are not relied upon.
 */
export function redirectTarget(location: string, from: URL): { href: string } | { reason: ResourceFailure } {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return { reason: 'bad-response' };
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') return { reason: 'insecure-redirect' };
  if (from.protocol === 'https:' && next.protocol === 'http:') return { reason: 'insecure-redirect' };
  return { href: next.href };
}

/**
 * One resource for the browser, no redirect followed. Never throws: a failure
 * is a reason. Only the network: the gateway is asked by `resource-gate.ts`,
 * which gives here the exact address and body it allowed.
 */
export async function fetchResource(input: ResourceInput, options: ResourceOptions, signal?: AbortSignal): Promise<ResourceResult> {
  const request = checkRequest(input);
  if (typeof request === 'string') return { ok: false, reason: request };
  const url = resourceUrl(input.url, options);
  if (typeof url === 'string') return { ok: false, reason: url };
  const rule = RESOURCE_RULES[input.type];
  let timeout: AbortSignal | undefined;
  try {
    return await options.pool.run(async () => {
      // The time runs from the moment the request has a slot.
      timeout = AbortSignal.timeout(options.timeoutMs ?? RESOURCE_TIMEOUT_MS);
      const all = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      const response = await publicRequest(
        {
          url,
          method: request.method,
          headers: outgoingHeaders(input, request.method, options.userAgent),
          ...(request.body === undefined ? {} : { body: request.body }),
          maxBytes: rule.maxBytes,
          accept: (type) => accepts(rule, type),
          overflow: 'reject',
          errorBodies: true,
          agents: options.pool.agents,
          ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
          ...(options.unsafeTestAddresses === undefined ? {} : { unsafeTestAddresses: options.unsafeTestAddresses }),
        },
        all,
      );
      const redirect = response.status >= 300 && response.status < 400 && response.location !== undefined ? redirectTarget(response.location, url) : undefined;
      if (redirect !== undefined && 'reason' in redirect) return { ok: false, reason: redirect.reason };
      const location = redirect?.href;
      const headers = response.headers.filter(([name]) => !DROPPED_IN.has(name));
      const setCookies = response.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value);
      const result: ResourceResult = {
        ok: true,
        status: response.status,
        headers: location === undefined ? headers : headers.map(([name, value]) => (name === 'location' ? [name, location] : [name, value])),
        body: response.body,
      };
      if (location !== undefined) result.location = location;
      if (setCookies.length > 0) result.setCookies = setCookies;
      return result;
    }, signal);
  } catch (error) {
    if (signal?.aborted === true || error instanceof PoolClosed) return { ok: false, reason: 'interrupted' };
    if (error instanceof NetError) return { ok: false, reason: error.reason };
    if (timeout?.aborted === true) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network' };
  }
}
