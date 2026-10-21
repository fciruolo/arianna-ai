import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import type { Browser } from 'playwright-core';

import type { Channel, OpenChannel } from '../src/browser/channel.ts';
import { BrowserError, type DockerRun } from '../src/browser/container.ts';
import type { BrowserImageLock } from '../src/browser/image.ts';
import { BrowserLifetime, BrowserManager } from '../src/browser/manager.ts';
import { connectSession } from '../src/browser/session.ts';
import { CdpPipe, cdpTransport, waitForCdp } from '../src/browser/transport.ts';

const IMAGE = `sha256:${'c'.repeat(64)}`;
const LOCK: BrowserImageLock = { image: IMAGE, builtAt: '2026-10-21T00:00:00.000Z', chromium: '155.0.8059.79', snapshot: '20261020T000000Z', base: `debian:trixie-slim@sha256:${'d'.repeat(64)}` };

const code = (expected: BrowserError['code']) => (error: unknown): boolean => error instanceof BrowserError && error.code === expected;

type Reply = object | 'close' | null;

interface FakeChannels {
  open: OpenChannel;
  sockets: string[];
  written: string[];
  closed: number;
}

/**
 * Fake channels to the CDP pipe: each NUL-ended message written is answered
 * by `answer` (an object sent back, 'close' to drop the channel as when the
 * socket is not there yet, null for silence).
 */
function fakeChannels(answer: (message: Record<string, unknown>, attempt: number) => Reply): FakeChannels {
  const fake: FakeChannels = { open: () => { throw new Error('unset'); }, sockets: [], written: [], closed: 0 };
  let attempts = 0;
  fake.open = (_container, socket) => {
    fake.sockets.push(socket);
    const attempt = ++attempts;
    const stream = new PassThrough();
    const duplex = Object.assign(stream, {
      write: (chunk: string | Buffer) => {
        const text = chunk.toString();
        fake.written.push(text);
        for (const part of text.split('\0').filter((piece) => piece !== '')) {
          const reply = answer(JSON.parse(part) as Record<string, unknown>, attempt);
          if (reply === 'close') setImmediate(() => stream.destroy());
          else if (reply !== null) setImmediate(() => stream.push(`${JSON.stringify(reply)}\0`));
        }
        return true;
      },
    });
    const channel: Channel = { stream: duplex, close: () => { fake.closed += 1; stream.destroy(); } };
    return channel;
  };
  return fake;
}

const chrome = (message: Record<string, unknown>): Reply =>
  message.method === 'Browser.getVersion' ? { id: message.id, result: { product: 'Chrome/155.0.8059.79' } } : { id: message.id, result: {} };

test('pipe: messages ended by NUL, split and joined across chunks', () => {
  const stream = new PassThrough();
  const written: string[] = [];
  const duplex = Object.assign(stream, { write: (chunk: string) => { written.push(chunk); return true; } });
  const pipe = new CdpPipe({ stream: duplex, close: () => { stream.destroy(); } });
  const got: unknown[] = [];
  pipe.onmessage = (message) => { got.push(message); };
  pipe.send({ id: 1, method: 'Target.getTargets' });
  assert.deepEqual(written, ['{"id":1,"method":"Target.getTargets"}\0']);
  stream.emit('data', Buffer.from('{"id":1,"res'));
  stream.emit('data', Buffer.from('ult":{}}\0{"method":"Target.targetCreated"}\0not json\0[1]\0'));
  assert.deepEqual(got, [{ id: 1, result: {} }, { method: 'Target.targetCreated' }]);
});

test('waitForCdp: Browser.getVersion on /tmp/cdp.sock, the same pipe stays open', async () => {
  const fake = fakeChannels(chrome);
  const pipe = await waitForCdp(fake.open, 'arianna-browser-a', { timeoutMs: 1000 });
  assert.deepEqual(fake.sockets, ['/tmp/cdp.sock']);
  assert.equal(fake.written[0], '{"id":0,"method":"Browser.getVersion"}\0');
  assert.equal(pipe.closed, false);
  assert.equal(fake.closed, 0);
});

