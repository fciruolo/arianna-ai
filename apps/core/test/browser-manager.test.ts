import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { readDevtoolsPath, waitForCdp, type Channel, type OpenChannel } from '../src/browser/channel.ts';
import { BrowserError, type DockerRun } from '../src/browser/container.ts';
import type { BrowserImageLock } from '../src/browser/image.ts';
import { BrowserLifetime, BrowserManager } from '../src/browser/manager.ts';
import { cdpTransport } from '../src/browser/transport.ts';

const IMAGE = `sha256:${'c'.repeat(64)}`;
const UUID = '9cf73460-fb76-496a-a0ac-a823c97f5056';
const LOCK: BrowserImageLock = { image: IMAGE, builtAt: '2026-10-21T00:00:00.000Z', chromium: '155.0.8059.79', snapshot: '20261020T000000Z', base: `debian:trixie-slim@sha256:${'d'.repeat(64)}` };

const code = (expected: BrowserError['code']) => (error: unknown): boolean => error instanceof BrowserError && error.code === expected;

/** A fake channel: answers the request with `answer`, records what was written. */
function fakeOpen(answer: (request: string) => string | null, written: string[] = [], ports: number[] = []): OpenChannel {
  return (_container, port) => {
    ports.push(port);
    const toCore = new PassThrough();
    const duplex = Object.assign(toCore, {
      write: (chunk: string | Buffer) => {
        const request = chunk.toString();
        written.push(request);
        const reply = answer(request);
        if (reply !== null) setImmediate(() => toCore.push(reply));
        return true;
      },
    });
    const channel: Channel = { stream: duplex, close: () => toCore.destroy() };
    return channel;
  };
}

function versionAnswer(url: string): string {
  const body = JSON.stringify({ Browser: 'Chrome/155', webSocketDebuggerUrl: url });
  return `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`;
}

test('json/version: the devtools path, asked with Host 127.0.0.1:9222 on port 9222', async () => {
  const written: string[] = [];
  const ports: number[] = [];
  const path = await readDevtoolsPath(fakeOpen(() => versionAnswer(`ws://127.0.0.1:9222/devtools/browser/${UUID}`), written, ports), 'arianna-browser-a', 1000);
  assert.equal(path, `/devtools/browser/${UUID}`);
  assert.deepEqual(ports, [9222]);
  assert.match(written[0] ?? '', /^GET \/json\/version HTTP\/1\.1\r\nHost: 127\.0\.0\.1:9222\r\n\r\n$/);
});

