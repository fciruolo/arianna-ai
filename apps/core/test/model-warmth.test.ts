// The warm model (D-316): the warm-up after each start of a server that
// serves the orchestrator, the unload after inactivity, and the state the
// settings page shows. Fake models and a fake oMLX run as a real process.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, resolveHome, type LocalEndpointConfig, type ModelCatalog } from '@arianna/config';
import { LocalModelError, type ChatRequest, type ChatResult, type LocalModel } from '@arianna/executors';

import { createLocalServers } from '../src/local-servers.ts';
import { createModelMemory, type ModelMemory, type SwapSample } from '../src/model-memory.ts';
import { createModelWarmth, onServerEvent, type ModelWarmthOptions, type WarmthEvent } from '../src/model-warmth.ts';

const GIB = 1024 ** 3;
const CATALOG: ModelCatalog = {
  version: 1,
  models: [{ id: 'big-35b', family: 'test', runtime: 'mlx', ramMinGib: 19, roles: ['orchestrator'], status: 'experimental', files: [] }],
};
const ENDPOINT: LocalEndpointConfig = { id: 'omlx', url: 'http://127.0.0.1:7001/v1', models: { 'local-large': 'big-35b' } };
const REQUEST: ChatRequest = { model: 'local-large', messages: [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'Ciao' }], maxTokens: 1, temperature: 0 };

interface Harness {
  memory: ModelMemory;
  warmth: ReturnType<typeof createModelWarmth>;
  requests: ChatRequest[];
  unloaded: string[];
  events: WarmthEvent[];
  at: (ms: number) => void;
  /** Holds every chat until opened. */
  hold: () => () => void;
}