test('waitForCdp: a channel that closes is tried again; another product is not ready', async () => {
  const late = fakeChannels((message, attempt) => (attempt < 3 ? 'close' : chrome(message)));
  await waitForCdp(late.open, 'arianna-browser-a', { timeoutMs: 2000, pauseMs: 1 });
  assert.equal(late.sockets.length, 3);
  const other = fakeChannels((message) => ({ id: message.id, result: { product: 'HeadlessShell/1' } }));
  await assert.rejects(waitForCdp(other.open, 'arianna-browser-a', { timeoutMs: 50, pauseMs: 1 }), code('cdp-timeout'));
});

test('waitForCdp: a silent channel is closed by its own timer at the ceiling', async () => {
  const mute = fakeChannels(() => null);
  const started = Date.now();
  await assert.rejects(waitForCdp(mute.open, 'arianna-browser-a', { timeoutMs: 80, pauseMs: 1 }), code('cdp-timeout'));
  assert.ok(Date.now() - started < 1000);
  assert.equal(mute.sockets.length, 1);
  assert.equal(mute.closed, 1);
});

test('transport: Playwright messages on the pipe, close both ways', async () => {
  const fake = fakeChannels(chrome);
  const pipe = await waitForCdp(fake.open, 'arianna-browser-a', { timeoutMs: 1000 });
  const transport = cdpTransport(pipe);
  const answer = new Promise<object>((resolve) => { transport.onmessage = resolve; });
  transport.send({ id: 1, method: 'Browser.getVersion' });
  assert.deepEqual(await answer, { id: 1, result: { product: 'Chrome/155.0.8059.79' } });
  const closed = new Promise<void>((resolve) => { transport.onclose = () => { resolve(); }; });
  transport.close();
  await closed;
  assert.ok(pipe.closed);
  assert.equal(fake.closed, 1);
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

const okOpen: OpenChannel = (container, socket) => fakeChannels(chrome).open(container, socket);
const noTimer = (): { clear(): void } => ({ clear: () => undefined });

test('one browser at a time: a second one is busy, free again after stop', async () => {
  const fake = fakeDocker();
  const manager = new BrowserManager({ home: '/h', docker: fake.docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/seccomp.json', every: noTimer });
  const open = await manager.start('job-1');
  assert.equal(open.container, 'arianna-browser-job-1');
  assert.equal(open.cdp.closed, false);
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
  const stopping: string[] = [];
  const manager = new BrowserManager({
    home: '/h', docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json',
    every: (callback) => {
      ticks.push(callback);
      return { clear: () => { ticks.splice(ticks.indexOf(callback), 1); } };
    },
    onEvent: (event) => { events.push(event); },
    onClose: (id, reason) => { closed.push(`${id}:${reason}`); },
    // Before docker rm, with the browser already no longer active: the screens close at once.
    onStop: (id, reason) => { stopping.push(`${id}:${reason}:rm=${String(calls.filter((args) => args[0] === 'rm').length)}:active=${String(manager.active !== null)}`); },
  });
  await manager.start('a');
  await manager.stop('a');
  assert.deepEqual(stopping, ['a:stopped:rm=0:active=false']);
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
  assert.equal(stopping.length, 1);
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
    home: '/h', docker, openChannel: fakeChannels(() => null).open, readLock: () => LOCK, seccompPath: '/h/s.json', cdpReadyMs: 30,
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
  const manager = new BrowserManager({ home: '/h', docker: fake.docker, openChannel: fakeChannels(() => null).open, readLock: () => LOCK, seccompPath: '/h/s.json', cdpReadyMs: 50, every: noTimer });
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

test('cleanup and start never overlap: each is busy while the other runs', async () => {
  let releasePs: (() => void) | undefined;
  const docker: DockerRun = (args) => {
    if (args[0] === 'ps') return new Promise((resolve) => { releasePs = () => { resolve(''); }; });
    if (args[0] === 'image') return Promise.resolve(`${IMAGE}\n`);
    return Promise.resolve('');
  };
  const manager = new BrowserManager({ home: '/h', docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json', every: noTimer });
  const cleaning = manager.cleanup();
  assert.equal(manager.state, 'cleaning');
  await assert.rejects(manager.start('a'), code('busy'));
  await assert.rejects(manager.cleanup(), code('busy'));
  await new Promise((resolve) => setImmediate(resolve));
  releasePs?.();
  await cleaning;
  assert.equal(manager.state, 'free');
  const starting = manager.start('a');
  assert.equal(manager.state, 'starting');
  await assert.rejects(manager.cleanup(), code('busy'));
  await starting;
});

test('removal failures: one event only, never two removals at once', async () => {
  let rm = 0;
  let releaseRm: (() => void) | undefined;
  let failing = true;
  const docker: DockerRun = (args) => {
    if (args[0] === 'image') return Promise.resolve(`${IMAGE}\n`);
    if (args[0] === 'rm') {
      rm += 1;
      if (failing) return Promise.reject(new BrowserError('docker', 'docker rm: daemon'));
      return new Promise((resolve) => { releaseRm = () => { resolve(''); }; });
    }
    return Promise.resolve('');
  };
  const ticks: (() => void)[] = [];
  const events: unknown[] = [];
  const manager = new BrowserManager({
    home: '/h', docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json',
    every: (callback) => { ticks.push(callback); return { clear: () => { ticks.splice(ticks.indexOf(callback), 1); } }; },
    onEvent: (event) => { events.push(event); },
  });
  await manager.start('a');
  await manager.stop('a');
  for (let round = 0; round < 3; round++) {
    for (const tick of [...ticks]) tick();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(rm, 4);
  assert.equal(events.length, 1);
  failing = false;
  for (const tick of [...ticks]) tick();
  for (const tick of [...ticks]) tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rm, 5);
  assert.equal(manager.state, 'closing');
  releaseRm?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.state, 'free');
});

test('callbacks of the caller that throw do not break the manager', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let tick: (() => void) | undefined;
    let now = 0;
    const manager = new BrowserManager({
      home: '/h', docker: fakeDocker().docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json', now: () => now,
      every: (callback) => { tick = callback; return { clear: () => undefined }; },
      onClose: () => { throw new Error('caller failed'); },
      onStop: () => { throw new Error('caller failed'); },
      onEvent: () => { throw new Error('caller failed'); },
    });
    await manager.start('a');
    now = 31 * 60_000;
    tick?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.state, 'free');
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the end of the CDP session closes the browser and removes the container', async () => {
  const fake = fakeDocker();
  const closed: string[] = [];
  const manager = new BrowserManager({ home: '/h', docker: fake.docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json', every: noTimer, onClose: (id, reason) => { closed.push(`${id}:${reason}`); } });
  const open = await manager.start('a');
  open.cdp.close();
  await new Promise((resolve) => setImmediate(resolve));
  await open.close();
  assert.equal(manager.state, 'free');
  assert.deepEqual(closed, ['a:disconnected']);
  assert.deepEqual(fake.calls.filter((args) => args[0] === 'rm'), [['rm', '-f', 'arianna-browser-a']]);
});

test('a close of the session is stopped, never disconnected, even when closing Playwright closes the CDP pipe', async () => {
  const fake = fakeDocker();
  const closed: string[] = [];
  const manager = new BrowserManager({ home: '/h', docker: fake.docker, openChannel: okOpen, readLock: () => LOCK, seccompPath: '/h/s.json', every: noTimer, onClose: (id, reason) => { closed.push(`${id}:${reason}`); } });
  const open = await manager.start('job');
  let disconnect: (() => void) | undefined;
  // As a real Playwright: browser.close() ends the CDP pipe, then reports `disconnected`.
  const browser = {
    contexts: () => [{ pages: () => [], newPage: () => Promise.reject(new Error('not in this test')), on: () => undefined }],
    newBrowserCDPSession: () => Promise.resolve({ send: () => Promise.resolve({}) }),
    on: (event: string, listener: () => void) => { if (event === 'disconnected') disconnect = listener; },
    close: async () => {
      open.cdp.close();
      await new Promise((resolve) => setImmediate(resolve));
      disconnect?.();
    },
  } as unknown as Browser;
  const session = await connectSession(open, { home: mkdtempSync(join(tmpdir(), 'arianna-manager-session-')), connect: () => Promise.resolve(browser) });
  await session.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed, ['job:stopped']);
  assert.equal(manager.state, 'free');
});
