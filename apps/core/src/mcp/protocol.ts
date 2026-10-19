/**
 * The JSON-RPC 2.0 of MCP as Arianna's server speaks it (D-261), written by
 * hand: no SDK, no dependency. One message per POST, answered with plain
 * `application/json`: no batches, no SSE, no server-initiated requests. The
 * server only lists and calls tools; everything else is "method not found".
 * Pure: the HTTP side (server.ts) passes the body text and writes the reply.
 */

/** Protocol versions this server answers with as asked; any other gets DEFAULT_VERSION. */
export const SUPPORTED_VERSIONS: readonly string[] = ['2025-03-26', '2025-06-18', '2025-11-25'];
export const DEFAULT_VERSION = '2025-06-18';
/** Largest body of a POST: a tool call of ours is a few hundred bytes. */
export const MAX_BODY = 16 * 1024;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A tool as `tools/list` shows it. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What `tools/call` returns: text only. */
export interface McpCallResult {
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

export interface McpHandlers {
  /** The tools of this session alone. */
  listTools(): readonly McpToolDescriptor[];
  /** Undefined when the session has no such tool. Must not throw: errors are results with a fixed text. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult | undefined>;
}

export interface ServerInfo {
  name: string;
  version: string;
}

/** 200 with a response, 202 without a body (a notification or a response of the client), 400 for what is no message. */
export type McpReply = { status: 200 | 400; body: JsonRpcResponse } | { status: 202 };

function failure(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The version the server answers `initialize` with: the client's when supported. */
export function negotiateVersion(asked: unknown): string {
  return typeof asked === 'string' && SUPPORTED_VERSIONS.includes(asked) ? asked : DEFAULT_VERSION;
}

/**
 * Answers one message. Messages are not trusted: a malformed one is an error
 * with a fixed message, never an echo of what was sent. Error messages name
 * the rule only.
 */
export async function handleMessage(body: string, handlers: McpHandlers, info: ServerInfo): Promise<McpReply> {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return { status: 400, body: failure(null, PARSE_ERROR, 'Parse error') };
  }
  if (Array.isArray(message)) return { status: 400, body: failure(null, INVALID_REQUEST, 'Batches are not supported') };
  if (!isPlainObject(message) || message.jsonrpc !== '2.0') return { status: 400, body: failure(null, INVALID_REQUEST, 'Invalid request') };

  // A notification, or a response of the client to nothing we asked: accepted, not answered.
  if (!('id' in message)) {
    return typeof message.method === 'string' ? { status: 202 } : { status: 400, body: failure(null, INVALID_REQUEST, 'Invalid request') };
  }
  if (typeof message.method !== 'string') {
    return 'result' in message || 'error' in message ? { status: 202 } : { status: 400, body: failure(null, INVALID_REQUEST, 'Invalid request') };
  }
  const id = message.id;
  if (!(typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)))) return { status: 400, body: failure(null, INVALID_REQUEST, 'Invalid request') };
  const params = message.params === undefined ? {} : message.params;
  if (!isPlainObject(params)) return { status: 200, body: failure(id, INVALID_PARAMS, 'Invalid params') };

  const ok = (result: unknown): McpReply => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  switch (message.method) {
    case 'initialize':
      return ok({ protocolVersion: negotiateVersion(params.protocolVersion), capabilities: { tools: {} }, serverInfo: { name: info.name, version: info.version } });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: handlers.listTools() });
    case 'tools/call': {
      const args = params.arguments === undefined ? {} : params.arguments;
      if (typeof params.name !== 'string' || !isPlainObject(args)) return { status: 200, body: failure(id, INVALID_PARAMS, 'Invalid params') };
      const result = await handlers.callTool(params.name, args);
      return result === undefined ? { status: 200, body: failure(id, INVALID_PARAMS, 'Unknown tool') } : ok(result);
    }
    default:
      return { status: 200, body: failure(id, METHOD_NOT_FOUND, 'Method not found') };
  }
}