function harness(extra: Partial<ModelWarmthOptions> = {}, swap?: SwapSample, endpoints: LocalEndpointConfig[] = [ENDPOINT]): Harness {
  let time = 0;
  const requests: ChatRequest[] = [];
  const unloaded: string[] = [];
  const events: WarmthEvent[] = [];
  let gate: Promise<void> | undefined;
  const memory = createModelMemory({
    catalog: () => CATALOG,
    endpoints: () => endpoints,
    isAvailable: () => true,
    unload: (_endpoint, name) => {
      unloaded.push(name);
      return Promise.resolve(true);
    },
    memoryBytes: 32 * GIB,
    now: () => time,
    swapIntervalMs: 0,
    readSwap: () => Promise.resolve(swap ?? { usedBytes: 0, totalBytes: 2 * GIB, pressure: 1 }),
  });
  const raw: LocalModel = {
    async chat(request): Promise<ChatResult> {
      requests.push(request);
      await gate;
      // One token cannot close the JSON: the real model answers a bad-response.
      throw new LocalModelError('bad-response', 'omlx: content is not JSON', { endpoint: 'omlx' });
    },
  };
  const warmth = createModelWarmth({
    endpoints: () => endpoints,
    alias: 'local-large',
    request: () => Promise.resolve(REQUEST),
    model: () => memory.wrap(raw, endpoints),
    memory,
    callActive: () => false,
    busy: () => Promise.resolve(false),
    idleMinutes: () => 30,
    now: () => time,
    intervalMs: 0,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return {
    memory,
    warmth,
    requests,
    unloaded,
    events,
    at: (ms) => { time = ms; },
    hold: () => {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => { open = resolve; });
      return () => {
        gate = undefined;
        open();
      };
    },
  };
}

describe('warm-up (D-316)', () => {
  it('sends the warm-up request once when the server comes up, with one token, through the memory account', async () => {
    const { warmth, requests, events, memory } = harness();
    await warmth.serverUp('omlx');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.maxTokens, 1);
    assert.deepEqual(requests[0].messages, REQUEST.messages);
    assert.equal(events[0]?.outcome, 'warmed');
    assert.deepEqual(memory.snapshot().loaded.map(({ model }) => model), ['big-35b']);
    // Up again without a restart (a health check that passed again): no second warm-up.
    await warmth.serverUp('omlx');
    assert.equal(requests.length, 1);
  });

  it('warms again after a restart of the server', async () => {
    const { warmth, requests } = harness();
    await warmth.serverUp('omlx');
    onServerEvent(warmth, { type: 'spawn', endpoint: 'omlx' }, () => undefined);
    await warmth.serverUp('omlx');
    assert.equal(requests.length, 2);
  });

  it('is skipped with high swap or memory pressure', async () => {
    const { warmth, requests, events } = harness({}, { usedBytes: 8 * GIB, totalBytes: 9 * GIB, pressure: 2 });
    await warmth.serverUp('omlx');
    assert.equal(requests.length, 0);
    assert.equal(events[0]?.outcome, 'skipped-swap');
  });

  it('is skipped while a call, a task step or another request is at work', async () => {
    const call = harness({ callActive: () => true });
    await call.warmth.serverUp('omlx');
    assert.equal(call.requests.length, 0);
    assert.equal(call.events[0]?.outcome, 'skipped-busy');

    const steps = harness({ busy: () => Promise.resolve(true) });
    await steps.warmth.serverUp('omlx');
    assert.equal(steps.requests.length, 0);

    const other = harness();
    const open = other.hold();
    const running = other.memory.wrap({ chat: () => new Promise<ChatResult>(() => undefined) }, [ENDPOINT]).chat({ model: 'local-large', messages: [] });
    void running;
    await other.warmth.serverUp('omlx');
    open();
    assert.equal(other.requests.length, 0);
    assert.equal(other.events[0]?.outcome, 'skipped-busy');
  });

  it('warms only a server that serves the orchestrator', async () => {
    const voiceOnly = { ...ENDPOINT, id: 'voice', models: { 'local-voice': 'big-35b' } };
    const { warmth, requests, events } = harness({}, undefined, [voiceOnly]);
    await warmth.serverUp('voice');
    assert.equal(requests.length, 0);
    assert.deepEqual(events, []);
  });

  it('reports a failure by its kind, never a text', async () => {
    const failing: LocalModel = { chat: () => Promise.reject(new LocalModelError('timeout', 'omlx: no answer in 300 s, prompt …')) };
    const events: WarmthEvent[] = [];
    const memory = createModelMemory({ catalog: () => CATALOG, endpoints: () => [ENDPOINT], isAvailable: () => true, unload: () => Promise.resolve(true), swapIntervalMs: 0, readSwap: () => Promise.resolve(undefined) });
    const warmth = createModelWarmth({
      endpoints: () => [ENDPOINT],
      alias: 'local-large',
      request: () => Promise.resolve(REQUEST),
      model: () => memory.wrap(failing, [ENDPOINT]),
      memory,
      callActive: () => false,
      busy: () => Promise.resolve(false),
      idleMinutes: () => 30,
      intervalMs: 0,
      onEvent: (event) => events.push(event),
    });
    await warmth.serverUp('omlx');
    assert.equal(events[0]?.outcome, 'failed');
    assert.equal(events[0].code, 'timeout');
  });

  it('shows «warming» while the warm-up runs, then «loaded»', async () => {
    const { warmth, hold } = harness();
    const open = hold();
    const running = warmth.serverUp('omlx');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warmth.status().endpoints[0]?.state, 'warming');
    open();
    await running;
    assert.deepEqual(warmth.status(), { idleMinutes: 30, endpoints: [{ id: 'omlx', state: 'loaded', since: null, models: ['big-35b'] }] });
  });
});

