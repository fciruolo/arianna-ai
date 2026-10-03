import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import { listApprovals, loadApproval, type ApprovalState } from '../approvals.ts';
import {
  ChatError,
  createConversation,
  isUuid,
  listConversations,
  listMessages,
  loadConversation,
  postUserMessage,
  setConversationModel,
} from '../conversations.ts';
import type { Sql } from '../db/client.ts';
import { recordDecision } from '../engine.ts';
import type { LiveFeed, LiveMessage } from '../live.ts';
import { loadTask, TaskError } from '../tasks.ts';
import { allowedHosts, checkRequest, securityHeaders } from './security.ts';

/**
 * API, WebSocket and web chat of the core (task 1.11, D-039). `node:http`
 * without a framework; loopback only (config), same-origin only (security.ts).
 * Every action goes through HTTP; the WebSocket only pushes events and reply
 * fragments.
 */
export interface ApiServerOptions {
  sql: Sql;
  live: LiveFeed;
  host: string;
  port: number;
  /** `cloud.allowlist` of arianna.toml: the only workspaces a work conversation may name. */
  allowlist?: readonly string[];
  /** The cloud models a work conversation may choose (task 1.10), from the current configuration. */
  models?: () => readonly { executor: string; model: string }[];
  /** Built web chat (`apps/hud/dist`); without it only the API is served. */
  staticDir?: string;
  /** Errors are reported here, never sent to the client: they may hold data. */
  onError?: (error: unknown) => void;
}

export interface ApiServer {
  /** The bound port, useful with port 0 in tests. */
  readonly port: number;
  close(): Promise<void>;
}

