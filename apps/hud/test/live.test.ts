import assert from 'node:assert/strict';
import { test } from 'node:test';

import { connectLive, reconnectDelay, type LiveState, type SocketLike } from '../src/lib/live.ts';
import { laterId, parseServerMessage, type ServerMessage } from '../src/lib/protocol.ts';

test('frames are parsed, and malformed ones dropped', () => {
  assert.deepEqual(parseServerMessage('{"type":"ready"}'), { type: 'ready' });
  const delta = parseServerMessage('{"type":"delta","replyId":"r","conversationId":"c","taskId":"t","seq":0,"text":"x"}');
  assert.equal(delta?.type, 'delta');
  const event = parseServerMessage('{"type":"event","event":{"id":"12","kind":"task.status","label":"L0","payload":{"to":"done"}}}');
  assert.deepEqual(event?.type === 'event' ? [event.event.id, event.event.label, event.event.payload] : undefined, ['12', 'L0', { to: 'done' }]);
  for (const raw of [
    'not json',
    '[]',
    '{"type":"other"}',
    '{"type":"delta","replyId":"r","conversationId":"c","taskId":"t","seq":-1,"text":"x"}',
    '{"type":"event","event":{"id":"12; DROP","kind":"x"}}',
    '{"type":"event","event":{"id":"1"}}',
  ]) {
    assert.equal(parseServerMessage(raw), undefined, raw);
  }
  // An unknown label is read as L2.
  const unlabeled = parseServerMessage('{"type":"event","event":{"id":"1","kind":"x","label":"L9"}}');
  assert.equal(unlabeled?.type === 'event' ? unlabeled.event.label : undefined, 'L2');
});

test('event ids compare as numbers, not text', () => {
  assert.equal(laterId('9', '10'), '10');
  assert.equal(laterId('10', '9'), '10');
  assert.equal(laterId(undefined, '1'), '1');
});

test('reconnection backs off exponentially, with jitter, up to a cap', () => {
  assert.equal(reconnectDelay(0, 0), 500);
  assert.equal(reconnectDelay(1, 0), 1000);
  assert.equal(reconnectDelay(3, 0), 4000);
  assert.equal(reconnectDelay(50, 0), 15000);
  assert.equal(reconnectDelay(0, 1), 350);
});

class FakeSocket implements SocketLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

test('after a drop it reconnects from the last event seen', () => {
  const sockets: FakeSocket[] = [];
  const timers: (() => void)[] = [];
  const states: LiveState[] = [];
  const received: ServerMessage[] = [];
  const connection = connectLive({
    url: 'ws://core/api/ws',
    onMessage: (message) => received.push(message),
    onState: (state) => states.push(state),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => undefined,
    random: () => 0,
  });

  const socket = (index: number): FakeSocket => {
    const found = sockets.at(index);
    assert.ok(found !== undefined, `socket ${String(index)}`);
    return found;
  };
  assert.equal(socket(0).url, 'ws://core/api/ws');
  socket(0).receive({ type: 'event', event: { id: '41', kind: 'x' } });
  socket(0).receive({ type: 'event', event: { id: '42', kind: 'x' } });
  socket(0).receive({ type: 'ready' });
  socket(0).receive('garbage');
  assert.equal(connection.lastEventId(), '42');
  assert.equal(received.length, 3);

  socket(0).close();
  assert.equal(timers.length, 1);
  timers.at(0)?.();
  assert.equal(socket(1).url, 'ws://core/api/ws?after=42');
  assert.deepEqual(states, ['connecting', 'open', 'closed', 'connecting']);

  connection.close();
  assert.equal(socket(1).closed, true);
  // Closed on purpose: no further attempt.
  assert.equal(timers.length, 1);
});