describe('unload after inactivity (D-316)', () => {
  it('unloads after N minutes without requests, shows when, and does not warm again by itself', async () => {
    const { warmth, requests, unloaded, at } = harness();
    at(1_000);
    await warmth.serverUp('omlx');
    at(1_000 + 29 * 60_000);
    await warmth.tick();
    assert.deepEqual(unloaded, []);
    at(1_000 + 30 * 60_000);
    await warmth.tick();
    assert.deepEqual(unloaded, ['big-35b']);
    const status = warmth.status().endpoints[0];
    assert.equal(status?.state, 'idle-unloaded');
    assert.equal(status.since, new Date(1_000 + 30 * 60_000).toISOString());
    // The health check keeps saying up: no warm-up after an unload for inactivity.
    await warmth.serverUp('omlx');
    assert.equal(requests.length, 1);
  });

  it('never unloads with 0 minutes', async () => {
    const { warmth, unloaded, at } = harness({ idleMinutes: () => 0 });
    await warmth.serverUp('omlx');
    at(24 * 60 * 60_000);
    await warmth.tick();
    assert.deepEqual(unloaded, []);
  });

  it('never unloads during a call, with task steps at work or a routine due soon', async () => {
    let call = true;
    let busy = false;
    let soon = false;
    const { warmth, unloaded, at } = harness({ callActive: () => call, busy: () => Promise.resolve(busy), soon: () => Promise.resolve(soon) });
    call = false;
    await warmth.serverUp('omlx');
    at(60 * 60_000);
    call = true;
    await warmth.tick();
    call = false;
    busy = true;
    await warmth.tick();
    busy = false;
    soon = true;
    await warmth.tick();
    assert.deepEqual(unloaded, []);
    soon = false;
    await warmth.tick();
    assert.deepEqual(unloaded, ['big-35b']);
  });

  it('never unloads with a request in flight', async () => {
    const { warmth, memory, unloaded, at } = harness();
    await warmth.serverUp('omlx');
    let open: () => void = () => undefined;
    const running = memory.wrap({ chat: () => new Promise<ChatResult>((resolve) => { open = () => { resolve({ text: '', finishReason: 'stop', endpoint: 'omlx', model: 'x', durationMs: 1 }); }; }) }, [ENDPOINT]).chat({ model: 'local-voice', messages: [] });
    at(60 * 60_000);
    await warmth.tick();
    assert.deepEqual(unloaded, []);
    open();
    await running;
  });
});

describe('warm-up after a restart of the watchdog (D-316)', { timeout: 60_000 }, () => {
  const HOME = resolveHome({});
  const FAKE = fileURLToPath(new URL('support/fake-omlx.ts', import.meta.url));
  const tmp = join(HOME, DATA_DIR, 'test-tmp', `warmth-${randomUUID()}`);
  before(() => { mkdirSync(tmp, { recursive: true }); });
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    await new Promise<void>((resolve) => probe.close(() => { resolve(); }));
    if (address === null || typeof address === 'string') throw new Error('no port');
    return address.port;
  }

  it('warms at the start of the server and again after the watchdog restarted it', async () => {
    const port = await freePort();
    const endpoint: LocalEndpointConfig = { id: 'omlx', url: `http://127.0.0.1:${String(port)}/v1`, command: [process.execPath, FAKE, String(port)], models: { 'local-large': 'big-35b' } };
    let warms = 0;
    let warmed: () => void = () => undefined;
    const warmth = {
      settled: false,
      serverReset() { this.settled = false; },
      serverUp() {
        if (this.settled) return Promise.resolve();
        this.settled = true;
        warms += 1;
        warmed();
        return Promise.resolve();
      },
    };
    const pids: number[] = [];
    const servers = createLocalServers({
      home: HOME,
      dataDir: tmp,
      env: { PATH: process.env.PATH ?? '', HOME: tmp },
      onEvent: (event) => {
        if (event.type === 'spawn') pids.push(event.pid);
        onServerEvent(warmth, event, () => undefined);
      },
      timing: { intervalMs: 50, startupTimeoutMs: 10_000, backoffMs: 10, stopGraceMs: 1_000 },
    });
    try {
      await servers.sync([endpoint]);
      assert.equal(warms, 1);
      const again = new Promise<void>((resolve) => { warmed = resolve; });
      const pid = pids[0];
      assert.ok(pid !== undefined);
      process.kill(-pid, 'SIGKILL');
      await again;
      assert.equal(warms, 2);
    } finally {
      await servers.stop();
    }
  });
});