// A message of MAX_MESSAGE_LENGTH 4-byte characters, JSON-escaped, fits.
export const MAX_BODY_BYTES = 128 * 1024;
/** A client that reads this far behind is dropped; it catches up on reconnection. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const PING_MS = 30_000;
const PAGE_LIMIT = 200;

class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Params = Record<string, string>;
type Handler = (request: IncomingMessage, url: URL, params: Params) => Promise<{ status?: number; body: unknown }>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const source = path.replace(/:([a-zA-Z]+)/g, (_match, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, handler };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'body must be a JSON object');
  return value as Record<string, unknown>;
}

function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new HttpError(400, `unknown field(s): ${unknown.join(', ')}`);
}

function limitParam(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new HttpError(400, `limit must be 1-${String(PAGE_LIMIT)}`);
  return limit;
}

function idParam(params: Params, key: string): string {
  const id = params[key] ?? '';
  if (!isUuid(id)) throw new HttpError(404, 'not found');
  return id;
}

const APPROVAL_STATES: readonly ApprovalState[] = ['pending', 'approved', 'rejected', 'expired'];

function routes(sql: Sql, allowlist: readonly string[], models: () => readonly { executor: string; model: string }[]): Route[] {
  return [
    route('GET', '/api/health', () => Promise.resolve({ body: { ok: true } })),

    // The cloud models of this installation: what the selector of a work conversation offers.
    route('GET', '/api/models', () => Promise.resolve({ body: { models: models() } })),

    route('GET', '/api/conversations', async (_request, url) => ({
      body: { conversations: await listConversations(sql, limitParam(url)) },
    })),

    route('POST', '/api/conversations', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['mode', 'workspace']);
      if (body.mode !== 'work' && body.mode !== 'private') throw new HttpError(400, 'mode must be work or private');
      if (body.workspace !== undefined && typeof body.workspace !== 'string') throw new HttpError(400, 'workspace must be a string');
      const conversation = await createConversation(sql, {
        mode: body.mode,
        ...(body.workspace === undefined ? {} : { workspace: body.workspace }),
        allowlist,
      });
      return { status: 201, body: { conversation } };
    }),

    route('GET', '/api/conversations/:id', async (_request, _url, params) => {
      const conversation = await loadConversation(sql, idParam(params, 'id'));
      if (conversation === undefined) throw new HttpError(404, 'not found');
      return { body: { conversation } };
    }),

    // The user's model for the delegated steps of a work conversation; null lets the router choose.
    route('POST', '/api/conversations/:id/model', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['model']);
      if (body.model !== null && typeof body.model !== 'string') throw new HttpError(400, 'model must be a string or null');
      const conversation = await setConversationModel(sql, id, body.model, models().map((entry) => entry.model));
      return { body: { conversation } };
    }),

    route('GET', '/api/conversations/:id/messages', async (_request, url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      const before = url.searchParams.get('before');
      if (before !== null && !/^\d{1,19}$/.test(before)) throw new HttpError(400, 'before must be a message id');
      const messages = await listMessages(sql, id, { limit: limitParam(url), ...(before === null ? {} : { beforeId: before }) });
      return { body: { messages } };
    }),

    route('POST', '/api/conversations/:id/messages', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['body']);
      if (typeof body.body !== 'string') throw new HttpError(400, 'body must be a string');
      const { message, task } = await postUserMessage(sql, id, body.body);
      return { status: 201, body: { message, task } };
    }),

    route('GET', '/api/tasks/:id', async (_request, _url, params) => {
      const task = await loadTask(sql, idParam(params, 'id'));
      if (task === undefined) throw new HttpError(404, 'not found');
      return { body: { task } };
    }),

    route('GET', '/api/approvals', async (_request, url) => {
      const state = url.searchParams.get('state') ?? 'pending';
      const known = APPROVAL_STATES.find((candidate) => candidate === state);
      if (known === undefined) throw new HttpError(400, 'unknown state');
      return { body: { approvals: await listApprovals(sql, known, limitParam(url)) } };
    }),

    route('GET', '/api/approvals/:id', async (_request, _url, params) => {
      const approval = await loadApproval(sql, idParam(params, 'id'));
      if (approval === undefined) throw new HttpError(404, 'not found');
      return { body: { approval } };
    }),

    // The web chat is the channel of the decision: a declassification can be decided only here.
    route('POST', '/api/approvals/:id/decision', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['state']);
      if (body.state !== 'approved' && body.state !== 'rejected') throw new HttpError(400, 'state must be approved or rejected');
      const current = await loadApproval(sql, id);
      if (current === undefined) throw new HttpError(404, 'not found');
      if (current.state !== 'pending') throw new HttpError(409, `the approval is already ${current.state}`);
      try {
        return { body: { approval: await recordDecision(sql, id, body.state, 'web') } };
      } catch (error) {
        // Decided meanwhile (another tab, Telegram): the database refused the second decision.
        if (error instanceof Error && /already decided/.test(error.message)) throw new HttpError(409, 'the approval is already decided');
        throw error;
      }
    }),
  ];
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/** A file of the built web chat; unknown paths get index.html (client-side routes). */
async function staticFile(dir: string, pathname: string): Promise<{ body: Buffer; type: string } | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const root = await realpath(normalize(dir)).catch(() => undefined);
  if (root === undefined) return undefined;
  const inside = (path: string): boolean => path === root || path.startsWith(root + sep);
  const candidate = normalize(join(root, decoded));
  if (!inside(candidate)) return undefined;
  for (const path of [candidate, join(root, 'index.html')]) {
    try {
      // A symbolic link inside the folder must not lead out of it.
      if (!inside(await realpath(path)) || !(await stat(path)).isFile()) continue;
      return { body: await readFile(path), type: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream' };
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function errorStatus(error: unknown): { status: number; message: string } | undefined {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (error instanceof ChatError) {
    const status = error.code === 'not-found' ? 404 : error.code === 'scanner' ? 422 : 400;
    return { status, message: error.message };
  }
  if (error instanceof TaskError) return { status: 409, message: 'the task cannot do this now' };
  return undefined;
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const { sql, live } = options;
  const table = routes(sql, options.allowlist ?? [], options.models ?? (() => []));
  const sockets = new Set<WebSocket>();
  let hosts = allowedHosts(options.host, options.port);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host?.toLowerCase() ?? '';
    const headers = securityHeaders(host);
    const check = checkRequest(
      { method: request.method ?? 'GET', host: request.headers.host, origin: request.headers.origin, contentType: request.headers['content-type'] },
      hosts,
    );
    if (!check.ok) {
      sendJson(response, check.status, { error: check.reason }, headers);
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        const matches = table.map((candidate) => ({ candidate, match: candidate.pattern.exec(url.pathname) })).filter(({ match }) => match !== null);
        if (matches.length === 0) throw new HttpError(404, 'not found');
        const found = matches.find(({ candidate }) => candidate.method === request.method);
        if (found === undefined) throw new HttpError(405, 'method not allowed');
        const params: Params = {};
        found.candidate.keys.forEach((key, index) => {
          params[key] = found.match?.[index + 1] ?? '';
        });
        const result = await found.candidate.handler(request, url, params);
        sendJson(response, result.status ?? 200, result.body, headers);
        return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && options.staticDir !== undefined) {
        const file = await staticFile(options.staticDir, url.pathname);
        if (file !== undefined) {
          response.writeHead(200, { ...headers, 'content-type': file.type, 'content-length': file.body.length, 'cache-control': 'no-cache' });
          response.end(request.method === 'HEAD' ? undefined : file.body);
          return;
        }
      }
      throw new HttpError(404, 'not found');
    } catch (error) {
      const known = errorStatus(error);
      if (known === undefined) options.onError?.(error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      // The rest of an oversized body is not read: close instead of draining it.
      const close: Record<string, string> = known?.status === 413 ? { connection: 'close' } : {};
      sendJson(response, known?.status ?? 500, { error: known?.message ?? 'internal error' }, { ...headers, ...close });
    }
  }

  const server: Server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    void handle(request, response);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    socket.on('error', () => {
      socket.destroy();
    });
    const url = new URL(request.url ?? '/', 'http://upgrade');
    const check = checkRequest(
      { method: 'GET', host: request.headers.host, origin: request.headers.origin, contentType: undefined, upgrade: true },
      hosts,
    );
    if (url.pathname !== '/api/ws' || !check.ok) {
      socket.end(`HTTP/1.1 ${url.pathname === '/api/ws' ? '403 Forbidden' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void connect(ws, url.searchParams.get('after') ?? undefined);
    });
  });

  async function connect(ws: WebSocket, after: string | undefined): Promise<void> {
    sockets.add(ws);
    // An oversized or malformed frame is reported here; without a listener it would stop the process.
    ws.on('error', () => {
      ws.terminate();
    });
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_MS);
    // Nothing is accepted from the client: actions go through HTTP.
    ws.on('message', () => {
      ws.close(1008, 'read-only socket');
    });
    let stop: (() => void) | undefined;
    ws.on('close', () => {
      clearInterval(ping);
      sockets.delete(ws);
      stop?.();
    });
    const send = (message: LiveMessage | { type: 'ready' }): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.close(1013, 'too far behind');
        return;
      }
      ws.send(JSON.stringify(message));
    };
    try {
      stop = await live.subscribe({ send }, after);
      if (ws.readyState !== ws.OPEN) stop();
      // The backlog is out: from here on everything is live.
      else send({ type: 'ready' });
    } catch (error) {
      options.onError?.(error);
      ws.close(1011, 'internal error');
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  hosts = allowedHosts(options.host, port);

  return {
    port,
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    },
  };
}
