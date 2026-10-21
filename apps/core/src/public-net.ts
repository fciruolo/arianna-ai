import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/**
 * The network towards public sites, shared by the downloader of links (D-154,
 * `link-fetch.ts`, also the page reader of D-262) and the resources of the
 * agent's browser (D-264, `browser/resource-fetch.ts`). Never towards this
 * machine or the local network: every address a name resolves to is checked
 * at the moment of connecting (the check is the `lookup` of the socket, so a
 * name cannot answer differently between the check and the connection). One
 * request at a time, no redirect followed here: the callers decide what a
 * redirect may do. Bodies are decompressed here and counted on the
 * decompressed bytes, so a small compressed bomb meets the same limit.
 */

/** Why a request failed on the network side: a closed list, safe for an event or a header. */
export const NET_FAILURES = ['invalid-url', 'private-address', 'dns', 'timeout', 'unsupported-type', 'too-large', 'bad-response', 'network'] as const;
export type NetFailure = (typeof NET_FAILURES)[number];

export class NetError extends Error {
  readonly reason: NetFailure;
  constructor(reason: NetFailure) {
    super(reason);
    this.reason = reason;
  }
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export interface AddressOptions {
  /**
   * Tests only: these exact addresses count as public and any port is
   * allowed, for a fake server on this machine reached through a fake
   * resolver. Every other private address stays refused. Never set by the core.
   */
  unsafeTestAddresses?: readonly string[];
}

// --- Addresses -------------------------------------------------------------

// Two lists: a BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules.
const PRIVATE = new BlockList();
const PRIVATE6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  // IPv4-compatible (::a.b.c.d, :: and ::1 among them), IPv4-mapped and IPv4-translated: never, whatever IPv4 they carry.
  ['::', 96],
  ['::ffff:0:0', 96],
  ['::ffff:0:0:0', 96],
  // NAT64, 6to4 and Teredo may lead to any IPv4, private ones included.
  ['64:ff9b:1::', 48],
  ['2002::', 16],
  ['2001::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
] as const) {
  PRIVATE6.addSubnet(net, prefix, 'ipv6');
}

