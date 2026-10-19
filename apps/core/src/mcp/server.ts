import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { isAtMost, isLabel, MCP_CEILING } from '@arianna/policy';

import { handleMessage, MAX_BODY, type ServerInfo } from './protocol.ts';
import { callTool, isMcpToolName, toolDescriptors, type McpSessionInput, type McpToolDeps, type RunUsage } from './tools.ts';

/**
 * Arianna's MCP server (D-261): the few read-only tools of tools.ts for an
 * agent in the cloud while it runs, over Streamable HTTP without streams.
 * Its own listener on 127.0.0.1 with a port the system picks, apart from the
 * API: nothing of the API is reachable with a run's token, and nothing here
 * with a session of the web chat. The core opens one session per run before
 * starting it (`open`), hands the run the URL and the token (through the MCP
 * configuration of `@arianna/executors`), and revokes it when the run ends.
 *
 * Every request names this listener in Host (DNS rebinding) and carries no
 * Origin (no web page talks to it); then a bearer token of that run. Tokens
 * live in memory only, as their sha256: a restart of the core revokes them all.
 */
export interface McpServer {
  start(): Promise<{ url: string }>;
  open(session: McpSessionInput): { token: string };
  revoke(runId: string): void;
  /** Revokes every session and stops the listener. */
  close(): Promise<void>;
}

export interface McpServerDeps extends McpToolDeps {
  /** Arianna's version, in `serverInfo`. */
  version: string;
  now?: () => Date;
}

export class McpSessionError extends Error {
  override name = 'McpSessionError';
}

/** The path of the endpoint; any other answers 404, the OAuth discovery paths included. */
export const MCP_PATH = '/mcp';
const TOKEN_BYTES = 32;
/** Messages of one session, of any method (initialize, ping, tools/list, tools/call); past it 429. */
export const MAX_MESSAGES = 100;

interface OpenSession {
  input: McpSessionInput;
  hash: Buffer;
  usage: RunUsage;
  messages: number;
}

function hashOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (body === undefined) {
    response.writeHead(status, headers).end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text, 'utf8')) }).end(text);
}

/** The body, or undefined past MAX_BODY (the request is not read further). */
async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function checkInput(input: McpSessionInput): void {
  if (typeof input.runId !== 'string' || input.runId === '' || typeof input.taskId !== 'string' || input.taskId === '' || typeof input.agent !== 'string' || input.agent === '') {
    throw new McpSessionError('a session needs its run, task and agent');
  }
  if ((input.executor as string) !== 'claude') throw new McpSessionError('only claude runs have MCP sessions');
  if (!isLabel(input.clearance) || !isAtMost(input.clearance, MCP_CEILING)) throw new McpSessionError('the clearance of an MCP session is at most L1');
  if (!Array.isArray(input.tools) || !input.tools.every(isMcpToolName)) throw new McpSessionError('unknown MCP tool');
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) throw new McpSessionError('a session needs an expiry');
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const now = deps.now ?? (() => new Date());
  const info: ServerInfo = { name: 'arianna', version: deps.version };
  const sessions = new Map<string, OpenSession>();
  let host: string | undefined;

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500);
      else response.destroy();
    });
  });

  /** Forgets every expired session: a run that ended without its revoke leaves no token behind. */
  function prune(): void {
    const at = now().getTime();
    for (const [runId, session] of sessions) {
      if (session.input.expiresAt.getTime() <= at) sessions.delete(runId);
    }
  }

  /** The open, unexpired session of this bearer token; constant time on the hash. */
  function sessionOf(header: string | undefined): OpenSession | undefined {
    prune();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '');
    if (match?.[1] === undefined) return undefined;
    const hash = hashOf(match[1]);
    let found: OpenSession | undefined;
    for (const session of sessions.values()) {
      if (timingSafeEqual(session.hash, hash)) found = session;
    }
    return found;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // No web page talks to this server, and only this listener's own name is accepted.
    if (request.headers.origin !== undefined || host === undefined || request.headers.host?.toLowerCase() !== host) {
      send(response, 403);
      return;
    }
    const path = (request.url ?? '').split('?', 1)[0];
    if (path !== MCP_PATH) {
      send(response, 404);
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      send(response, 405);
      return;
    }
    const session = sessionOf(request.headers.authorization);
    if (session === undefined) {
      send(response, 401);
      return;
    }
    session.messages += 1;
    if (session.messages > MAX_MESSAGES) {
      send(response, 429);
      request.resume();
      return;
    }
    const body = await readBody(request);
    if (body === undefined) {
      send(response, 413);
      request.resume();
      return;
    }
    const input = session.input;
    const reply = await handleMessage(
      body,
      {
        listTools: () => toolDescriptors(input.tools),
        // Revoked or expired while the call was on its way: nothing more for this run.
        callTool: (name, args) => (sessions.get(input.runId) === session && input.expiresAt.getTime() > now().getTime() ? callTool(input, session.usage, name, args, deps) : Promise.resolve(undefined)),
      },
      info,
    );
    if (reply.status === 202) send(response, 202);
    else send(response, reply.status, reply.body);
  }

  return {
    async start() {
      if (host !== undefined) throw new McpSessionError('the MCP server is already started');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          // A later error of the listener (a socket) must not stop the core: the runs' calls fail, nothing else.
          server.on('error', () => undefined);
          resolve();
        });
      });
      const { port } = server.address() as AddressInfo;
      host = `127.0.0.1:${String(port)}`;
      return { url: `http://${host}${MCP_PATH}` };
    },
    open(input) {
      // Not started (or closed): a run gets no token for a server nobody answers on.
      if (host === undefined) throw new McpSessionError('the MCP server is not started');
      checkInput(input);
      prune();
      if (sessions.has(input.runId)) throw new McpSessionError('this run already has an MCP session');
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      sessions.set(input.runId, { input: Object.freeze({ ...input, tools: Object.freeze([...input.tools]) }), hash: hashOf(token), usage: { calls: 0, bytes: 0 }, messages: 0 });
      return { token };
    },
    revoke(runId) {
      sessions.delete(runId);
    },
    async close() {
      sessions.clear();
      if (host === undefined) return;
      host = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
