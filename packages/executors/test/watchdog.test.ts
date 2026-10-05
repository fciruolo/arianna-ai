// The watchdog against the fake server run as a real process.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createLocalModel, Watchdog, type WatchdogEvent, type WatchdogOptions } from '@arianna/executors';

import { startFakeServer } from './fixtures/fake-server.ts';

const SERVER_MAIN = join(import.meta.dirname, 'fixtures', 'fake-server-main.ts');

async function freePort(): Promise<number> {
  const server = await startFakeServer();
  await server.close();
  return server.port;
}

const running: Watchdog[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((watchdog) => watchdog.stop()));
});

/** A watchdog with fast timings, started on the fake server. */
async function supervise(
  port: number,
  options: Partial<WatchdogOptions> = {},
): Promise<{ watchdog: Watchdog; events: WatchdogEvent[] }> {
  const events: WatchdogEvent[] = [];
  const watchdog = new Watchdog({
    id: 'fake',
    url: `http://127.0.0.1:${String(port)}/v1`,
    command: [process.execPath, SERVER_MAIN, String(port)],
    intervalMs: 50,
    healthTimeoutMs: 500,
    failuresBeforeRestart: 2,
    startupTimeoutMs: 5_000,
    backoffMs: 10,
    stopGraceMs: 500,
    onEvent: (event) => events.push(event),
    ...options,
  });
  running.push(watchdog);
  await watchdog.start();
  return { watchdog, events };
}

function pidOf(events: WatchdogEvent[]): number {
  const spawn = events.findLast((event) => event.type === 'spawn');
  assert.ok(spawn?.type === 'spawn', 'no spawn event');
  return spawn.pid;
}

/** Waits for the watchdog to leave `up` and come back to it. */
async function restarted(watchdog: Watchdog): Promise<void> {
  await watchdog.waitForState(['restarting', 'starting']);
  await watchdog.waitForState(['up']);
}

