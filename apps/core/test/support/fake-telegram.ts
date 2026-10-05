import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake Telegram Bot API on loopback (D-044: no real bot in development).
 * It records every call, hands out queued updates to getUpdates (long polling
 * included) and can be told to fail the next call of a method.
 */
export interface FakeCall {
  method: string;
  /** The token as it arrived in the path. */
  token: string;
  body: Record<string, unknown>;
}

export interface FakeTelegram {
  readonly url: string;
  readonly calls: FakeCall[];
  /**
   * Queues an update; its update_id is assigned in order, or `id` (as after a
   * week without updates, when Telegram may restart the ids). Returns the id.
   */
  push(update: Record<string, unknown>, id?: number): number;
  /**
   * The next call of `method` answers with this HTTP status (and retry_after
   * for 429). With `match`, only the next call whose JSON body contains it:
   * a call left over from an earlier test does not take the failure.
   */
  failNext(method: string, status: number, retryAfter?: number, match?: string): void;
  sent(): FakeCall[];
  close(): Promise<void>;
}

/** Telegram's message to the bot from a private chat. */
export function privateMessage(chatId: number, text: string | undefined): Record<string, unknown> {
  return {
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Fake' },
      ...(text === undefined ? { photo: [] } : { text }),
    },
  };
}

export function buttonPress(fromId: number, data: string, chatId: number = fromId, messageId = 7): Record<string, unknown> {
  return {
    callback_query: {
      id: `cb-${String(Math.random()).slice(2)}`,
      from: { id: fromId, is_bot: false, first_name: 'Fake' },
      message: { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } },
      data,
    },
  };
}

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const calls: FakeCall[] = [];
  const updates: Record<string, unknown>[] = [];
  const failures = new Map<string, { status: number; retryAfter?: number; match?: string }>();
  const waiting = new Set<() => void>();
  let nextUpdate = 1;
  let nextMessage = 100;

  function reply(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    response.end(text);
  }

  async function read(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  }

  const server = createServer((request, response) => {
    void (async () => {
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(request.url ?? '');
      if (match === null || request.method !== 'POST') {
        reply(response, 404, { ok: false, error_code: 404, description: 'Not Found' });
        return;
      }
      const [, token = '', method = ''] = match;
      const body = await read(request);
      calls.push({ method, token, body });
      const failure = failures.get(method);
      if (failure !== undefined && (failure.match === undefined || JSON.stringify(body).includes(failure.match))) {
        failures.delete(method);
        reply(response, failure.status, {
          ok: false,
          error_code: failure.status,
          description: `fake failure quoting ${JSON.stringify(body)}`,
          ...(failure.retryAfter === undefined ? {} : { parameters: { retry_after: failure.retryAfter } }),
        });
        return;
      }
      switch (method) {
        case 'getUpdates': {
          const offset = typeof body.offset === 'number' ? body.offset : 0;
          // As on Telegram: an offset confirms, and forgets, every update below it.
          if (offset > 0) {
            for (let index = updates.length - 1; index >= 0; index -= 1) {
              if ((updates[index]?.update_id as number) < offset) updates.splice(index, 1);
            }
          }
          const timeout = typeof body.timeout === 'number' ? body.timeout : 0;
          const ready = (): Record<string, unknown>[] => updates.filter((update) => (update.update_id as number) >= offset);
          if (ready().length === 0 && timeout > 0) {
            await new Promise<void>((resolve) => {
              const done = (): void => {
                clearTimeout(timer);
                waiting.delete(done);
                resolve();
              };
              const timer = setTimeout(done, timeout * 1000);
              waiting.add(done);
              request.once('close', done);
            });
          }
          if (!response.writableEnded && !response.destroyed) reply(response, 200, { ok: true, result: ready() });
          return;
        }
        case 'sendMessage':
          nextMessage += 1;
          reply(response, 200, { ok: true, result: { message_id: nextMessage, chat: { id: body.chat_id }, text: body.text } });
          return;
        case 'answerCallbackQuery':
        case 'editMessageReplyMarkup':
          reply(response, 200, { ok: true, result: true });
          return;
        default:
          reply(response, 404, { ok: false, error_code: 404, description: 'Not Found' });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    calls,
    push(update, explicit) {
      const id = explicit ?? nextUpdate;
      nextUpdate = id + 1;
      updates.push({ update_id: id, ...update });
      for (const done of [...waiting]) done();
      return id;
    },
    failNext(method, status, retryAfter, match) {
      failures.set(method, { status, ...(retryAfter === undefined ? {} : { retryAfter }), ...(match === undefined ? {} : { match }) });
    },
    sent() {
      return calls.filter((call) => call.method === 'sendMessage');
    },
    async close() {
      for (const done of [...waiting]) done();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** Waits until `check` returns something truthy, or fails after `ms`. */
export async function eventually<T>(check: () => T | Promise<T>, ms = 5_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value: unknown = await check();
    if (value !== undefined && value !== null && value !== false) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error('eventually: timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
