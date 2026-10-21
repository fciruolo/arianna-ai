import type { ConnectOverCDPTransport } from 'playwright-core';

import { BrowserError, CDP_SOCKET } from './container.ts';
import type { Channel, OpenChannel } from './channel.ts';

/**
 * CDP of the agent's browser (D-264) without any port: Chromium runs with
 * --remote-debugging-pipe, socat joins its pipe to /tmp/cdp.sock, and the core
 * reaches that socket through the docker exec channel. On the pipe each
 * message is one JSON text ended by NUL. One session per container: socat
 * accepts one connection, and when it ends the container ends.
 */

/** A message larger than this closes the pipe: a screenshot in base64 is a few MB. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Id of the readiness request, before Playwright, whose ids start at 1. */
const READY_ID = 0;

export class CdpPipe {
  readonly #channel: Channel;
  #buffer: Buffer = Buffer.alloc(0);
  #closed = false;
  readonly #whenClosed: Promise<void>;
  #resolveClosed: () => void = () => undefined;
  onmessage: ((message: Record<string, unknown>) => void) | undefined;

  constructor(channel: Channel) {
    this.#channel = channel;
    this.#whenClosed = new Promise((resolve) => { this.#resolveClosed = resolve; });
    channel.stream.on('data', (chunk: Buffer) => { this.#read(chunk); });
    channel.stream.on('close', () => { this.close(); });
    channel.stream.on('error', () => { this.close(); });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Resolves once, when the pipe closes from either side. */
  get whenClosed(): Promise<void> {
    return this.#whenClosed;
  }

  send(message: object): void {
    if (this.#closed) return;
    this.#channel.stream.write(`${JSON.stringify(message)}\0`);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel.close();
    this.#resolveClosed();
  }

  #read(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (let end = this.#buffer.indexOf(0); end >= 0 && !this.#closed; end = this.#buffer.indexOf(0)) {
      const text = this.#buffer.subarray(0, end).toString('utf8');
      this.#buffer = this.#buffer.subarray(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof message === 'object' && message !== null && !Array.isArray(message)) this.onmessage?.(message as Record<string, unknown>);
    }
    if (this.#buffer.length > MAX_MESSAGE_BYTES) this.close();
  }
}

export interface WaitOptions {
  /** Ceiling for the whole wait: then the channel is closed and the wait fails. */
  timeoutMs: number;
  pauseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Attempt = 'ready' | 'closed' | 'timeout';

/**
 * Waits until Chromium answers Browser.getVersion on the CDP socket and
 * returns that pipe, still open: it is the one session of the container.
 * A channel that closes (socket not there yet) is tried again; one that
 * stays silent until the ceiling is closed by a timer of its own.
 */
export async function waitForCdp(open: OpenChannel, container: string, options: WaitOptions): Promise<CdpPipe> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;
  const fail = (): BrowserError => new BrowserError('cdp-timeout', `CDP of the browser did not answer within ${String(Math.round(options.timeoutMs / 1000))} s`);
  for (;;) {
    const left = deadline - now();
    if (left <= 0) throw fail();
    const pipe = new CdpPipe(open(container, CDP_SOCKET));
    const attempt = await new Promise<Attempt>((resolve) => {
      const timer = setTimeout(() => { resolve('timeout'); }, left);
      pipe.onmessage = (message) => {
        const result = message.result as { product?: unknown } | undefined;
        if (message.id === READY_ID && typeof result?.product === 'string' && result.product.startsWith('Chrome/')) {
          clearTimeout(timer);
          resolve('ready');
        }
      };
      void pipe.whenClosed.then(() => {
        clearTimeout(timer);
        resolve('closed');
      });
      pipe.send({ id: READY_ID, method: 'Browser.getVersion' });
    });
    pipe.onmessage = undefined;
    if (attempt === 'ready' && !pipe.closed) return pipe;
    pipe.close();
    if (attempt === 'timeout') throw fail();
    await sleep(options.pauseMs ?? 100);
  }
}

/** The pipe as the transport of `chromium.connectOverCDP`. */
export function cdpTransport(pipe: CdpPipe): ConnectOverCDPTransport {
  const transport: ConnectOverCDPTransport = {
    send(message: object) {
      pipe.send(message);
    },
    close() {
      pipe.close();
    },
  };
  pipe.onmessage = (message) => { transport.onmessage?.(message); };
  void pipe.whenClosed.then(() => { transport.onclose?.('closed'); });
  return transport;
}