// A regression must fail the suite, not hang it.
describe('Watchdog', { timeout: 60_000 }, () => {
  it('starts the server and reports it up', async () => {
    const port = await freePort();
    const { watchdog, events } = await supervise(port);
    assert.equal(watchdog.state, 'up');
    assert.ok(watchdog.isAvailable());
    assert.ok(events.some((event) => event.type === 'spawn'));
    assert.equal(events.filter((event) => event.type === 'restart').length, 0);
  });

  it('restarts the server after it is killed, and the model answers again', async () => {
    const port = await freePort();
    const { watchdog, events } = await supervise(port);
    const model = createLocalModel({
      endpoints: [{ id: 'fake', url: `http://127.0.0.1:${String(port)}/v1`, models: { 'local-large': 'fake-large' } }],
      isAvailable: () => watchdog.isAvailable(),
    });
    assert.equal((await model.chat({ model: 'local-large', messages: [{ role: 'user', content: 'hi' }] })).text, 'hello');

    const first = pidOf(events);
    process.kill(first, 'SIGKILL');
    await restarted(watchdog);

    assert.notEqual(pidOf(events), first);
    assert.ok(events.some((event) => event.type === 'exit' && event.pid === first && !event.expected));
    assert.ok(events.some((event) => event.type === 'restart' && event.reason === 'exit'));
    assert.equal((await model.chat({ model: 'local-large', messages: [{ role: 'user', content: 'hi' }] })).text, 'hello');
  });

  it('restarts a server that stops answering', async () => {
    const port = await freePort();
    const { watchdog, events } = await supervise(port);
    const first = pidOf(events);
    await fetch(`http://127.0.0.1:${String(port)}/__hang`, { method: 'POST' });
    await restarted(watchdog);

    assert.notEqual(pidOf(events), first);
    assert.ok(events.some((event) => event.type === 'restart' && event.reason === 'unhealthy'));
    // The stuck process was stopped by the watchdog, not left behind.
    assert.ok(events.some((event) => event.type === 'exit' && event.pid === first && event.expected));
  });

  it('gives up after too many restarts in the window', async () => {
    const port = await freePort();
    const events: WatchdogEvent[] = [];
    const watchdog = new Watchdog({
      id: 'broken',
      url: `http://127.0.0.1:${String(port)}/v1`,
      // Exits at once, never serves.
      command: [process.execPath, '-e', 'process.exit(3)'],
      intervalMs: 20,
      startupTimeoutMs: 1_000,
      maxRestarts: 2,
      backoffMs: 1,
      onEvent: (event) => events.push(event),
    });
    running.push(watchdog);
    await watchdog.start();
    assert.equal(watchdog.state, 'failed');
    assert.equal(events.filter((event) => event.type === 'restart').length, 2);
    assert.ok(events.some((event) => event.type === 'gave-up'));
  });

  it('fails when the command cannot be started, and says why', async () => {
    const port = await freePort();
    const events: WatchdogEvent[] = [];
    const watchdog = new Watchdog({
      id: 'missing',
      url: `http://127.0.0.1:${String(port)}/v1`,
      command: ['arianna-no-such-binary'],
      intervalMs: 20,
      maxRestarts: 1,
      backoffMs: 1,
      onEvent: (event) => events.push(event),
    });
    running.push(watchdog);
    await watchdog.start();
    assert.equal(watchdog.state, 'failed');
    assert.ok(events.some((event) => event.type === 'spawn-error' && event.code === 'ENOENT'));
  });

  it('fails, without crashing the process, when the log file cannot be opened', async () => {
    const port = await freePort();
    const events: WatchdogEvent[] = [];
    const watchdog = new Watchdog({
      id: 'nolog',
      url: `http://127.0.0.1:${String(port)}/v1`,
      command: [process.execPath, SERVER_MAIN, String(port)],
      logFile: join(import.meta.dirname, 'arianna-no-such-folder', 'server.log'),
      onEvent: (event) => events.push(event),
    });
    running.push(watchdog);
    await watchdog.start();
    assert.equal(watchdog.state, 'failed');
    assert.ok(events.some((event) => event.type === 'error' && event.message === 'ENOENT'));
  });

  // apps/voice (D-066): its own health path with a token, its own environment,
  // and an exit at the end of standard input so that it dies with the core.
  const TOKEN_SERVER = [
    "const http = require('node:http');",
    // Without a pipe on stdin (stdin closed or ignored) it exits before listening, so a loaded
    // machine cannot let a health check in before the end of stdin is read.
    "const s = require('node:fs').fstatSync(0); if (!s.isFIFO() && !s.isSocket()) process.exit(0);",
    "process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));",
    "http.createServer((q, r) => {",
    "  const ok = q.url === '/health' && q.headers.authorization === 'Bearer ' + process.env.VOICE_TOKEN && process.env.SECRET === undefined;",
    "  r.writeHead(ok ? 200 : 401).end();",
    "}).listen(Number(process.argv[1]), '127.0.0.1');",
  ].join('\n');

  it('checks a custom health path with headers, in the environment it was given, with stdin kept open', async () => {
    const port = await freePort();
    const { watchdog } = await supervise(port, {
      url: `http://127.0.0.1:${String(port)}`,
      command: [process.execPath, '-e', TOKEN_SERVER, String(port)],
      env: { PATH: process.env.PATH ?? '', VOICE_TOKEN: 't0ken' },
      stdin: 'pipe',
      healthPath: '/health',
      healthHeaders: { authorization: 'Bearer t0ken' },
    });
    assert.equal(watchdog.state, 'up');
  });

  it('never reports up with the wrong token, a leaked variable or stdin closed', async () => {
    const cases: Partial<WatchdogOptions>[] = [
      { env: { PATH: process.env.PATH ?? '', VOICE_TOKEN: 't0ken' }, stdin: 'pipe', healthHeaders: { authorization: 'Bearer wrong' } },
      { env: { PATH: process.env.PATH ?? '', VOICE_TOKEN: 't0ken', SECRET: 'x' }, stdin: 'pipe', healthHeaders: { authorization: 'Bearer t0ken' } },
      { env: { PATH: process.env.PATH ?? '', VOICE_TOKEN: 't0ken' }, stdin: 'ignore', healthHeaders: { authorization: 'Bearer t0ken' } },
    ];
    for (const options of cases) {
      const port = await freePort();
      const { watchdog } = await supervise(port, {
        url: `http://127.0.0.1:${String(port)}`,
        command: [process.execPath, '-e', TOKEN_SERVER, String(port)],
        healthPath: '/health',
        startupTimeoutMs: 600,
        maxRestarts: 0,
        ...options,
      });
      assert.equal(watchdog.state, 'failed', JSON.stringify(options));
    }
  });

  it('lets start() return when stop() comes during the startup', async () => {
    const port = await freePort();
    const events: WatchdogEvent[] = [];
    const watchdog = new Watchdog({
      id: 'slow',
      url: `http://127.0.0.1:${String(port)}/v1`,
      // Never serves: the startup would last a minute.
      command: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
      startupTimeoutMs: 60_000,
      stopGraceMs: 500,
      onEvent: (event) => events.push(event),
    });
    const started = watchdog.start();
    await watchdog.waitForState(['starting']);
    await watchdog.stop();
    await started;
    assert.equal(watchdog.state, 'stopped');
    assert.ok(events.some((event) => event.type === 'exit' && event.expected));
  });

  it('waits the backoff before restarting a server it had to stop', async () => {
    const port = await freePort();
    const timed: { event: WatchdogEvent; at: number }[] = [];
    const { watchdog } = await supervise(port, {
      backoffMs: 700,
      onEvent: (event) => timed.push({ event, at: Date.now() }),
    });
    await fetch(`http://127.0.0.1:${String(port)}/__hang`, { method: 'POST' });
    await restarted(watchdog);
    // The exit the watchdog caused must not wake it early.
    const exit = timed.find(({ event }) => event.type === 'exit' && event.expected);
    const spawn = timed.findLast(({ event }) => event.type === 'spawn');
    assert.ok(exit !== undefined && spawn !== undefined);
    assert.ok(spawn.at - exit.at >= 650, `respawned after ${String(spawn.at - exit.at)} ms`);
  });

  it('ends in failed when an adopted server hangs without dying (D-033)', async () => {
    const port = await freePort();
    const external = await startFakeServer(port);
    try {
      const { watchdog, events } = await supervise(port, { maxRestarts: 2, startupTimeoutMs: 1_000 });
      assert.ok(events.some((event) => event.type === 'adopt'));
      await fetch(`http://127.0.0.1:${String(port)}/__hang`, { method: 'POST' });
      await watchdog.waitForState(['failed']);
      assert.ok(events.some((event) => event.type === 'gave-up'));
      // Our processes could not take the port, and none was declared up.
      assert.ok(!events.some((event, index) => event.type === 'state' && event.state === 'up' && index > events.findIndex((e) => e.type === 'spawn')));
    } finally {
      await external.close();
    }
  });

  it('adopts a server already answering, then takes over when it dies', async () => {
    const port = await freePort();
    const external = await startFakeServer(port);
    const { watchdog, events } = await supervise(port);
    assert.ok(events.some((event) => event.type === 'adopt'));
    assert.ok(!events.some((event) => event.type === 'spawn'));

    await external.close();
    await restarted(watchdog);
    assert.ok(events.some((event) => event.type === 'restart' && event.reason === 'unhealthy'));
    assert.ok(events.some((event) => event.type === 'spawn'));
  });

  it('only monitors when it has no command', async () => {
    const server = await startFakeServer();
    const events: WatchdogEvent[] = [];
    const watchdog = new Watchdog({
      id: 'external',
      url: server.url,
      intervalMs: 20,
      healthTimeoutMs: 200,
      failuresBeforeRestart: 2,
      onEvent: (event) => events.push(event),
    });
    running.push(watchdog);
    await watchdog.start();
    assert.equal(watchdog.state, 'up');

    await server.close();
    await watchdog.waitForState(['down']);
    assert.ok(!events.some((event) => event.type === 'restart' || event.type === 'spawn'));
  });

  it('stops the server it started', async () => {
    const port = await freePort();
    const { watchdog, events } = await supervise(port);
    await watchdog.stop();
    assert.equal(watchdog.state, 'stopped');
    assert.ok(events.some((event) => event.type === 'exit' && event.expected));
    await assert.rejects(fetch(`http://127.0.0.1:${String(port)}/v1/models`));
  });

  it('refuses a URL that is not on this machine', () => {
    assert.throws(() => new Watchdog({ id: 'lan', url: 'http://192.168.1.10:8000/v1' }));
  });
});
