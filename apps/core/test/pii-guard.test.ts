import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { guardPaths } from '@arianna/config';
import { piiVerdict } from '@arianna/policy';

import { createPiiGuard, guardEnv, guardStarter, type GuardChild } from '../src/pii-guard.ts';

const SRC = join(import.meta.dirname, '..', 'src');

/**
 * A fake apps/guard: answers each request line with `answer(request)`, or never
 * with `answer` returning undefined. `ready: false` never sends the ready line.
 */
function fakeChild(options: { ready?: boolean; answer?: (request: { id: number; texts: string[] }) => unknown; exitAtStart?: boolean } = {}) {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const requests: { id: number; texts: string[] }[] = [];
  let killed = 0;
  const stdinEvents = new EventEmitter();
  const stdin = {
    on: (event: string, listener: (...args: unknown[]) => void) => stdinEvents.on(event, listener),
    write(line: string): boolean {
      const request = JSON.parse(line) as { id: number; texts: string[] };
      requests.push(request);
      const answer = options.answer?.(request);
      if (answer !== undefined) setImmediate(() => stdout.write(`${JSON.stringify(answer)}\n`));
      return true;
    },
    end(): void {},
  };
  const child = {
    stdin,
    stdout,
    kill: () => {
      killed++;
      return true;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
      return child;
    },
  } as unknown as GuardChild;
  setImmediate(() => {
    if (options.exitAtStart === true) events.emit('exit', 1);
    else if (options.ready !== false) stdout.write(`${JSON.stringify({ ready: true, kinds: ['FULLNAME'] })}\n`);
  });
  return { child, requests, killed: () => killed, exit: () => events.emit('exit', 1), epipe: () => stdinEvents.emit('error', new Error('EPIPE')) };
}

const nothingFound = (request: { id: number; texts: string[] }) => ({ id: request.id, entities: request.texts.map(() => []) });

test('no service configured: every check is off, and off blocks outside development', async () => {
  const guard = createPiiGuard({ start: undefined, development: false });
  assert.equal(guard.state, 'off');
  assert.deepEqual(piiVerdict(await guard.scan(['testo']), ['testo']), { verdict: 'unavailable', reason: 'off' });
  const dev = createPiiGuard({ start: undefined, development: true });
  assert.deepEqual(piiVerdict(await dev.scan(['testo']), ['testo']), { verdict: 'skipped', reason: 'off' });
});

test('started at the first check, then reused: one process for many checks', async () => {
  let starts = 0;
  const fake = fakeChild({ answer: nothingFound });
  const guard = createPiiGuard({
    start: () => {
      starts++;
      return fake.child;
    },
    development: false,
  });
  assert.equal(guard.state, 'idle', 'not started before the first exit');
  const [first, second] = await Promise.all([guard.scan(['uno']), guard.scan(['due', 'tre'])]);
  assert.deepEqual(piiVerdict(first, ['uno']), { verdict: 'clean' });
  assert.deepEqual(piiVerdict(second, ['due', 'tre']), { verdict: 'clean' });
  assert.deepEqual(piiVerdict(await guard.scan(['quattro']), ['quattro']), { verdict: 'clean' });
  assert.equal(starts, 1);
  assert.equal(guard.state, 'ready');
  assert.deepEqual(fake.requests.map((request) => request.texts), [['uno'], ['due', 'tre'], ['quattro']]);
  await guard.stop();
});

test('warm starts the service ahead of a check and the check reuses it; off, stopped or never ready is false', async () => {
  let starts = 0;
  const fake = fakeChild({ answer: nothingFound });
  const guard = createPiiGuard({ start: () => { starts++; return fake.child; }, development: false });
  assert.equal(await guard.warm(), true);
  assert.equal(guard.state, 'ready');
  assert.equal(fake.requests.length, 0, 'no text is sent to warm it');
  assert.equal(await guard.warm(), true);
  assert.deepEqual(piiVerdict(await guard.scan(['uno']), ['uno']), { verdict: 'clean' });
  assert.equal(starts, 1);
  await guard.stop();
  assert.equal(await guard.warm(), false);
  assert.equal(starts, 1);
  assert.equal(await createPiiGuard({ start: undefined, development: false }).warm(), false);
  let stuckStarts = 0;
  const stuck = createPiiGuard({ start: () => { stuckStarts++; return fakeChild({ ready: false }).child; }, development: false, startTimeoutMs: 20, killGraceMs: 1 });
  assert.equal(await stuck.warm(), false);
  assert.equal(await stuck.warm(), false, 'within the retry time no new start');
  assert.equal(stuckStarts, 1);
  await stuck.stop();
});

