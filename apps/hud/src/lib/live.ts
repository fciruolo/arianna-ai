import { laterId, parseServerMessage, type ServerMessage } from './protocol.ts';

/**
 * The connection to the core's WebSocket, with reconnection. On reconnecting
 * it asks for the events after the last one seen, so nothing is lost while
 * the core restarts. Socket and timers are injected: the tests drive them.
 */
export type LiveState = 'connecting' | 'open' | 'closed';

/** The part of a browser WebSocket this module uses. */
export interface SocketLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface LiveOptions {
  /** Base URL of the socket, e.g. ws://127.0.0.1:7420/api/ws. */
  url: string;
  onMessage(message: ServerMessage): void;
  onState(state: LiveState): void;
  createSocket(url: string): SocketLike;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Random number in [0, 1), for jitter. */
  random(): number;
}

export interface LiveConnection {
  /** Id of the last event received, sent back on reconnection. */
  lastEventId(): string | undefined;
  close(): void;
}

const BASE_MS = 500;
const MAX_MS = 15_000;

/** Exponential backoff with up to 30% jitter, capped. */
export function reconnectDelay(attempt: number, random: number): number {
  const exponential = Math.min(MAX_MS, BASE_MS * 2 ** Math.min(attempt, 10));
  return Math.round(exponential * (1 - 0.3 * random));
}

export function connectLive(options: LiveOptions): LiveConnection {
  let lastId: string | undefined;
  let attempt = 0;
  let socket: SocketLike | undefined;
  let timer: unknown;
  let stopped = false;

  function open(): void {
    options.onState('connecting');
    const url = lastId === undefined ? options.url : `${options.url}?after=${lastId}`;
    const current = options.createSocket(url);
    socket = current;
    current.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (message === undefined) return;
      if (message.type === 'event') lastId = laterId(lastId, message.event.id);
      if (message.type === 'ready') {
        attempt = 0;
        options.onState('open');
      }
      options.onMessage(message);
    };
    current.onerror = () => {
      current.close();
    };
    current.onclose = () => {
      if (socket !== current) return;
      socket = undefined;
      options.onState('closed');
      if (stopped) return;
      timer = options.setTimer(open, reconnectDelay(attempt, options.random()));
      attempt += 1;
    };
  }

  open();
  return {
    lastEventId: () => lastId,
    close() {
      stopped = true;
      options.clearTimer(timer);
      const current = socket;
      socket = undefined;
      current?.close();
      options.onState('closed');
    },
  };
}