/** IPv4 inside IPv6 (::ffff:a.b.c.d, ::a.b.c.d): the IPv4 address it carries. */
function embeddedIpv4(address: string): string | undefined {
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`;
  }
  return undefined;
}

/** Loopback, private, link-local, unique-local, multicast, reserved or documentation: never fetched. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 0) return true;
  if (family === 4) return PRIVATE.check(bare, 'ipv4');
  // An IPv4 written inside IPv6 is never fetched, public or not: DNS gives IPv4 as IPv4.
  if (embeddedIpv4(bare) !== undefined) return true;
  return PRIVATE6.check(bare, 'ipv6');
}

/** Names that are this machine or the local network by themselves. */
export function isPrivateName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === '' || !name.includes('.')) return true;
  return name === 'localhost' || /\.(localhost|local|internal|lan|home|arpa|test|invalid|example)$/.test(name);
}

/**
 * The address checked before any request: http(s) only, no credentials, no
 * port other than the default one, no private name nor literal address.
 * Throws a `NetError` (`invalid-url` or `private-address`).
 */
export function checkFetchUrl(value: string, options: AddressOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NetError('invalid-url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new NetError('invalid-url');
  if (url.username !== '' || url.password !== '') throw new NetError('invalid-url');
  const testing = options.unsafeTestAddresses !== undefined;
  if (url.port !== '' && !testing) throw new NetError('invalid-url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host) && options.unsafeTestAddresses?.includes(host) !== true) throw new NetError('private-address');
  } else if (isPrivateName(host)) {
    throw new NetError('private-address');
  }
  return url;
}

export const systemResolve: Resolver = async (host) => dnsLookup(host, { all: true, verbatim: true });

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/** The `lookup` of the socket: resolves, refuses the whole name if any address is private, connects to the checked one. */
export function checkedLookup(resolve: Resolver, allowed: readonly string[]) {
  return (hostname: string, options: { all?: boolean } | number, callback: LookupCallback): void => {
    resolve(hostname)
      .then((addresses) => {
        if (addresses.length === 0) throw new NetError('dns');
        if (addresses.some((entry) => isPrivateAddress(entry.address) && !allowed.includes(entry.address))) throw new NetError('private-address');
        const all = typeof options === 'object' && options.all === true;
        const first = addresses[0];
        if (all) callback(null, addresses);
        else if (first !== undefined) callback(null, first.address, first.family);
      })
      .catch((error: unknown) => {
        const wrapped = (error instanceof NetError ? error : new NetError('dns')) as NetError & NodeJS.ErrnoException;
        callback(wrapped, '', 0);
      });
  };
}

// --- Agents with keep-alive ---------------------------------------------------

export interface PublicAgents {
  http: HttpAgent;
  https: HttpsAgent;
  /** Closes every socket, idle or in use: the job is over. */
  destroy(): void;
}

/**
 * Agents with keep-alive for one job (the browser of D-264): the checked
 * `lookup` is in their own options, which win over those of a request, so no
 * socket of theirs is ever connected without the check. A socket kept alive
 * is reused only for the same host and port, already checked when it connected.
 */
export function createPublicAgents(options: AddressOptions & { resolve?: Resolver; maxSockets?: number } = {}): PublicAgents {
  const lookup = checkedLookup(options.resolve ?? systemResolve, options.unsafeTestAddresses ?? []) as unknown as RequestOptions['lookup'];
  const max = options.maxSockets ?? 8;
  // No maxTotalSockets: with it, sockets kept alive towards other hosts fill
  // the total and a request to a new host waits in the agent forever (seen
  // live on 2026-10-21). The limit of requests at the same time is the
  // caller's (the pool of resource-fetch.ts); idle sockets close by themselves.
  const settings = { keepAlive: true, maxSockets: max, maxFreeSockets: max, timeout: 30_000, scheduling: 'lifo' as const, lookup };
  const http = new HttpAgent(settings);
  const https = new HttpsAgent(settings);
  return {
    http,
    https,
    destroy: () => {
      http.destroy();
      https.destroy();
    },
  };
}

// --- One request ------------------------------------------------------------

export interface PublicRequest {
  /** Checked with `checkFetchUrl` by the caller. */
  url: URL;
  method: 'GET' | 'HEAD' | 'POST';
  /** The exact headers sent, chosen by the caller (`accept-encoding` is set here: the body is decompressed here). */
  headers: OutgoingHttpHeaders;
  body?: Buffer;
  /** Decompressed bytes kept at most. */
  maxBytes: number;
  /** Whether a 2xx answer of this media type (lowercase, no parameters) is read. */
  accept: (type: string) => boolean;
  /**
   * `truncate`: a body beyond the limit is cut and marked; a declared length
   * beyond it is refused before reading unless the type is text/* (D-154).
   * `reject`: any body beyond the limit, declared or decompressed, is `too-large`.
   */
  overflow: 'truncate' | 'reject';
  /** Also read the body of an answer that is neither 2xx nor 3xx, when its type is accepted. Default: an empty body. */
  errorBodies?: boolean;
  resolve?: Resolver;
  /** Keep-alive agents of a job; default a new connection per request. */
  agents?: Pick<PublicAgents, 'http' | 'https'>;
}

export interface PublicResponse {
  status: number;
  location?: string;
  /** Media type, lowercase, without parameters ('' when missing). */
  type: string;
  charset?: string;
  /** Name (lowercase) and value of every header, in order, as received. */
  headers: [string, string][];
  body: Buffer;
  truncated: boolean;
}

function decoded(response: IncomingMessage): Readable {
  const encoding = (response.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(createGunzip());
  if (encoding === 'deflate') return response.pipe(createInflate());
  if (encoding === 'br') return response.pipe(createBrotliDecompress());
  if (encoding === '' || encoding === 'identity') return response;
  throw new NetError('bad-response');
}

function headerPairs(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) pairs.push([(raw[index] ?? '').toLowerCase(), raw[index + 1] ?? '']);
  return pairs;
}

/** One request, no redirect followed. Rejects with a `NetError` only. */
export function publicRequest(request: PublicRequest & AddressOptions, signal: AbortSignal): Promise<PublicResponse> {
  return new Promise<PublicResponse>((resolvePromise, reject) => {
    const https = request.url.protocol === 'https:';
    const agent = request.agents === undefined ? false : https ? request.agents.https : request.agents.http;
    const requestOptions: RequestOptions = {
      method: request.method,
      headers: { ...request.headers, 'accept-encoding': 'gzip, deflate, br' },
      agent,
      lookup: checkedLookup(request.resolve ?? systemResolve, request.unsafeTestAddresses ?? []) as unknown as RequestOptions['lookup'],
      signal,
    };
    const send = https ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (error instanceof NetError) reject(error);
      else if (signal.aborted) reject(new NetError('timeout'));
      else reject(new NetError('network'));
    };
    const req = send(request.url, requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      const location = typeof response.headers.location === 'string' ? response.headers.location : undefined;
      const [rawType = '', ...params] = (response.headers['content-type'] ?? '').split(';').map((part) => part.trim());
      const type = rawType.toLowerCase();
      const charset = params.map((param) => /^charset\s*=\s*"?([A-Za-z0-9_.:-]{1,40})"?$/i.exec(param)?.[1]).find((value) => value !== undefined);
      const headers = headerPairs(response.rawHeaders);
      const empty = (): void => {
        response.resume();
        settled = true;
        resolvePromise({ status, ...(location === undefined ? {} : { location }), type, ...(charset === undefined ? {} : { charset }), headers, body: Buffer.alloc(0), truncated: false });
      };
      const success = status >= 200 && status < 300;
      // A redirect, a HEAD, or an error whose body is not wanted: status and headers only.
      if (request.method === 'HEAD' || (status >= 300 && status < 400) || (!success && (request.errorBodies !== true || !request.accept(type)))) {
        empty();
        return;
      }
      const declared = Number(response.headers['content-length']);
      // Larger than allowed: stop before reading. With `truncate` a text is read up to the limit and cut.
      if (Number.isFinite(declared) && declared > request.maxBytes && (request.overflow === 'reject' || !type.startsWith('text/'))) {
        response.destroy();
        fail(new NetError('too-large'));
        return;
      }
      if (!request.accept(type)) {
        response.destroy();
        fail(new NetError('unsupported-type'));
        return;
      }
      let stream: Readable;
      try {
        stream = decoded(response);
      } catch (error) {
        response.destroy();
        fail(error);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolvePromise({ status, type, ...(charset === undefined ? {} : { charset }), headers, body: Buffer.concat(chunks), truncated });
      };
      const stop = (): void => {
        // Both: a compressed body stops being inflated too.
        stream.destroy();
        response.destroy();
      };
      stream.on('data', (chunk: Buffer) => {
        if (settled || truncated) return;
        const room = request.maxBytes - size;
        if (request.overflow === 'reject') {
          if (chunk.length > room) {
            fail(new NetError('too-large'));
            stop();
            return;
          }
        } else if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          size += room;
          truncated = true;
          finish();
          stop();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.on('end', finish);
      stream.on('error', fail);
      response.on('error', fail);
    });
    req.on('error', fail);
    // A request still waiting in an agent does not always see the signal: it is stopped here too.
    const onAbort = (): void => {
      req.destroy();
      fail(new NetError('timeout'));
    };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => {
        signal.removeEventListener('abort', onAbort);
      });
    }
    req.end(request.body);
  });
}

/** The text of a body in its charset, UTF-8 when the charset is unknown. */
export function decodeBody(body: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
