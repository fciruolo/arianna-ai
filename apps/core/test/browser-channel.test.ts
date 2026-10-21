import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { WebSocketServer } from 'ws';

import { dockerChannelOpener, type Channel } from '../src/browser/channel.ts';
import { BrowserError } from '../src/browser/container.ts';
import { cdpTransport } from '../src/browser/transport.ts';

const UUID = '9cf73460-fb76-496a-a0ac-a823c97f5056';

/** A fake `docker exec`: pipes on stdin and stdout, records kills, closes when killed. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly kills: string[] = [];
  readonly written: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.written.push(chunk.toString()));
  }

  kill(signal: string): boolean {
    this.kills.push(signal);
    setImmediate(() => this.emit('close', null, signal));
    return true;
  }
}

function opener(): { children: FakeChild[]; argv: string[][]; open: ReturnType<typeof dockerChannelOpener> } {
  const children: FakeChild[] = [];
  const argv: string[][] = [];
  const open = dockerChannelOpener((args) => {
    argv.push(args);
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  return { children, argv, open };
}

test('channel: docker exec socat with the fixed argv, bytes in both directions', async () => {
  const { children, argv, open } = opener();
  const channel = open('arianna-browser-a', 9222);
  assert.deepEqual(argv, [['exec', '-i', 'arianna-browser-a', 'socat', 'STDIO', 'TCP:127.0.0.1:9222']]);
  const child = children[0];
  assert.ok(child);
  channel.stream.write('ping');
  const got = new Promise<string>((resolve) => channel.stream.once('data', (chunk: Buffer) => { resolve(chunk.toString()); }));
  child.stdout.write('pong');
  assert.equal(await got, 'pong');
  assert.deepEqual(child.written, ['ping']);
  channel.close();
  channel.close();
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.ok(channel.stream.destroyed);
});

test('channel: ending the writing kills docker exec instead of half-closing socat', async () => {
  const { children, open } = opener();
  const channel = open('arianna-browser-a', 5900);
  const child = children[0];
  assert.ok(child);
  let stdinEnded = false;
  child.stdin.on('finish', () => { stdinEnded = true; });
  channel.stream.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.equal(stdinEnded, false);
});

test('channel: docker exec that exits closes the stream, no process left', async () => {
  const { children, open } = opener();
  const channel = open('arianna-browser-a', 9222);
  const child = children[0];
  assert.ok(child);
  const closed = new Promise<void>((resolve) => channel.stream.once('close', () => { resolve(); }));
  channel.stream.resume();
  child.emit('close', 1, null);
  await closed;
  assert.ok(channel.stream.destroyed);
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('channel: no process for a port other than 5900 and 9222', () => {
  const { argv, open } = opener();
  assert.throws(() => open('arianna-browser-a', 22), (error: unknown) => error instanceof BrowserError && error.code === 'bad-port');
  assert.throws(() => open('arianna-postgres', 9222), (error: unknown) => error instanceof BrowserError && error.code === 'bad-id');
  assert.deepEqual(argv, []);
});

test('transport: WebSocket handshake on the channel, Host 127.0.0.1:9222, JSON both ways', async () => {
  const requests: IncomingMessage[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    requests.push(request);
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as { id: number };
      socket.send(JSON.stringify({ id: message.id, result: { ok: true } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // The test stands in for docker exec with a plain socket; the transport sees only a stream.
  const socket = connect(port, '127.0.0.1');
  let closedChannel = false;
  const channel: Channel = { stream: socket, close: () => { closedChannel = true; socket.destroy(); } };
  try {
    const transport = cdpTransport(`/devtools/browser/${UUID}`, channel);
    await transport.ready;
    const answer = new Promise<object>((resolve) => { transport.onmessage = resolve; });
    transport.send({ id: 1, method: 'Browser.getVersion' });
    assert.deepEqual(await answer, { id: 1, result: { ok: true } });
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.headers.host, '127.0.0.1:9222');
    assert.equal(request.url, `/devtools/browser/${UUID}`);
    assert.equal(request.headers.origin, undefined);
    const closed = new Promise<void>((resolve) => { transport.onclose = () => { resolve(); }; });
    transport.close();
    await closed;
    assert.ok(closedChannel);
  } finally {
    wss.close();
    server.close();
  }
});

test('transport: a refused handshake rejects ready', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(403).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const socket = connect(port, '127.0.0.1');
  try {
    const transport = cdpTransport(`/devtools/browser/${UUID}`, { stream: socket, close: () => { socket.destroy(); } });
    await assert.rejects(transport.ready);
  } finally {
    server.close();
  }
});