test('json/version: another host, path or status is refused', async () => {
  for (const url of [`ws://evil.example:9222/devtools/browser/${UUID}`, `ws://127.0.0.1:9223/devtools/browser/${UUID}`, `ws://127.0.0.1:9222/devtools/page/${UUID}`, 'ws://127.0.0.1:9222/devtools/browser/x']) {
    await assert.rejects(readDevtoolsPath(fakeOpen(() => versionAnswer(url)), 'arianna-browser-a', 1000), BrowserError, url);
  }
  await assert.rejects(readDevtoolsPath(fakeOpen(() => 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'), 'arianna-browser-a', 1000), BrowserError);
});

test('waitForCdp: retries until CDP answers, gives up at the ceiling', async () => {
  let attempts = 0;
  const late = fakeOpen(() => (++attempts < 3 ? null : versionAnswer(`ws://127.0.0.1:9222/devtools/browser/${UUID}`)));
  assert.equal(await waitForCdp(late, 'arianna-browser-a', { timeoutMs: 2000, attemptMs: 30, pauseMs: 1 }), `/devtools/browser/${UUID}`);
  assert.equal(attempts, 3);
  await assert.rejects(waitForCdp(fakeOpen(() => null), 'arianna-browser-a', { timeoutMs: 100, attemptMs: 20, pauseMs: 1 }), code('cdp-timeout'));
});

test('transport: only a browser devtools path', () => {
  const channel: Channel = { stream: new PassThrough(), close: () => undefined };
  assert.throws(() => cdpTransport('/devtools/page/x', channel));
  assert.throws(() => cdpTransport(`/devtools/browser/${UUID}?x=1`, channel));
});

interface Fake {
  docker: DockerRun;
  calls: string[][];
}

function fakeDocker(imageId = IMAGE): Fake {
  const calls: string[][] = [];
  return {
    calls,
    docker: (args) => {
      calls.push(args);
      if (args[0] === 'image') return Promise.resolve(`${imageId}\n`);
      if (args[0] === 'run') return Promise.resolve('0123abcd\n');
      return Promise.resolve('');
    },
  };
}

const okOpen = fakeOpen(() => versionAnswer(`ws://127.0.0.1:9222/devtools/browser/${UUID}`));
const noTimer = (): { clear(): void } => ({ clear: () => undefined });

test('one browser at a time: a second one is busy, free again after stop', async () => {
  const fake = fakeDocker();
  const manager = new BrowserManager({ home: '/h', docker: fake.docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/seccomp.json', every: noTimer });
  const open = await manager.start('job-1');
  assert.equal(open.container, 'arianna-browser-job-1');
  assert.equal(open.devtoolsPath, `/devtools/browser/${UUID}`);
  await assert.rejects(manager.start('job-2'), code('busy'));
  await manager.stop('job-1');
  assert.deepEqual(fake.calls.at(-1), ['rm', '-f', 'arianna-browser-job-1']);
  const again = await manager.start('job-2');
  assert.equal(again.id, 'job-2');
  const run = fake.calls.find((args) => args[0] === 'run');
  assert.ok(run?.includes('none') && run.at(-1) === IMAGE);
});

test('two starts at the same moment: the second is busy', async () => {
  const fake = fakeDocker();
  const manager = new BrowserManager({ home: '/h', docker: fake.docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/seccomp.json', every: noTimer });
  const results = await Promise.allSettled([manager.start('a'), manager.start('b')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.ok(code('busy')(results[1].reason));
});

test('a container docker cannot remove keeps the browser busy, retried at the next round', async () => {
  let failRemove = true;
  const calls: string[][] = [];
  const docker: DockerRun = (args) => {
    calls.push(args);
    if (args[0] === 'image') return Promise.resolve(`${IMAGE}\n`);
    if (args[0] === 'rm' && failRemove) return Promise.reject(new BrowserError('docker', 'docker rm: Error response from daemon: arianna-browser-a'));
    return Promise.resolve('');
  };
  const ticks: (() => void)[] = [];
  const events: unknown[] = [];
  const closed: string[] = [];
  const manager = new BrowserManager({
    home: '/h', docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json',
    every: (callback) => {
      ticks.push(callback);
      return { clear: () => { ticks.splice(ticks.indexOf(callback), 1); } };
    },
    onEvent: (event) => { events.push(event); },
    onClose: (id, reason) => { closed.push(`${id}:${reason}`); },
  });
  await manager.start('a');
  await manager.stop('a');
  assert.equal(manager.state, 'closing');
  assert.deepEqual(events, [{ kind: 'browser.remove_failed', label: 'L0', payload: { reason: 'docker' } }]);
  // Only the kind of failure: nothing of what docker said.
  assert.ok(!JSON.stringify(events).includes('arianna-browser-a'));
  await assert.rejects(manager.start('b'), code('busy'));
  await assert.rejects(manager.cleanup(), code('busy'));
  assert.deepEqual(closed, []);
  failRemove = false;
  for (const tick of [...ticks]) tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.state, 'free');
  assert.deepEqual(closed, ['a:stopped']);
  assert.equal(ticks.length, 0);
  assert.equal(calls.filter((args) => args[0] === 'rm').length, 2);
  await assert.doesNotReject(manager.start('b'));
});

test('a failed start whose container cannot be removed stays busy too', async () => {
  let failRemove = true;
  const docker: DockerRun = (args) => {
    if (args[0] === 'image') return Promise.resolve(`${IMAGE}\n`);
    if (args[0] === 'rm' && failRemove) return Promise.reject(new Error('daemon'));
    return Promise.resolve('');
  };
  let tick: (() => void) | undefined;
  const events: unknown[] = [];
  const manager = new BrowserManager({
    home: '/h', docker, openChannel: fakeOpen(() => null), readLock: () => LOCK, seccompPath: '/h/s.json', cdpReadyMs: 30,
    every: (callback) => {
      tick = callback;
      return { clear: () => { tick = undefined; } };
    },
    onEvent: (event) => { events.push(event); },
  });
  await assert.rejects(manager.start('a'), code('cdp-timeout'));
  assert.equal(manager.state, 'closing');
  assert.deepEqual(events, [{ kind: 'browser.remove_failed', label: 'L0', payload: { reason: 'error' } }]);
  failRemove = false;
  tick?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.state, 'free');
});

test('cleanup: removes leftovers when free, refused while a browser is open', async () => {
  const calls: string[][] = [];
  const docker: DockerRun = (args) => {
    calls.push(args);
    if (args[0] === 'image') return Promise.resolve(`${IMAGE}\n`);
    if (args[0] === 'ps') return Promise.resolve('arianna-browser-old\n');
    return Promise.resolve('');
  };
  const manager = new BrowserManager({ home: '/h', docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json', every: noTimer });
  assert.deepEqual(await manager.cleanup(), ['arianna-browser-old']);
  await manager.start('a');
  const before = calls.length;
  await assert.rejects(manager.cleanup(), code('busy'));
  assert.equal(calls.length, before);
});

test('no start without the lock, or with another local image', async () => {
  const none = new BrowserManager({ home: '/h', docker: fakeDocker().docker, openChannel: okOpen, readLock: () => null, every: noTimer });
  await assert.rejects(none.start('a'), code('no-lock'));
  const other = fakeDocker(`sha256:${'e'.repeat(64)}`);
  const mismatch = new BrowserManager({ home: '/h', docker: other.docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json', every: noTimer });
  await assert.rejects(mismatch.start('a'), code('image-mismatch'));
  assert.ok(!other.calls.some((args) => args[0] === 'run'));
  // A refused start leaves the browser free.
  const ok = new BrowserManager({ home: '/h', docker: fakeDocker().docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json', every: noTimer });
  await assert.doesNotReject(ok.start('a'));
});

test('a container whose CDP never answers is removed', async () => {
  const fake = fakeDocker();
  const manager = new BrowserManager({ home: '/h', docker: fake.docker, openChannel: fakeOpen(() => null), readLock: () => LOCK, seccompPath: '/h/s.json', cdpReadyMs: 50, every: noTimer });
  await assert.rejects(manager.start('a'), code('cdp-timeout'));
  assert.deepEqual(fake.calls.at(-1), ['rm', '-f', 'arianna-browser-a']);
  assert.equal(manager.active, null);
});

test('lifetime: closes after 15 minutes without actions, at most after 30', () => {
  const minute = 60_000;
  const life = new BrowserLifetime(0);
  assert.equal(life.expired(14 * minute), null);
  assert.equal(life.expired(15 * minute), 'idle');
  life.touch(14 * minute);
  assert.equal(life.expired(28 * minute), null);
  life.touch(28 * minute);
  assert.equal(life.expired(29 * minute), null);
  assert.equal(life.expired(30 * minute), 'max');
});

test('the periodic check stops an idle browser, not an active one', async () => {
  let now = 0;
  let tick: (() => void) | undefined;
  const closed: string[] = [];
  const fake = fakeDocker();
  const manager = new BrowserManager({
    home: '/h', docker: fake.docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json', now: () => now,
    every: (callback) => {
      tick = callback;
      return { clear: () => (tick = undefined) };
    },
    onClose: (id, reason) => closed.push(`${id}:${reason}`),
  });
  const open = await manager.start('a');
  now = 10 * 60_000;
  open.touch();
  now = 20 * 60_000;
  tick?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(manager.active, null);
  now = 25 * 60_000;
  tick?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.active, null);
  assert.deepEqual(closed, ['a:idle']);
  assert.equal(tick, undefined);
});