test('what the model found reaches the gateway, the names of the agents are ignored', async () => {
  const text = 'Coder scrive a Mario Rossi';
  const fake = fakeChild({
    answer: (request) => ({
      id: request.id,
      entities: [
        [
          { kind: 'FULLNAME', start: 0, end: 5, score: 0.9 },
          { kind: 'FULLNAME', start: 15, end: 26, score: 0.99 },
        ],
      ],
    }),
  });
  const guard = createPiiGuard({ start: () => fake.child, development: true, names: () => ['coder'] });
  assert.deepEqual(piiVerdict(await guard.scan([text]), [text]), { verdict: 'found', findings: [{ kind: 'FULLNAME', fragment: 0 }] });
  await guard.stop();
});

test('an answer of the wrong shape is no check, even in development; an error of the service is no answer', async () => {
  const shapes = [(id: number) => ({ id, entities: 'nope' }), (id: number) => ({ id, entities: [[{ kind: 'FULLNAME', start: 0, end: 999, score: 1 }]] })];
  for (const shape of shapes) {
    const fake = fakeChild({ answer: (request) => shape(request.id) });
    const guard = createPiiGuard({ start: () => fake.child, development: true });
    assert.deepEqual(piiVerdict(await guard.scan(['testo']), ['testo']), { verdict: 'unavailable', reason: 'malformed' }, 'a bug of the service shows in development too');
    await guard.stop();
  }
  for (const development of [false, true]) {
    const fake = fakeChild({ answer: (request) => ({ id: request.id, error: 'scan-failed' }) });
    const guard = createPiiGuard({ start: () => fake.child, development });
    assert.deepEqual(piiVerdict(await guard.scan(['testo']), ['testo']), development ? { verdict: 'skipped', reason: 'error' } : { verdict: 'unavailable', reason: 'error' });
    await guard.stop();
  }
});

test('a request without an answer times out, and the process is restarted at the next exit', async () => {
  let starts = 0;
  let answers = false;
  const guard = createPiiGuard({
    start: () => {
      starts++;
      return fakeChild({ answer: (request) => (answers ? nothingFound(request) : undefined) }).child;
    },
    development: false,
    requestTimeoutMs: 30,
    requestMsPer10k: 0,
    retryMs: 0,
  });
  assert.deepEqual(piiVerdict(await guard.scan(['testo']), ['testo']), { verdict: 'unavailable', reason: 'timeout' });
  assert.equal(guard.state, 'failed');
  answers = true;
  assert.deepEqual(piiVerdict(await guard.scan(['testo']), ['testo']), { verdict: 'clean' });
  assert.equal(starts, 2);
  await guard.stop();
});

test('a service that never gets ready, or exits, stops the exits; no new start before the retry time', async () => {
  let starts = 0;
  const slow = createPiiGuard({
    start: () => {
      starts++;
      return fakeChild({ ready: false }).child;
    },
    development: false,
    startTimeoutMs: 30,
    retryMs: 60_000,
  });
  assert.equal(piiVerdict(await slow.scan(['testo']), ['testo']).verdict, 'unavailable');
  assert.equal(piiVerdict(await slow.scan(['testo']), ['testo']).verdict, 'unavailable');
  assert.equal(starts, 1, 'waits the retry time before starting again');
  await slow.stop();

  const crash = createPiiGuard({ start: () => fakeChild({ exitAtStart: true }).child, development: false });
  assert.deepEqual(piiVerdict(await crash.scan(['testo']), ['testo']), { verdict: 'unavailable', reason: 'error' });
  const throws = createPiiGuard({
    start: () => {
      throw new Error('ENOENT');
    },
    development: false,
  });
  assert.deepEqual(piiVerdict(await throws.scan(['testo']), ['testo']), { verdict: 'unavailable', reason: 'error' });
});

