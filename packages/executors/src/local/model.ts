import { localEndpoint, LocalEndpointError, type LocalEndpoint } from './endpoint.ts';
import { StringDecoder } from 'node:string_decoder';

import { HttpBodyTooLarge, localRequest, localRequestStream } from './http.ts';

/**
 * The local model as the rest of Arianna sees it. The implementation talks to
 * OpenAI-compatible servers; replacing the runtime means writing another
 * `LocalModel`, not touching its callers.
 *
 * Message contents are the texts of an `allow` decision of the gateway
 * (`decision.texts`), never a new serialization of the original values.
 */
export interface LocalModel {
  chat(request: ChatRequest): Promise<ChatResult>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  /** Model alias from the configuration, e.g. "local-large". */
  model: string;
  messages: readonly ChatMessage[];
  /** JSON Schema for constrained decoding; the result then carries `value`. */
  schema?: { name: string; schema: Readonly<Record<string, unknown>> };
  maxTokens?: number;
  temperature?: number;
  /** Per endpoint attempt. Default 300 s: a large model on this hardware is slow. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * The text as the model writes it (D-070): the request is streamed and each
   * new piece comes here; the result still carries the whole text. Not with a
   * schema. Once a piece has come, a failing server is not replaced by the
   * next one: the caller already has part of an answer.
   */
  onText?: (piece: string) => void;
}

export interface ChatResult {
  text: string;
  /** The parsed JSON, present when the request had a schema. Not validated against it: that is the caller's job. */
  value?: unknown;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
  /** Endpoint that answered and model name used there. */
  endpoint: string;
  model: string;
  durationMs: number;
}

export type LocalModelErrorKind =
  | 'unavailable' // connection refused, reset, DNS: the server is not there
  | 'timeout'
  | 'cancelled' // the caller's signal
  | 'http' // non-2xx status
  | 'bad-response' // not the OpenAI shape, or not JSON when a schema was asked
  | 'no-endpoint'; // no configured endpoint serves the alias

/**
 * Messages carry status codes and endpoint ids only: a response body can echo
 * the prompt, which may be L2, and errors end up in logs and events.
 */
export class LocalModelError extends Error {
  override name = 'LocalModelError';
  readonly kind: LocalModelErrorKind;
  readonly endpoint: string | undefined;
  readonly status: number | undefined;
  /** One entry per endpoint tried, when the error comes from the fallback chain. */
  readonly attempts: readonly LocalModelError[];

  constructor(
    kind: LocalModelErrorKind,
    message: string,
    details: { endpoint?: string; status?: number; attempts?: readonly LocalModelError[] } = {},
  ) {
    super(message);
    this.kind = kind;
    this.endpoint = details.endpoint;
    this.status = details.status;
    this.attempts = details.attempts ?? [];
  }

  /** Worth trying the next endpoint: the server is down, stuck or failing. */
  get retryable(): boolean {
    return this.kind === 'unavailable' || this.kind === 'timeout' || (this.kind === 'http' && (this.status ?? 0) >= 500);
  }
}

const DEFAULT_TIMEOUT_MS = 300_000;

