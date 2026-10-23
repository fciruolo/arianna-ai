// The local servers started and watched by the core (D-071, choice 4), with a
// fake oMLX run as a real process.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, resolveHome, type LocalEndpointConfig } from '@arianna/config';
import { ensureLocalKey, processStart, readLocalKey } from '@arianna/executors';

import { createLocalServers, localServerEnv, loggedEvent, logTail, type LocalServerEvent, type LocalServers } from '../src/local-servers.ts';

const HOME = resolveHome({});
const FAKE = fileURLToPath(new URL('support/fake-omlx.ts', import.meta.url));
const tmpRoot = join(HOME, DATA_DIR, 'test-tmp', randomUUID());

before(() => {
  mkdirSync(tmpRoot, { recursive: true });
});
after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => { resolve(); }));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** Whether a server listens on `port`: a 401 of a server with a key (D-221) counts. */
async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/models`, { signal: AbortSignal.timeout(500) });
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

function endpoint(id: string, port: number, managed = true): LocalEndpointConfig {
  return {
    id,
    url: `http://127.0.0.1:${String(port)}/v1`,
    ...(managed ? { command: [process.execPath, FAKE, String(port)] } : {}),
    models: { 'local-large': 'some-model' },
  };
}

let servers: LocalServers;
let events: LocalServerEvent[];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function create(): LocalServers {
  events = [];
  servers = createLocalServers({
    home: HOME,
    dataDir: tmpRoot,
    env: { PATH: process.env.PATH ?? '', HOME: tmpRoot, SOPS_AGE_KEY: 'secret', ARIANNA_DB_PASSWORD: 'secret', HTTPS_PROXY: 'http://proxy.example' },
    onEvent: (event) => events.push(event),
    timing: { intervalMs: 50, startupTimeoutMs: 10_000, backoffMs: 10, stopGraceMs: 1_000 },
  });
  return servers;
}

const spawns = (): number[] => events.flatMap((event) => (event.type === 'spawn' ? [event.pid] : []));

