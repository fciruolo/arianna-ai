// A minimal MCP server for the canary (D-261): the evals cannot import the
// core, so this stands in for Arianna's server on 127.0.0.1, with the same
// shape a run sees (JSON-RPC over one POST, a Bearer token, `kb_search` and
// `kb_read`) and nothing behind it: every call answers a fixed text. The
// canary is about the profile of a run that has a server (no `--safe-mode`),
// and about the token, which must never come back in the transcript.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const TOOLS = [
  { name: 'kb_search', description: 'Search the notes.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'kb_read', description: 'Read one note by its path.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
] as const;
const ANSWER = 'No pages match.';
const MAX_BODY = 16 * 1024;

export interface FakeMcp {
  url: string;
  /** The Bearer token of the run: 32 random bytes, base64url, as the core's. */
  token: string;
  /** `tools/call` received with the right token. */
  calls(): number;
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeMcp(): Promise<FakeMcp> {
  const token = randomBytes(32).toString('base64url');
  let calls = 0;
  /** The status and body of one request. */
  async function reply(request: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    if (request.url !== '/mcp') return { status: 404 };
    if (request.method !== 'POST') return { status: 405 };
    if (request.headers.authorization !== `Bearer ${token}`) return { status: 401 };
    const body = await readBody(request);
    if (body === undefined) return { status: 413 };
    let message: { id?: unknown; method?: unknown; params?: { protocolVersion?: unknown } };
    try {
      message = JSON.parse(body) as typeof message;
    } catch {
      return { status: 400 };
    }
    // A notification, or a response of the client: accepted, not answered.
    if (message.id === undefined || typeof message.method !== 'string') return { status: 202 };
    const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: '2.0', id: message.id, result } });
    switch (message.method) {
      case 'initialize':
        return ok({ protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'arianna', version: '0.0.0-canary' } });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call':
        calls += 1;
        return ok({ content: [{ type: 'text', text: ANSWER }], isError: false });
      default:
        return { status: 200, body: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } } };
    }
  }

  const server = createServer((request, response) => {
    reply(request).then(
      ({ status, body }) => {
        send(response, status, body);
      },
      () => {
        if (!response.headersSent) send(response, 500);
      },
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    token,
    calls: () => calls,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}
