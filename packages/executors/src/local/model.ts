import { localEndpoint, LocalEndpointError, type LocalEndpoint } from './endpoint.ts';
import { StringDecoder } from 'node:string_decoder';

import { HttpBodyTooLarge, localRequest, localRequestStream } from './http.ts';
import { authorization } from './key.ts';

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
  /**
   * Asks every server that serves `alias` to drop it from memory (D-074: the
   * model of the calls outside a call); the next request loads it again.
   * Skips servers reported down and a model another alias of the same
   * server also uses. Best effort, never throws: true when a server unloaded it.
   */
  unload?(alias: string): Promise<boolean>;
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
   * new piece comes here; the result still carries the whole text. With a
   * schema too (D-199: a trial of a model times its first word), the JSON is
   * parsed once the stream ends. Once a piece has come, a failing server is
   * not replaced by the next one: the caller already has part of an answer.
   */
  onText?: (piece: string) => void;
  /**
   * With `onText`: asks the server for the token counts at the end of the
   * stream (OpenAI `stream_options.include_usage`, D-199). A server that
   * does not send them leaves `usage` absent.
   */
  streamUsage?: boolean;
}

export interface ChatResult {
  text: string;
  /** The parsed JSON, present when the request had a schema. Not validated against it: that is the caller's job. */
  value?: unknown;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
  /** Streamed requests only: ms from the request to the first piece of text (D-199). */
  firstTextMs?: number;
  /**
   * Streamed requests only: ms from the request to the first token of any
   * kind, the reasoning a server sends apart (`reasoning_content`) included:
   * where the writing starts, for the tokens per second (D-199).
   */
  firstTokenMs?: number;
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

/** Unloading waits for the memory to settle on the server: seconds, not minutes. */
const UNLOAD_TIMEOUT_MS = 30_000;

/** One call to one endpoint. */
async function chatOnce(endpoint: LocalEndpoint, request: ChatRequest, headers: Record<string, string>): Promise<ChatResult> {
  const model = endpoint.models[request.model];
  if (model === undefined) {
    throw new LocalModelError('no-endpoint', `${endpoint.id} does not serve ${request.model}`, { endpoint: endpoint.id });
  }
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

  const body: Record<string, unknown> = {
    model,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    stream: request.onText !== undefined,
  };
  if (body.stream === true && request.streamUsage === true) body.stream_options = { include_usage: true };
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
    const given = request.onText;
    let firstTextMs: number | undefined;
    let firstTokenMs: number | undefined;
    const onText = (piece: string): void => {
      firstTextMs ??= Math.round(performance.now() - started);
      given(piece);
    };
    const onToken = (): void => {
      firstTokenMs ??= Math.round(performance.now() - started);
    };
    let result: Pick<ChatResult, 'text' | 'finishReason' | 'usage'>;
    try {
      result = await streamCompletion(endpoint, body, signal, headers, onText, onToken);
    } catch (error) {
      throw toModelError(error, endpoint.id, request.signal, timeout);
    }
    const streamed: ChatResult = { ...result, endpoint: endpoint.id, model, durationMs: Math.round(performance.now() - started) };
    if (firstTextMs !== undefined) streamed.firstTextMs = firstTextMs;
    if (firstTokenMs !== undefined) streamed.firstTokenMs = firstTokenMs;
    if (request.schema !== undefined) {
      try {
        streamed.value = JSON.parse(result.text) as unknown;
      } catch {
        throw new LocalModelError('bad-response', `${endpoint.id}: content is not JSON`, { endpoint: endpoint.id });
      }
    }
    return streamed;
  }
  let raw: unknown;
  try {
    const response = await localRequest(`${endpoint.url}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
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
  headers: Record<string, string>,
  onText: (piece: string) => void,
  onToken: () => void = () => undefined,
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
      // The reasoning a server sends apart counts as written tokens too (usage counts it).
      const reasoning = isRecord(choice.delta) ? (choice.delta.reasoning_content ?? choice.delta.reasoning) : undefined;
      if ((typeof delta === 'string' && delta !== '') || (typeof reasoning === 'string' && reasoning !== '')) onToken();
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

  const response = await localRequestStream(`${endpoint.url}/chat/completions`, { body: JSON.stringify(body), signal, headers }, (chunk) => {
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
  /**
   * The key each endpoint asks for (D-221, `localKeys`), sent as
   * `Authorization: Bearer`; none for an endpoint without one.
   */
  apiKey?: (endpointId: string) => string | undefined;
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
          return await chatOnce(endpoint, tracked, authorization(options.apiKey?.(endpoint.id)));
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

    async unload(alias) {
      let unloaded = false;
      const available = options.isAvailable ?? (() => true);
      for (const endpoint of endpoints) {
        const name = endpoint.models[alias];
        if (name === undefined || !available(endpoint.id)) continue;
        // Another role on the same model (voice and extractor may share one): it stays.
        if (Object.entries(endpoint.models).some(([other, model]) => other !== alias && model === name)) continue;
        try {
          // oMLX: 200 once unloaded, 400 when it was not loaded, 404 for a name it does not know
          // (a name with "/" too: FastAPI decodes %2F before routing; catalog ids have none).
          const response = await localRequest(`${endpoint.url}/models/${encodeURIComponent(name)}/unload`, {
            method: 'POST',
            signal: AbortSignal.timeout(UNLOAD_TIMEOUT_MS),
            headers: authorization(options.apiKey?.(endpoint.id)),
          });
          if (response.status === 200) unloaded = true;
        } catch {
          // A server that is down holds nothing.
        }
      }
      return unloaded;
    },
  };
}
