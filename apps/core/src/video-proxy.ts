import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { checkedLookup, isPrivateName, systemResolve, type Resolver } from './public-net.ts';

/**
 * The network of yt-dlp for one video (D-273, tappa A): a `CONNECT` proxy of
 * the core on 127.0.0.1, alive only for the job that asked it, with a token
 * of its own in the address it gives. It opens a tunnel only to port 443 of
 * a closed list of hosts of YouTube and Google; every address a name resolves
 * to is checked at the moment of connecting, as the links of D-154
 * (`public-net.ts`), so a name cannot lead to this machine or the local
 * network. Plain HTTP requests are refused. When the bytes of all tunnels pass
 * the limit, or the time is over, every tunnel closes and the job fails with
 * the reason. Declared limit: the tunnels are TLS, so the proxy sees the name
 * of each host and the bytes, never what is asked inside them; what may be
 * asked is that video only, because the address that left through the
 * gateway (`link-video`) is the only one yt-dlp is given.
 */

/** Hosts reached by name, exactly. */
export const VIDEO_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'consent.youtube.com', 'youtubei.googleapis.com', 'i.ytimg.com'] as const;
/** Hosts reached as subdomains: the servers of the media of YouTube. */
export const VIDEO_HOST_SUFFIXES = ['.googlevideo.com'] as const;
export const VIDEO_PROXY_MAX_BYTES = 400 * 1024 * 1024;
export const VIDEO_PROXY_MAX_MS = 20 * 60_000;
const PORT = 443;
const MAX_HOST = 253;

/** Whether a tunnel may lead to this host: a name of the list (never an address), lowercase, without a trailing dot. */
export function videoHostAllowed(host: string): boolean {
  const name = host.toLowerCase();
  if (name.length > MAX_HOST || name.endsWith('.') || isIP(name) !== 0 || isPrivateName(name)) return false;
  if (!/^[a-z0-9.-]+$/.test(name) || name.split('.').some((label) => label === '' || label.startsWith('-') || label.endsWith('-'))) return false;
  if (VIDEO_HOSTS.some((allowed) => allowed === name)) return true;
  return VIDEO_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix) && name.length > suffix.length);
}

/** `host:port` of a CONNECT, or undefined when it is not one. */
export function connectTarget(target: string | undefined): { host: string; port: number } | undefined {
  if (target === undefined) return undefined;
  const match = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(target);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const port = Number(match[2]);
  return port >= 1 && port <= 65_535 ? { host: match[1].toLowerCase(), port } : undefined;
}

export type VideoProxyStop = 'too-large' | 'timeout';

export interface VideoProxyOptions {
  maxBytes?: number;
  maxMs?: number;
  resolve?: Resolver;
  /** Tests only: the port tunnels lead to instead of 443, and these exact addresses count as public. Never set by the core. */
  unsafeTest?: { port: number; addresses: readonly string[] };
}

export interface VideoProxy {
  /** The address yt-dlp is given: `http://arianna:<token>@127.0.0.1:<port>`. Never in a log nor an argument. */
  readonly url: string;
  /** Bytes through every tunnel so far, both ways. */
  readonly bytes: number;
  /** Tunnels refused (another host or port, no token). */
  readonly refused: number;
  /** Why the proxy closed by itself: the bytes or the time were over. */
  readonly stopped: VideoProxyStop | undefined;
  stop(): Promise<void>;
}

function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const header = request.headers['proxy-authorization'];
  if (typeof header !== 'string') return false;
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function refuse(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Starts the proxy of one job on a free port of 127.0.0.1. */
export async function startVideoProxy(options: VideoProxyOptions = {}): Promise<VideoProxy> {
  const maxBytes = options.maxBytes ?? VIDEO_PROXY_MAX_BYTES;
  const token = randomBytes(24).toString('base64url');
  const expected = Buffer.from(`Basic ${Buffer.from(`arianna:${token}`).toString('base64')}`);
  const port = options.unsafeTest?.port ?? PORT;
  const lookup = checkedLookup(options.resolve ?? systemResolve, options.unsafeTest?.addresses ?? []);
  const sockets = new Set<Duplex>();
  let bytes = 0;
  let refused = 0;
  let stopped: VideoProxyStop | undefined;
  let closed = false;

  const track = (socket: Duplex): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };
  const closeAll = (): void => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  const count = (size: number): void => {
    bytes += size;
    if (bytes > maxBytes && stopped === undefined) {
      stopped = 'too-large';
      closeAll();
    }
  };

  const server = createServer((request, response) => {
    // Only tunnels: a plain request through the proxy would be in clear.
    refused += 1;
    request.resume();
    response.writeHead(405, { connection: 'close' }).end();
  });
  server.on('connection', (socket: Socket) => { track(socket); });
  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    const target = connectTarget(request.url);
    if (closed || stopped !== undefined) {
      refuse(client, '503 Service Unavailable');
      return;
    }
    if (!authorized(request, expected)) {
      refused += 1;
      refuse(client, '407 Proxy Authentication Required');
      return;
    }
    if (target === undefined || target.port !== port || !videoHostAllowed(target.host)) {
      refused += 1;
      refuse(client, '403 Forbidden');
      return;
    }
    const upstream = connect({ host: target.host, port, lookup: lookup as never });
    track(upstream);
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        count(head.length);
        upstream.write(head);
      }
      upstream.on('data', (chunk: Buffer) => { count(chunk.length); });
      client.on('data', (chunk: Buffer) => { count(chunk.length); });
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once('error', () => {
      if (!client.destroyed) refuse(client, '502 Bad Gateway');
    });
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const timer = setTimeout(() => {
    if (stopped === undefined) stopped = 'timeout';
    closeAll();
  }, options.maxMs ?? VIDEO_PROXY_MAX_MS);
  timer.unref();

  return {
    url: `http://arianna:${token}@127.0.0.1:${String(address.port)}`,
    get bytes() {
      return bytes;
    },
    get refused() {
      return refused;
    },
    get stopped() {
      return stopped;
    },
    async stop() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => { resolve(); });
      });
    },
  };
}