/** One call to one endpoint. */
async function chatOnce(endpoint: LocalEndpoint, request: ChatRequest): Promise<ChatResult> {
  const model = endpoint.models[request.model];
  if (model === undefined) {
    throw new LocalModelError('no-endpoint', `${endpoint.id} does not serve ${request.model}`, { endpoint: endpoint.id });
  }
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

  const body: Record<string, unknown> = {
    model,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    stream: request.onText !== undefined && request.schema === undefined,
  };
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.schema !== undefined) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: request.schema.name, schema: request.schema.schema, strict: true },
    };
  }

  const started = performance.now();
  if (body.stream === true && request.onText !== undefined) {
    const onText = request.onText;
    let result: Pick<ChatResult, 'text' | 'finishReason' | 'usage'>;
    try {
      result = await streamCompletion(endpoint, body, signal, onText);
    } catch (error) {
      throw toModelError(error, endpoint.id, request.signal, timeout);
    }
    return { ...result, endpoint: endpoint.id, model, durationMs: Math.round(performance.now() - started) };
  }
  let raw: unknown;
  try {
    const response = await localRequest(`${endpoint.url}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
    // Redirects are not followed: a 3xx is an error like any other non-2xx.
    if (response.status < 200 || response.status > 299) {
      throw new LocalModelError('http', `${endpoint.id} answered ${String(response.status)}`, {
        endpoint: endpoint.id,
        status: response.status,
      });
    }
    raw = JSON.parse(response.body) as unknown;
  } catch (error) {
    throw toModelError(error, endpoint.id, request.signal, timeout);
  }

  const result = parseCompletion(raw, endpoint.id, request.schema !== undefined);
  return { ...result, endpoint: endpoint.id, model, durationMs: Math.round(performance.now() - started) };
}

/** A streamed completion: server-sent events, one `data:` line per piece, then `[DONE]`. */
async function streamCompletion(
  endpoint: LocalEndpoint,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onText: (piece: string) => void,
): Promise<Pick<ChatResult, 'text' | 'finishReason' | 'usage'>> {
  const bad = (what: string) => new LocalModelError('bad-response', `${endpoint.id}: ${what}`, { endpoint: endpoint.id });
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let text = '';
  // Changed by the reader below, as the events come.
  let finishReason = 'unknown' as string;
  let usage: ChatResult['usage'];
  let done = false as boolean;

  const line = (raw: string): void => {
    const trimmed = raw.trim();
    if (done || !trimmed.startsWith('data:')) return;
    const data = trimmed.slice('data:'.length).trim();
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw bad('sent an event that is not JSON');
    }
    if (!isRecord(event)) throw bad('sent an event that is not an object');
    const choice = Array.isArray(event.choices) ? (event.choices[0] as unknown) : undefined;
    if (isRecord(choice)) {
      const delta = isRecord(choice.delta) ? choice.delta.content : undefined;
      if (typeof delta === 'string' && delta !== '') {
        text += delta;
        onText(delta);
      }
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    }
    const counts = event.usage;
    if (isRecord(counts) && typeof counts.prompt_tokens === 'number' && typeof counts.completion_tokens === 'number') {
      usage = { promptTokens: counts.prompt_tokens, completionTokens: counts.completion_tokens };
    }
  };

  const response = await localRequestStream(`${endpoint.url}/chat/completions`, { body: JSON.stringify(body), signal }, (chunk) => {
    pending += decoder.write(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const item of lines) line(item);
  });
  if (response.status < 200 || response.status > 299) {
    throw new LocalModelError('http', `${endpoint.id} answered ${String(response.status)}`, { endpoint: endpoint.id, status: response.status });
  }
  line(pending + decoder.end());
  if (!done && finishReason === 'unknown') throw bad('the stream ended early');
  return usage === undefined ? { text, finishReason } : { text, finishReason, usage };
}

function toModelError(
  error: unknown,
  endpoint: string,
  callerSignal: AbortSignal | undefined,
  timeout: AbortSignal,
): LocalModelError {
  if (error instanceof LocalModelError) return error;
  if (callerSignal?.aborted === true) return new LocalModelError('cancelled', `request to ${endpoint} cancelled`, { endpoint });
  if (timeout.aborted) return new LocalModelError('timeout', `${endpoint} did not answer in time`, { endpoint });
  if (error instanceof SyntaxError) return new LocalModelError('bad-response', `${endpoint} sent invalid JSON`, { endpoint });
  if (error instanceof HttpBodyTooLarge) return new LocalModelError('bad-response', `${endpoint}: ${error.message}`, { endpoint });
  // Connection refused or reset: only the code, the rest of the error is not ours to log.
  const code = (error as { code?: unknown } | null)?.code;
  const detail = typeof code === 'string' ? ` (${code})` : '';
  return new LocalModelError('unavailable', `${endpoint} is not reachable${detail}`, { endpoint });
}

function parseCompletion(
  raw: unknown,
  endpoint: string,
  wantsJson: boolean,
): Pick<ChatResult, 'text' | 'value' | 'finishReason' | 'usage'> {
  const bad = (what: string) => new LocalModelError('bad-response', `${endpoint}: ${what}`, { endpoint });
  const choice = isRecord(raw) && Array.isArray(raw.choices) ? (raw.choices[0] as unknown) : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  const text = isRecord(message) ? message.content : undefined;
  if (!isRecord(choice) || typeof text !== 'string') throw bad('no message content');

  const result: Pick<ChatResult, 'text' | 'value' | 'finishReason' | 'usage'> = {
    text,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown',
  };
  const usage = isRecord(raw) ? raw.usage : undefined;
  if (isRecord(usage) && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
    result.usage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
  }
  if (wantsJson) {
    try {
      result.value = JSON.parse(text) as unknown;
    } catch {
      throw bad('content is not JSON');
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface LocalModelOptions {
  /** In order of preference: the first is the main server, the others are fallbacks. */
  endpoints: readonly LocalEndpoint[];
  /** Health as seen by the watchdogs; endpoints reported down are tried last. */
  isAvailable?: (endpointId: string) => boolean;
  /** Told when an endpoint is unreachable or stuck, so its watchdog can act sooner. */
  onFailure?: (endpointId: string, error: LocalModelError) => void;
}

/**
 * The local model over one or more OpenAI-compatible endpoints: tries them in
 * order and moves to the next one when a server is down, stuck or failing.
 * Every endpoint is checked to be on this machine when the model is created.
 */
export function createLocalModel(options: LocalModelOptions): LocalModel {
  const endpoints = options.endpoints.map(localEndpoint);
  const ids = new Set<string>();
  for (const { id } of endpoints) {
    if (ids.has(id)) throw new LocalEndpointError(`duplicate endpoint id ${id}`);
    ids.add(id);
  }

  return {
    async chat(request) {
      const serving = endpoints.filter((endpoint) => endpoint.models[request.model] !== undefined);
      if (serving.length === 0) {
        throw new LocalModelError('no-endpoint', `no local endpoint serves ${request.model}`);
      }
      // Stable: available endpoints first, each group in configured order.
      const available = options.isAvailable ?? (() => true);
      const ordered = [...serving.filter((e) => available(e.id)), ...serving.filter((e) => !available(e.id))];

      // Once part of a streamed answer went out, another server would say it twice.
      let started = false as boolean;
      const onText = request.onText;
      const tracked: ChatRequest =
        onText === undefined
          ? request
          : {
              ...request,
              onText: (piece) => {
                started = true;
                onText(piece);
              },
            };
      const attempts: LocalModelError[] = [];
      for (const endpoint of ordered) {
        try {
          return await chatOnce(endpoint, tracked);
        } catch (error) {
          if (!(error instanceof LocalModelError)) throw error;
          if (error.kind === 'unavailable' || error.kind === 'timeout') options.onFailure?.(endpoint.id, error);
          if (!error.retryable || started) throw error;
          attempts.push(error);
        }
      }
      const last = attempts.at(-1);
      throw new LocalModelError(last?.kind ?? 'unavailable', `no local endpoint answered ${request.model}`, {
        attempts,
        ...(last?.status === undefined ? {} : { status: last.status }),
      });
    },
  };
}