it('localServerEnv: built from nothing; no secret of the core, no proxy, Hugging Face offline', () => {
  const env = localServerEnv({ PATH: '/usr/bin', HOME: '/h', ARIANNA_DB_PASSWORD: 'x', SOPS_AGE_KEY: 'x', SOPS_AGE_KEY_FILE: 'x', HTTPS_PROXY: 'x', NODE_OPTIONS: 'x', HF_TOKEN: 'x' });
  assert.deepEqual(Object.keys(env).sort(), [
    'HF_HUB_DISABLE_TELEMETRY',
    'HF_HUB_OFFLINE',
    'HOME',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'PATH',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9');
  assert.equal(env.HF_HUB_OFFLINE, '1');
});

it('logTail: the end of data/<id>.log from a whole line; empty without a log', () => {
  writeFileSync(join(tmpRoot, 'tail.log'), 'first line\nsecond line\nthird\n');
  assert.equal(logTail(tmpRoot, 'tail'), 'first line\nsecond line\nthird\n');
  assert.equal(logTail(tmpRoot, 'tail', 15), 'third\n');
  assert.equal(logTail(tmpRoot, 'none'), '');
});

describe('createLocalServers', { timeout: 60_000 }, () => {
  afterEach(async () => {
    await servers.stop();
  });

  it('starts a server with a command, logs to data/<id>.log with a clean environment, and stops it with the core', async () => {
    const port = await freePort();
    create();
    await servers.sync([endpoint('omlx', port)]);
    assert.deepEqual(servers.status(), [{ id: 'omlx', url: `http://127.0.0.1:${String(port)}/v1`, managed: true, adopted: false, state: 'up' }]);
    assert.equal(servers.isAvailable('omlx'), true);
    const log = readFileSync(join(tmpRoot, 'omlx.log'), 'utf8');
    assert.match(log, /^env /);
    assert.doesNotMatch(log, /SOPS_AGE_KEY|ARIANNA_DB_PASSWORD/);
    assert.ok(!log.includes('proxy.example'));
    // D-221: the key of data/omlx.key reaches the server in its environment, never on its command line.
    assert.match(log, /OMLX_API_KEY/);
    assert.ok(readLocalKey(tmpRoot, 'omlx') !== undefined);
    assert.equal(statSync(join(tmpRoot, 'omlx.key')).mode & 0o777, 0o600);
    const open = await fetch(`http://127.0.0.1:${String(port)}/v1/models`, { signal: AbortSignal.timeout(500) });
    assert.equal(open.status, 401);
    await servers.stop();
    assert.equal(await answers(port), false);
    assert.deepEqual(servers.status(), []);
  });

  it('adopts a server already answering on the port with the key of data/<id>.key, and leaves it running on stop', async () => {
    const port = await freePort();
    // A server a previous core started: it asks for the key the core keeps in data/omlx.key.
    const key = ensureLocalKey(tmpRoot, 'omlx');
    const running: Server = createHttpServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${key}`) response.writeHead(401).end();
      else response.writeHead(request.url === '/v1/models' ? 200 : 404).end('{}');
    });
    await new Promise<void>((resolve) => running.listen(port, '127.0.0.1', resolve));
    try {
      create();
      await servers.sync([endpoint('omlx', port)]);
      assert.deepEqual(servers.status().map(({ state, adopted }) => [state, adopted]), [['up', true]]);
      assert.ok(events.some((event) => event.type === 'adopt'));
      assert.deepEqual(spawns(), []);
      await servers.stop();
      assert.equal(await answers(port), true);
    } finally {
      await new Promise<void>((resolve) => running.close(() => { resolve(); }));
    }
  });

  it('does not adopt a server that answers without the key: state failed, event open, left running (D-221)', async () => {
    const port = await freePort();
    const running: Server = createHttpServer((request, response) => {
      response.writeHead(request.url === '/v1/models' ? 200 : 404).end('{}');
    });
    await new Promise<void>((resolve) => running.listen(port, '127.0.0.1', resolve));
    try {
      create();
      await servers.sync([endpoint('omlx', port)]);
      assert.deepEqual(servers.status().map(({ state, adopted }) => [state, adopted]), [['failed', false]]);
      assert.ok(events.some((event) => event.type === 'open'));
      assert.ok(!events.some((event) => event.type === 'adopt'));
      assert.equal(loggedEvent({ type: 'open', endpoint: 'omlx' }), true);
      assert.deepEqual(spawns(), []);
      assert.equal(servers.isAvailable('omlx'), false);
      await servers.stop();
      assert.equal(await answers(port), true);
    } finally {
      await new Promise<void>((resolve) => running.close(() => { resolve(); }));
    }
  });

  it('a key that cannot be written fails the sync before any server starts (D-221)', async () => {
    const port = await freePort();
    events = [];
    servers = createLocalServers({ home: HOME, dataDir: join(tmpRoot, 'missing', 'data'), onEvent: (event) => events.push(event) });
    await assert.rejects(servers.sync([endpoint('omlx', port)]), /ENOENT/);
    assert.deepEqual(servers.status(), []);
    assert.deepEqual(spawns(), []);
    // An endpoint only watched needs no key.
    await servers.sync([endpoint('spare', port, false)]);
    assert.deepEqual(servers.status().map(({ id }) => id), ['spare']);
  });

  it('only watches an endpoint without a command: down when nothing answers, and the model tries it last', async () => {
    const port = await freePort();
    create();
    await servers.sync([endpoint('spare', port, false)]);
    assert.deepEqual(servers.status(), [{ id: 'spare', url: `http://127.0.0.1:${String(port)}/v1`, managed: false, adopted: false, state: 'down' }]);
    assert.equal(servers.isAvailable('spare'), false);
    // An endpoint the core does not know is not held back.
    assert.equal(servers.isAvailable('other'), true);
    // Settled on down: nothing to wait for (D-100).
    assert.equal(servers.isSettling('spare'), false);
    assert.equal(servers.isSettling('other'), false);
    assert.deepEqual(spawns(), []);
  });

  it('isSettling: true while a server is on its way up, false once it is up (D-100)', async () => {
    const port = await freePort();
    create();
    const pending = servers.sync([endpoint('omlx', port)]);
    let seen = false;
    for (let tick = 0; tick < 1_000 && !seen; tick += 1) {
      seen = servers.isSettling('omlx');
      if (!seen) await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(seen, true);
    assert.equal(servers.isAvailable('omlx'), false);
    await pending;
    assert.equal(servers.isSettling('omlx'), false);
    assert.equal(servers.isAvailable('omlx'), true);
  });

  it('restarts a server whose command changed, stops a removed one, keeps one whose model names changed', async () => {
    const [a, b] = [await freePort(), await freePort()];
    create();
    await servers.sync([endpoint('omlx', a), endpoint('spare', b)]);
    assert.equal(spawns().length, 2);

    // New model names only: the processes stay.
    await servers.sync([{ ...endpoint('omlx', a), models: { 'local-large': 'other' } }, endpoint('spare', b)]);
    assert.equal(spawns().length, 2);

    const changed = { ...endpoint('omlx', a), command: [process.execPath, FAKE, String(a), '--extra'] };
    await servers.sync([changed]);
    assert.equal(spawns().length, 3);
    assert.deepEqual(servers.status().map(({ id, state }) => [id, state]), [['omlx', 'up']]);
    assert.equal(await answers(b), false);
  });

  it('restart(): a new process for that endpoint only; false for an unknown one', async () => {
    const [a, b] = [await freePort(), await freePort()];
    create();
    await servers.sync([endpoint('omlx', a), endpoint('spare', b)]);
    const [first, second] = spawns();
    assert.ok(first !== undefined && second !== undefined);
    // While it restarts the endpoint stays listed, and the model does not send it requests.
    let done = false;
    const restarting = servers.restart('omlx').finally(() => { done = true; });
    const finished = (): boolean => done;
    let checks = 0;
    while (!finished()) {
      assert.deepEqual(servers.status().map(({ id }) => id), ['omlx', 'spare']);
      if (spawns().length === 2 && events.some((event) => event.type === 'exit' && event.pid === first)) assert.equal(servers.isAvailable('omlx'), false);
      checks += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(checks > 0);
    assert.equal(await restarting, true);
    assert.equal(spawns().length, 3);
    assert.equal(alive(first), false);
    assert.equal(alive(second), true);
    assert.deepEqual(servers.status().map(({ id, state }) => [id, state]), [['omlx', 'up'], ['spare', 'up']]);
    assert.equal(await answers(a), true);
    assert.equal(await servers.restart('other'), false);
    assert.equal(spawns().length, 3);
  });

  it('restart() after stop() is refused', async () => {
    create();
    await servers.stop();
    await assert.rejects(servers.restart('omlx'), /stopped/);
  });

  it('a reported failure makes the watchdog check at once and restart a dead server', async () => {
    const port = await freePort();
    create();
    await servers.sync([endpoint('omlx', port)]);
    const [first] = spawns();
    assert.ok(first !== undefined);
    process.kill(-first, 'SIGKILL');
    servers.onFailure('omlx');
    const deadline = Date.now() + 10_000;
    while (spawns().length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(spawns().length, 2);
  });
  it('stop() during a long start returns at once and leaves no process', async () => {
    const port = await freePort();
    create();
    const silent = { ...endpoint('omlx', port), command: [process.execPath, FAKE, String(port), 'silent'] };
    const syncing = servers.sync([silent]);
    const deadline = Date.now() + 5_000;
    while (spawns().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const [pid] = spawns();
    assert.ok(pid !== undefined);
    const begun = Date.now();
    await servers.stop();
    await syncing;
    assert.ok(Date.now() - begun < 3_000, 'stop waited for the start');
    assert.equal(alive(pid), false);
    assert.equal(existsSync(join(tmpRoot, 'omlx.pid')), false);
  });

  it('a sync after stop() is refused and starts nothing', async () => {
    const port = await freePort();
    create();
    await servers.stop();
    await assert.rejects(servers.sync([endpoint('omlx', port)]), /stopped/);
    assert.deepEqual(spawns(), []);
    assert.equal(await answers(port), false);
  });

  it('two syncs at once start one process', async () => {
    const port = await freePort();
    create();
    await Promise.all([servers.sync([endpoint('omlx', port)]), servers.sync([endpoint('omlx', port)])]);
    assert.equal(spawns().length, 1);
    assert.equal(servers.status()[0]?.state, 'up');
  });

  it('syncs waiting behind a long start are merged: the last configuration wins, the one in between never starts', async () => {
    const [a, b, c] = [await freePort(), await freePort(), await freePort()];
    create();
    const slow = { ...endpoint('omlx', a), command: [process.execPath, FAKE, String(a), 'slow'] };
    const first = servers.sync([slow]);
    const deadline = Date.now() + 5_000;
    while (spawns().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(spawns().length, 1);
    // Both arrive while the first is still loading: the second is replaced by the third.
    const second = servers.sync([endpoint('omlx', b)]);
    const third = servers.sync([endpoint('omlx', c)]);
    await Promise.all([first, second, third]);
    assert.equal(spawns().length, 2);
    assert.deepEqual(servers.status().map(({ url, state }) => [url, state]), [[`http://127.0.0.1:${String(c)}/v1`, 'up']]);
    assert.equal(await answers(b), false);
  });

  it('a sync arriving during a long start does not cut it short: the running one ends, then the new one applies', async () => {
    const [a, b] = [await freePort(), await freePort()];
    create();
    const slow = { ...endpoint('omlx', a), command: [process.execPath, FAKE, String(a), 'slow'] };
    const first = servers.sync([slow]);
    const deadline = Date.now() + 5_000;
    while (spawns().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const second = servers.sync([endpoint('omlx', b)]);
    await Promise.all([first, second]);
    // The first settled on its own server, up, before the second was started.
    const firstUp = events.findIndex((event) => event.type === 'state' && event.state === 'up');
    const secondSpawn = events.findLastIndex((event) => event.type === 'spawn');
    assert.ok(firstUp !== -1 && firstUp < secondSpawn);
    assert.equal(spawns().length, 2);
    assert.deepEqual(servers.status().map(({ url, state }) => [url, state]), [[`http://127.0.0.1:${String(b)}/v1`, 'up']]);
    assert.equal(await answers(a), false);
  });

  it('a command that does not exist ends in failed with spawn-error', async () => {
    const port = await freePort();
    create();
    await servers.sync([{ ...endpoint('omlx', port), command: ['arianna-no-such-binary'] }]);
    assert.equal(servers.status()[0]?.state, 'failed');
    assert.ok(events.some((event) => event.type === 'spawn-error' && event.code === 'ENOENT'));
  });

  it('turns the Hugging Face cache of oMLX off in <base-path>/settings.json before starting it, and only for oMLX (D-263)', async () => {
    const port = await freePort();
    create();
    const base = join(tmpRoot, 'omlx-base');
    const other = join(tmpRoot, 'other-base');
    await servers.sync([
      { ...endpoint('omlx', port), command: ['/arianna-no-such-dir/omlx', 'serve', '--base-path', relative(HOME, base)] },
      { ...endpoint('other', await freePort()), command: ['arianna-no-such-binary', 'serve', '--base-path', relative(HOME, other)] },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(base, 'settings.json'), 'utf8')), { huggingface: { hf_cache_enabled: false } });
    assert.equal(existsSync(other), false);
  });

  it('does not start oMLX when its settings.json cannot be read or written: failed, with a code and no path (D-263)', { skip: process.getuid?.() === 0 }, async () => {
    create();
    const broken = join(tmpRoot, 'broken-base');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'settings.json'), '{not json');
    const locked = join(tmpRoot, 'locked-base');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);
    try {
      await servers.sync([
        { ...endpoint('broken', await freePort()), command: ['/arianna-no-such-dir/omlx', 'serve', '--base-path', relative(HOME, broken)] },
        { ...endpoint('locked', await freePort()), command: ['/arianna-no-such-dir/omlx', 'serve', '--base-path', relative(HOME, locked)] },
      ]);
    } finally {
      chmodSync(locked, 0o700);
    }
    assert.deepEqual(
      servers.status().map(({ id, state, refused }) => ({ id, state, refused })),
      [
        { id: 'broken', state: 'failed', refused: 'omlx-settings-unreadable' },
        { id: 'locked', state: 'failed', refused: 'omlx-settings-unwritable' },
      ],
    );
    assert.ok(!events.some((event) => event.type === 'spawn' || event.type === 'spawn-error'));
    assert.ok(events.some((event) => event.type === 'refused' && event.endpoint === 'broken' && loggedEvent(event)));
    assert.ok(!JSON.stringify(events).includes(tmpRoot));
    assert.equal(readFileSync(join(broken, 'settings.json'), 'utf8'), '{not json');
  });

  it('writes data/<id>.pid while its server runs, and removes it when the core stops it', async () => {
    const port = await freePort();
    create();
    await servers.sync([endpoint('omlx', port)]);
    const record = JSON.parse(readFileSync(join(tmpRoot, 'omlx.pid'), 'utf8')) as { pid: number; started: string };
    assert.equal(record.pid, spawns()[0]);
    assert.notEqual(record.started, '');
    await servers.stop();
    assert.equal(existsSync(join(tmpRoot, 'omlx.pid')), false);
  });

  it('stops the orphan a crashed core left behind before starting its own', async () => {
    const port = await freePort();
    const orphan = spawnProcess(process.execPath, [FAKE, String(port), 'silent'], { detached: true, stdio: 'ignore' });
    const pid = orphan.pid;
    assert.ok(pid !== undefined);
    orphan.unref();
    const started = processStart(pid);
    writeFileSync(join(tmpRoot, 'omlx.pid'), JSON.stringify({ pid, started }));
    create();
    await servers.sync([endpoint('omlx', port)]);
    assert.ok(events.some((event) => event.type === 'orphan' && event.pid === pid));
    assert.equal(alive(pid), false);
    assert.equal(servers.status()[0]?.state, 'up');
  });

  it('never touches a process that only reused the pid of the file', async () => {
    const port = await freePort();
    const other = spawnProcess(process.execPath, [FAKE, String(await freePort()), 'silent'], { detached: true, stdio: 'ignore' });
    const pid = other.pid;
    assert.ok(pid !== undefined);
    other.unref();
    try {
      writeFileSync(join(tmpRoot, 'omlx.pid'), JSON.stringify({ pid, started: 'Thu Jan  1 00:00:00 1970' }));
      create();
      await servers.sync([endpoint('omlx', port)]);
      assert.equal(alive(pid), true);
      assert.ok(!events.some((event) => event.type === 'orphan'));
    } finally {
      process.kill(-pid, 'SIGKILL');
    }
  });
});

it('loggedEvent: states, adoption, orphans, failures and unexpected exits go in the event log; spawns and planned exits do not', () => {
  assert.equal(loggedEvent({ type: 'state', endpoint: 'omlx', state: 'up', previous: 'starting' }), true);
  assert.equal(loggedEvent({ type: 'adopt', endpoint: 'omlx' }), true);
  assert.equal(loggedEvent({ type: 'orphan', endpoint: 'omlx', pid: 42 }), true);
  assert.equal(loggedEvent({ type: 'gave-up', endpoint: 'omlx', restarts: 5, windowMs: 600_000 }), true);
  assert.equal(loggedEvent({ type: 'spawn-error', endpoint: 'omlx', code: 'ENOENT' }), true);
  assert.equal(loggedEvent({ type: 'error', endpoint: 'omlx', message: 'EACCES' }), true);
  assert.equal(loggedEvent({ type: 'exit', endpoint: 'omlx', pid: 42, code: 1, signal: null, expected: false }), true);
  assert.equal(loggedEvent({ type: 'exit', endpoint: 'omlx', pid: 42, code: 0, signal: null, expected: true }), false);
  assert.equal(loggedEvent({ type: 'spawn', endpoint: 'omlx', pid: 42 }), false);
  assert.equal(loggedEvent({ type: 'restart', endpoint: 'omlx', reason: 'exit', attempt: 1 }), false);
});
