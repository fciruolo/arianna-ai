import type { Socket } from 'node:net';

import type { ConnectOverCDPTransport } from 'playwright-core';
import WebSocket from 'ws';

import { CDP_PORT } from './container.ts';
import type { Channel } from './channel.ts';

/**
 * The CDP connection of playwright-core (D-264) without any port on the Mac:
 * `chromium.connectOverCDP` accepts a transport object, and this one is a
 * WebSocket of `ws` whose socket is the `docker exec … socat` channel. The
 * Host header is the one of the URL, 127.0.0.1:9222, as Chromium wants.
 * A bridge on 127.0.0.1 with a token, as first planned, would be one more
 * door for any program of the Mac to knock on: here there is none.
 */

const DEVTOOLS_PATH = /^\/devtools\/browser\/[0-9a-f-]{36}$/;

export interface CdpTransport extends ConnectOverCDPTransport {
  /** Resolves when the WebSocket is open, rejects when it fails first. */
  ready: Promise<void>;
}

export function cdpTransport(path: string, channel: Channel): CdpTransport {
  if (!DEVTOOLS_PATH.test(path)) throw new Error('not a CDP browser path');
  const socket = new WebSocket(`ws://127.0.0.1:${String(CDP_PORT)}${path}`, {
    createConnection: () => channel.stream as unknown as Socket,
    perMessageDeflate: false,
    // A screenshot of 1280x800 in base64 is a few MB: 64 MB leaves room, and bounds a hostile message.
    maxPayload: 64 * 1024 * 1024,
    handshakeTimeout: 10_000,
  });
  const ready = new Promise<void>((resolve, reject) => {
    socket.once('open', () => { resolve(); });
    socket.once('error', (error) => { reject(error); });
  });
  // A rejection nobody waits for must not stop the core.
  ready.catch(() => undefined);
  const transport: CdpTransport = {
    ready,
    send(message: object) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
      channel.close();
    },
  };
  socket.on('message', (data: WebSocket.RawData) => {
    let message: unknown;
    try {
      message = JSON.parse(rawText(data));
    } catch {
      return;
    }
    if (typeof message === 'object' && message !== null) transport.onmessage?.(message);
  });
  socket.on('close', () => {
    channel.close();
    transport.onclose?.('closed');
  });
  socket.on('error', () => { channel.close(); });
  return transport;
}

function rawText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