test('a crash with requests in flight settles them as no check', async () => {
  const fake = fakeChild({ answer: () => undefined });
  const guard = createPiiGuard({ start: () => fake.child, development: false, requestTimeoutMs: 5_000 });
  const pending = guard.scan(['testo']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.exit();
  assert.deepEqual(piiVerdict(await pending, ['testo']), { verdict: 'unavailable', reason: 'error' });
});

test('an error on the pipe of a dead service settles the request and does not throw', async () => {
  const fake = fakeChild({ answer: () => undefined });
  const guard = createPiiGuard({ start: () => fake.child, development: false, requestTimeoutMs: 5_000 });
  const pending = guard.scan(['testo']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.epipe();
  assert.deepEqual(piiVerdict(await pending, ['testo']), { verdict: 'unavailable', reason: 'error' });
  assert.equal(guard.state, 'failed');
});

test('many texts go in several requests; one text too large is not sent and does not stop the service', async () => {
  const fake = fakeChild({ answer: nothingFound });
  const guard = createPiiGuard({ start: () => fake.child, development: false });
  const texts = Array.from({ length: 150 }, (_, index) => `testo ${String(index)}`);
  assert.deepEqual(piiVerdict(await guard.scan(texts), texts), { verdict: 'clean' });
  assert.deepEqual(fake.requests.map((request) => request.texts.length), [64, 64, 22]);
  const huge = 'x'.repeat(2 * 1024 * 1024);
  assert.deepEqual(piiVerdict(await guard.scan([huge]), [huge]), { verdict: 'unavailable', reason: 'error' });
  assert.equal(fake.requests.length, 3, 'never written');
  assert.equal(guard.state, 'ready');
  assert.deepEqual(piiVerdict(await guard.scan(['dopo']), ['dopo']), { verdict: 'clean' });
  await guard.stop();
});

test('an answer with fewer lists than texts is malformed', async () => {
  const fake = fakeChild({ answer: (request) => ({ id: request.id, entities: [] }) });
  const guard = createPiiGuard({ start: () => fake.child, development: true });
  assert.deepEqual(piiVerdict(await guard.scan(['a', 'b']), ['a', 'b']), { verdict: 'unavailable', reason: 'malformed' });
  await guard.stop();
});

test('after stop the service never starts again', async () => {
  let starts = 0;
  const guard = createPiiGuard({
    start: () => {
      starts++;
      return fakeChild({ answer: nothingFound }).child;
    },
    development: false,
  });
  await guard.scan(['uno']);
  await guard.stop();
  assert.equal(guard.state, 'stopped');
  assert.deepEqual(piiVerdict(await guard.scan(['due']), ['due']), { verdict: 'unavailable', reason: 'off' });
  assert.equal(starts, 1);
});

test('a process that ignores SIGTERM gets SIGKILL', async () => {
  const signals: string[] = [];
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const child = {
    stdin: { on: () => undefined, write: () => true, end: () => undefined },
    stdout,
    kill: (signal: string) => {
      signals.push(signal);
      return true;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
      return child;
    },
  } as unknown as GuardChild;
  setImmediate(() => stdout.write(`${JSON.stringify({ ready: true, kinds: [] })}\n`));
  const guard = createPiiGuard({ start: () => child, development: false, requestTimeoutMs: 10, requestMsPer10k: 0, killGraceMs: 20 });
  assert.deepEqual(piiVerdict(await guard.scan(['testo']), ['testo']), { verdict: 'unavailable', reason: 'timeout' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('idle for long enough: the process stops and starts again at the next exit', async () => {
  let starts = 0;
  const fakes: ReturnType<typeof fakeChild>[] = [];
  const guard = createPiiGuard({
    start: () => {
      starts++;
      const fake = fakeChild({ answer: nothingFound });
      fakes.push(fake);
      return fake.child;
    },
    development: false,
    idleMs: 20,
  });
  await guard.scan(['uno']);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(guard.state, 'idle');
  assert.equal(fakes[0]?.killed(), 1);
  assert.deepEqual(piiVerdict(await guard.scan(['due']), ['due']), { verdict: 'clean' });
  assert.equal(starts, 2);
  await guard.stop();
});

test('the cage: no secret of the core, a proxy that goes nowhere, everything offline', () => {
  const paths = guardPaths(join(import.meta.dirname, '..', '..', '..'), join(import.meta.dirname, '..', '..', '..', 'data', 'test-tmp', 'guard-env'));
  const env = guardEnv({ PATH: 'bin', HOME: 'fake-home', PGPASSWORD: 'x', SOPS_AGE_KEY: 'y', HTTP_PROXY: 'http://proxy.example:3128' }, paths);
  assert.equal(env.PGPASSWORD, undefined);
  assert.equal(env.SOPS_AGE_KEY, undefined);
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:9');
  assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.TRANSFORMERS_OFFLINE, '1');
  assert.equal(env.PYTHONPATH, paths.src);
});

test('no starter without the model weights or the environment', () => {
  const paths = guardPaths(join(import.meta.dirname, '..', '..', '..'), join(import.meta.dirname, '..', '..', '..', 'data', 'test-tmp', 'guard-missing'));
  assert.equal(guardStarter(paths, undefined), undefined);
  assert.equal(guardStarter(paths, join(paths.models, 'missing')), undefined);
});

test('no source outside tests and evals uses the fake recognizer', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const dirs = [SRC, join(root, 'scripts'), ...readdirSync(join(root, 'packages')).filter((name) => name !== 'evals').map((name) => join(root, 'packages', name, 'src'))];
  const users: string[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(dir, file);
      if (path === join(root, 'packages', 'policy', 'src', 'pii.ts') || path === join(root, 'packages', 'policy', 'src', 'index.ts')) continue;
      if (readFileSync(path, 'utf8').includes('fakePiiCheck')) users.push(path.slice(root.length + 1));
    }
  }
  assert.deepEqual(users, []);
});
