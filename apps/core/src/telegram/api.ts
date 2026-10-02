import http from 'node:http';
import https from 'node:https';

import type { Secret } from '@arianna/vault';

import { isCleared, type ClearedText } from './outgoing.ts';

/**
 * Client of the Telegram Bot API (task 1.15, D-044), without dependencies and
 * without `fetch`: dedicated agents never use a proxy from the environment,
 * and `request` never follows redirects. The token is revealed only to build
 * the path of each request; errors carry the method, the HTTP status and
 * Telegram's numeric code, never the URL or the body, which may quote text.
 */
export const TELEGRAM_API = 'https://api.telegram.org';

const AGENTS = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
/** getUpdates answers with at most 100 updates of at most 4096 characters each. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,100}$/;

export class TelegramApiError extends Error {
  override name = 'TelegramApiError';
  /** HTTP status; 0 when no answer arrived or it was not JSON. */
  readonly status: number;
  /** Seconds Telegram asks to wait (HTTP 429). */
  readonly retryAfter: number | undefined;

  constructor(method: string, status: number, retryAfter?: number) {
    super(`telegram ${method}: ${status === 0 ? 'no valid answer' : `HTTP ${String(status)}`}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }

  /** Worth retrying: network, server errors and rate limits. A 4xx will fail again. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface InlineButton {
  text: ClearedText;
  /** At most 64 bytes; ids only, never content. */
  data: string;
}

export interface BotApi {
  /** Raw updates from `offset` on, waiting up to `timeoutSeconds` (long polling). */
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<unknown[]>;
  /** Sends plain text (no parse mode) and returns the id of the message. */
  sendMessage(chatId: number, text: ClearedText, buttons?: readonly (readonly InlineButton[])[], signal?: AbortSignal): Promise<number>;
  answerCallbackQuery(callbackId: string, text?: ClearedText, signal?: AbortSignal): Promise<void>;
  /** Takes the buttons off a message, once its approval is decided. */
  removeButtons(chatId: number, messageId: number, signal?: AbortSignal): Promise<void>;
}

export interface BotApiOptions {
  token: Secret;
  /** Tests point it at a fake server on loopback; the core never sets it. */
  baseUrl?: string;
}

type Params = Record<string, unknown>;

function mustBeCleared(text: unknown): string {
  if (!isCleared(text)) throw new Error('telegram: the text did not pass the gateway');
  return text.text;
}

export function createBotApi(options: BotApiOptions): BotApi {
  const base = new URL(options.baseUrl ?? TELEGRAM_API);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1')) {
    throw new Error('telegram: the API must be https (plain http only for a fake server on 127.0.0.1)');
  }
  // Checked once, so that the value can only form the path segment it belongs to.
  if (!TOKEN.test(options.token.reveal())) throw new Error(`telegram: ${options.token.ref} is not a bot token`);

  function call(method: string, params: Params, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(`/bot${options.token.reveal()}/${method}`, base);
    const client = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(params);
    const abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal === undefined ? [] : [signal])]);
    return new Promise((resolve, reject) => {
      const fail = (status: number, retryAfter?: number): void => {
        reject(new TelegramApiError(method, status, retryAfter));
      };
      const request = client.request(
        url,
        {
          method: 'POST',
          agent: url.protocol === 'https:' ? AGENTS['https:'] : AGENTS['http:'],
          signal: abort,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              request.destroy();
              fail(0);
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => {
            fail(0);
          });
          response.on('end', () => {
            const status = response.statusCode ?? 0;
            let parsed: { ok?: unknown; result?: unknown; parameters?: { retry_after?: unknown } } | undefined;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof parsed;
            } catch {
              parsed = undefined;
            }
            if (status === 200 && parsed?.ok === true) {
              resolve(parsed.result);
              return;
            }
            const retryAfter = parsed?.parameters?.retry_after;
            fail(status === 200 ? 0 : status, typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter : undefined);
          });
        },
      );
      // A network error message may name the host, never the path: still, report only the method.
      request.on('error', () => {
        fail(0);
      });
      request.end(body);
    });
  }

  return {
    async getUpdates(offset, timeoutSeconds, signal) {
      const result = await call(
        'getUpdates',
        { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] },
        timeoutSeconds * 1000 + REQUEST_TIMEOUT_MS,
        signal,
      );
      if (!Array.isArray(result)) throw new TelegramApiError('getUpdates', 0);
      return result as unknown[];
    },
    async sendMessage(chatId, text, buttons, signal) {
      const params: Params = { chat_id: chatId, text: mustBeCleared(text), link_preview_options: { is_disabled: true } };
      if (buttons !== undefined) {
        params.reply_markup = {
          inline_keyboard: buttons.map((row) => row.map((button) => ({ text: mustBeCleared(button.text), callback_data: button.data }))),
        };
      }
      const result = (await call('sendMessage', params, REQUEST_TIMEOUT_MS, signal)) as { message_id?: unknown } | null;
      const id = result?.message_id;
      if (typeof id !== 'number') throw new TelegramApiError('sendMessage', 0);
      return id;
    },
    async answerCallbackQuery(callbackId, text, signal) {
      const params = { callback_query_id: callbackId, ...(text === undefined ? {} : { text: mustBeCleared(text) }) };
      await call('answerCallbackQuery', params, REQUEST_TIMEOUT_MS, signal);
    },
    async removeButtons(chatId, messageId, signal) {
      const params = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };
      await call('editMessageReplyMarkup', params, REQUEST_TIMEOUT_MS, signal);
    },
  };
}
