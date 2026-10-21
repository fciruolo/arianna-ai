import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { dockerChannelOpener } from '../src/browser/channel.ts';
import { BrowserError } from '../src/browser/container.ts';

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
  const channel = open('arianna-browser-a', '/tmp/cdp.sock');
  assert.deepEqual(argv, [['exec', '-i', 'arianna-browser-a', 'socat', 'STDIO', 'UNIX-CONNECT:/tmp/cdp.sock']]);
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
  const channel = open('arianna-browser-a', '/tmp/vnc.sock');
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
  const channel = open('arianna-browser-a', '/tmp/cdp.sock');
  const child = children[0];
  assert.ok(child);
  const closed = new Promise<void>((resolve) => channel.stream.once('close', () => { resolve(); }));
  channel.stream.resume();
  child.emit('close', 1, null);
  await closed;
  assert.ok(channel.stream.destroyed);
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('channel: no process for a socket other than /tmp/cdp.sock and /tmp/vnc.sock', () => {
  const { argv, open } = opener();
  assert.throws(() => open('arianna-browser-a', '/tmp/.X11-unix/X1'), (error: unknown) => error instanceof BrowserError && error.code === 'bad-socket');
  assert.throws(() => open('arianna-postgres', '/tmp/cdp.sock'), (error: unknown) => error instanceof BrowserError && error.code === 'bad-id');
  assert.deepEqual(argv, []);
});
