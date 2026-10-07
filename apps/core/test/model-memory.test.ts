// The memory policy of the local servers (D-107, stage E): unloading the old
// model of a role, the controlled sum before a load, the swap warning.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LocalEndpointConfig, ModelCatalog } from '@arianna/config';
import { LocalModelError, type ChatRequest, type ChatResult, type LocalModel } from '@arianna/executors';

import {
  createModelMemory,
  memoryBudgetGib,
  memoryGuardGib,
  parseMeminfoSwap,
  parseSwapUsage,
  planLoad,
  staleModels,
  swapLevel,
  targetEndpoint,
  unloadModel,
  type LoadedModel,
  type ModelMemoryEvent,
  type ModelMemoryOptions,
  UNCATALOGUED,
} from '../src/model-memory.ts';

const GIB = 1024 ** 3;

function entry(id: string, ramMinGib: number): ModelCatalog['models'][number] {
  return { id, family: 'test', runtime: 'mlx', ramMinGib, roles: ['orchestrator'], status: 'experimental', files: [] };
}
const CATALOG: ModelCatalog = { version: 1, models: [entry('big-27b', 18), entry('mid-9b', 7), entry('small-4b', 3)] };

function endpoint(models: Record<string, string>, command?: string[]): LocalEndpointConfig {
  return { id: 'omlx', url: 'http://127.0.0.1:7001/v1', models, ...(command === undefined ? {} : { command }) };
}

function loadedModel(name: string, gib: number | undefined, busy = 0, lastUsed = 0): LoadedModel {
  return { endpoint: 'omlx', name, gib, busy, lastUsed };
}

describe('memoryGuardGib', () => {
  it('reads the guard of the oMLX command, in both spellings', () => {
    assert.equal(memoryGuardGib(['omlx', 'serve', '--memory-guard-gb', '25', '--port', '7001']), 25);
    assert.equal(memoryGuardGib(['omlx', 'serve', '--memory-guard-gb=22.5']), 22.5);
  });
  it('is undefined without a guard, without a command or with a bad value', () => {
    assert.equal(memoryGuardGib(['omlx', 'serve', '--port', '7001']), undefined);
    assert.equal(memoryGuardGib(undefined), undefined);
    assert.equal(memoryGuardGib(['omlx', '--memory-guard-gb', 'many']), undefined);
    assert.equal(memoryGuardGib(['omlx', '--memory-guard-gb']), undefined);
  });
});

describe('memoryBudgetGib', () => {
  it('takes three quarters of the machine, or the guard when lower', () => {
    assert.equal(memoryBudgetGib(32 * GIB), 24);
    assert.equal(memoryBudgetGib(32 * GIB, 16), 16);
  });
  it('does not let a guard above the machine share raise the ceiling', () => {
    assert.equal(memoryBudgetGib(32 * GIB, 25), 24);
  });
});

describe('planLoad', () => {
  it('never evicts a pinned model, even idle: the plan does not fit', () => {
    const plan = planLoad(
      [loadedModel('small-4b', 3, 0, 1), loadedModel('big-27b', 18, 1, 2)],
      { endpoint: 'omlx', name: 'mid-9b', gib: 7 },
      24,
      (model) => model.name === 'small-4b',
    );
    assert.deepEqual(plan.evict, []);
    assert.equal(plan.fits, false);
  });
  it('evicts no more than needed: a small model picked first stays once a large one is out', () => {
    const plan = planLoad(
      [loadedModel('small-4b', 3, 0, 1), loadedModel('big-27b', 18, 0, 2)],
      { endpoint: 'omlx', name: 'mid-9b', gib: 7 },
      24,
    );
    assert.deepEqual(plan.evict.map(({ name }) => name), ['big-27b']);
    assert.equal(plan.totalGib, 10);
  });

  it('loads with no eviction when the sum fits', () => {
    const plan = planLoad([loadedModel('big-27b', 18)], { endpoint: 'omlx', name: 'small-4b', gib: 3 }, 24);
    assert.deepEqual(plan, { evict: [], fits: true, totalGib: 21 });
  });
  it('needs nothing for a model already loaded', () => {
    const plan = planLoad([loadedModel('big-27b', 18, 1)], { endpoint: 'omlx', name: 'big-27b', gib: 18 }, 10);
    assert.equal(plan.fits, true);
    assert.deepEqual(plan.evict, []);
  });
  it('unloads idle models first, least recently used first, until the sum fits', () => {
    const plan = planLoad(
      [loadedModel('small-4b', 3, 0, 50), loadedModel('big-27b', 18, 0, 10)],
      { endpoint: 'omlx', name: 'mid-9b', gib: 7 },
      24,
    );
    assert.deepEqual(plan.evict.map(({ name }) => name), ['big-27b']);
    assert.equal(plan.fits, true);
    assert.equal(plan.totalGib, 10);
  });
  it('refuses when the models at work leave no room', () => {
    const plan = planLoad([loadedModel('big-27b', 18, 1)], { endpoint: 'omlx', name: 'mid-9b', gib: 7 }, 24);
    assert.equal(plan.fits, false);
    assert.deepEqual(plan.evict, []);
  });
  it('refuses a model larger than the ceiling on its own', () => {
    assert.equal(planLoad([], { endpoint: 'omlx', name: 'huge', gib: 40 }, 24).fits, false);
  });
  it('lets a model the catalog does not know through, unestimated', () => {
    const plan = planLoad([loadedModel('big-27b', 18, 1)], { endpoint: 'omlx', name: 'unknown', gib: undefined }, 20);
    assert.deepEqual(plan, { evict: [], fits: true, totalGib: 18 });
  });
});

describe('staleModels', () => {
  it('lists the model a role left', () => {
    const before = [endpoint({ 'local-large': 'big-27b', 'local-small': 'small-4b' })];
    const after = [endpoint({ 'local-large': 'mid-9b', 'local-small': 'small-4b' })];
    assert.deepEqual(staleModels(before, after), [{ endpoint: 'omlx', name: 'big-27b' }]);
  });
  it('keeps a model another alias still serves', () => {
    const before = [endpoint({ 'local-small': 'small-4b', 'local-voice': 'small-4b' })];
    const after = [endpoint({ 'local-small': 'mid-9b', 'local-voice': 'small-4b' })];
    assert.deepEqual(staleModels(before, after), []);
  });
  it('ignores a removed endpoint: the local servers stop it', () => {
    assert.deepEqual(staleModels([endpoint({ 'local-large': 'big-27b' })], []), []);
  });
});

describe('targetEndpoint', () => {
  const a = { ...endpoint({ 'local-large': 'big-27b' }), id: 'a' };
  const b = { ...endpoint({ 'local-large': 'big-27b' }), id: 'b' };
  it('takes the first available endpoint serving the alias', () => {
    assert.equal(targetEndpoint([a, b], 'local-large', (id) => id === 'b')?.id, 'b');
    assert.equal(targetEndpoint([a, b], 'local-large', () => true)?.id, 'a');
  });
  it('is undefined when no endpoint serves it', () => {
    assert.equal(targetEndpoint([a, b], 'local-voice', () => true), undefined);
  });
});

describe('swap', () => {
  it('parses vm.swapusage of macOS', () => {
    assert.deepEqual(parseSwapUsage('total = 9216.00M  used = 8325.38M  free = 890.62M  (encrypted)'), {
      totalBytes: 9216 * 1024 ** 2,
      usedBytes: Math.round(8325.38 * 1024 ** 2),
    });
    assert.deepEqual(parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M'), { totalBytes: 0, usedBytes: 0 });
  });
  it('rejects text that is not vm.swapusage', () => {
    assert.equal(parseSwapUsage('unknown oid'), undefined);
  });
  it('parses /proc/meminfo of Linux', () => {
    assert.deepEqual(parseMeminfoSwap('MemTotal: 100 kB\nSwapTotal:  2048 kB\nSwapFree:   1024 kB\n'), { totalBytes: 2048 * 1024, usedBytes: 1024 * 1024 });
    assert.equal(parseMeminfoSwap('MemTotal: 100 kB\n'), undefined);
  });
  const RAM = 32 * GIB;
  it('is high with swap over the threshold or warning pressure, critical with critical pressure', () => {
    assert.equal(swapLevel({ usedBytes: 4 * GIB, totalBytes: 9 * GIB }, RAM), 'high');
    assert.equal(swapLevel({ usedBytes: 0, totalBytes: 0, pressure: 2 }, RAM), 'high');
    assert.equal(swapLevel({ usedBytes: 8 * GIB, totalBytes: 9 * GIB, pressure: 4 }, RAM), 'critical');
  });
  it('is ok with little swap and normal pressure', () => {
    assert.equal(swapLevel({ usedBytes: GIB, totalBytes: 2 * GIB, pressure: 1 }, RAM), 'ok');
  });
  it('does not flap just under the threshold once high', () => {
    const under = { usedBytes: 3 * GIB, totalBytes: 9 * GIB, pressure: 1 };
    assert.equal(swapLevel(under, RAM, 'high'), 'high');
    assert.equal(swapLevel(under, RAM, 'ok'), 'ok');
    assert.equal(swapLevel({ ...under, usedBytes: GIB }, RAM, 'high'), 'ok');
  });
});

/** A fake LocalModel: each chat waits for `release` when given one. */
function fakeModel(gate?: Promise<void>): LocalModel & { calls: string[]; unloads: string[] } {
  const calls: string[] = [];
  const unloads: string[] = [];
  return {
    calls,
    unloads,
    async chat(request: ChatRequest): Promise<ChatResult> {
      calls.push(request.model);
      await gate;
      return { text: 'ok', finishReason: 'stop', endpoint: 'omlx', model: request.model, durationMs: 1 };
    },
    unload(alias: string): Promise<boolean> {
      unloads.push(alias);
      return Promise.resolve(true);
    },
  };
}

function memoryWith(endpoints: LocalEndpointConfig[], extra: Partial<ModelMemoryOptions> = {}) {
  const unloaded: string[] = [];
  const events: ModelMemoryEvent[] = [];
  let clock = 0;
  let current = endpoints;
  const memory = createModelMemory({
    catalog: () => CATALOG,
    endpoints: () => current,
    isAvailable: () => true,
    unload: (_endpoint, name) => {
      unloaded.push(name);
      return Promise.resolve(true);
    },
    memoryBytes: 32 * GIB,
    now: () => (clock += 1),
    swapIntervalMs: 0,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { memory, unloaded, events, setEndpoints: (next: LocalEndpointConfig[]) => { current = next; } };
}

describe('createModelMemory', () => {
  const GUARD = ['omlx', 'serve', '--memory-guard-gb', '25'];

  it('unloads the idle orchestrator before a trial model that would not fit with it', async () => {
    const config = [endpoint({ 'local-large': 'big-27b' }, GUARD)];
    const { memory, unloaded, events } = memoryWith(config);
    await memory.wrap(fakeModel(), config).chat({ model: 'local-large', messages: [] });
    const trial = [endpoint({ 'local-large': 'mid-9b' }, GUARD)];
    await memory.wrap(fakeModel(), trial).chat({ model: 'local-large', messages: [] });
    assert.deepEqual(unloaded, ['big-27b']);
    assert.deepEqual(events, [{ type: 'unloaded', endpoint: 'omlx', model: 'big-27b', reason: 'budget' }]);
    assert.deepEqual(memory.snapshot().loaded, [{ endpoint: 'omlx', model: 'mid-9b', gib: 7, busy: false }]);
  });

  it('keeps both when the sum fits', async () => {
    const config = [endpoint({ 'local-large': 'big-27b', 'local-voice': 'small-4b' }, GUARD)];
    const { memory, unloaded } = memoryWith(config);
    const model = memory.wrap(fakeModel(), config);
    await model.chat({ model: 'local-large', messages: [] });
    await model.chat({ model: 'local-voice', messages: [] });
    assert.deepEqual(unloaded, []);
    assert.equal(memory.snapshot().estimatedGib, 21);
  });

  it('refuses with 507 when the model at work leaves no room, and never unloads it', async () => {
    const config = [endpoint({ 'local-large': 'big-27b' }, GUARD)];
    const { memory, unloaded, events } = memoryWith(config);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const running = memory.wrap(fakeModel(gate), config).chat({ model: 'local-large', messages: [] });
    const trial = [endpoint({ 'local-large': 'mid-9b' }, GUARD)];
    await assert.rejects(memory.wrap(fakeModel(), trial).chat({ model: 'local-large', messages: [] }), (error: unknown) => {
      assert.ok(error instanceof LocalModelError);
      assert.equal(error.status, 507);
      assert.equal(error.kind, 'http');
      return true;
    });
    open();
    await running;
    assert.deepEqual(unloaded, []);
    assert.equal(events[0]?.type, 'refused');
  });

  it('unloads the old model of a role at once when idle', async () => {
    const before = [endpoint({ 'local-large': 'big-27b', 'local-small': 'small-4b' })];
    const after = [endpoint({ 'local-large': 'mid-9b', 'local-small': 'small-4b' })];
    const { memory, unloaded, events } = memoryWith(before);
    await memory.wrap(fakeModel(), before).chat({ model: 'local-large', messages: [] });
    await memory.modelsChanged(before, after);
    assert.deepEqual(unloaded, ['big-27b']);
    assert.deepEqual(events, [{ type: 'unloaded', endpoint: 'omlx', model: 'big-27b', reason: 'role-changed' }]);
    assert.deepEqual(memory.snapshot().loaded, []);
  });

  it('waits for the request in flight before unloading the old model of a role', async () => {
    const before = [endpoint({ 'local-large': 'big-27b' })];
    const after = [endpoint({ 'local-large': 'mid-9b' })];
    const { memory, unloaded } = memoryWith(before);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const running = memory.wrap(fakeModel(gate), before).chat({ model: 'local-large', messages: [] });
    await new Promise((resolve) => setImmediate(resolve));
    await memory.modelsChanged(before, after);
    assert.deepEqual(unloaded, []);
    open();
    await running;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unloaded, ['big-27b']);
  });

  it('does not unload a model another role still uses', async () => {
    const before = [endpoint({ 'local-small': 'small-4b', 'local-voice': 'small-4b' })];
    const after = [endpoint({ 'local-small': 'mid-9b', 'local-voice': 'small-4b' })];
    const { memory, unloaded } = memoryWith(before);
    await memory.modelsChanged(before, after);
    assert.deepEqual(unloaded, []);
  });

  it('forgets what a server held when it restarts, and what an alias unload dropped', async () => {
    const config = [endpoint({ 'local-large': 'big-27b', 'local-voice': 'small-4b' })];
    const { memory } = memoryWith(config);
    const model = memory.wrap(fakeModel(), config);
    await model.chat({ model: 'local-large', messages: [] });
    await model.chat({ model: 'local-voice', messages: [] });
    assert.equal(await model.unload?.('local-voice'), true);
    assert.deepEqual(memory.snapshot().loaded.map(({ model: name }) => name), ['big-27b']);
    memory.serverReset('omlx');
    assert.deepEqual(memory.snapshot().loaded, []);
  });

  it('reports a change of the swap level once, and not a sample at the same level', async () => {
    const samples = [
      { usedBytes: GIB, totalBytes: 9 * GIB, pressure: 1 },
      { usedBytes: 8 * GIB, totalBytes: 9 * GIB, pressure: 2 },
      { usedBytes: 8 * GIB, totalBytes: 9 * GIB, pressure: 2 },
    ];
    const { memory, events } = memoryWith([], { readSwap: () => Promise.resolve(samples.shift()) });
    await memory.checkSwap();
    await memory.checkSwap();
    await memory.checkSwap();
    assert.deepEqual(events, [{ type: 'swap', level: 'high', previous: 'ok', usedGib: 8, pressure: 2 }]);
    assert.equal(memory.snapshot().swap?.level, 'high');
  });

  it('says nothing about swap on a machine that does not report it', async () => {
    const { memory, events } = memoryWith([], { readSwap: () => Promise.resolve(undefined) });
    await memory.checkSwap();
    assert.deepEqual(events, []);
    assert.equal(memory.snapshot().swap, null);
  });
});

describe('unloadModel', () => {
  it('posts to the unload route of D-074 by name, and is false for a model not loaded', async () => {
    const { createServer } = await import('node:http');
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method ?? ''} ${req.url ?? ''}`);
      res.statusCode = req.url === '/v1/models/big-27b/unload' ? 200 : 400;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const config = { id: 'omlx', url: `http://127.0.0.1:${String(address.port)}/v1`, models: { 'local-large': 'mid-9b' } };
    try {
      assert.equal(await unloadModel(config, 'big-27b', () => true), true);
      assert.equal(await unloadModel(config, 'small-4b', () => true), false);
      assert.equal(await unloadModel(config, 'big-27b', () => false), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    }
    assert.deepEqual(seen, ['POST /v1/models/big-27b/unload', 'POST /v1/models/small-4b/unload']);
  });
});

describe('createModelMemory, reviewed cases', () => {
  const GUARD = ['omlx', 'serve', '--memory-guard-gb', '25'];
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('keeps the model of a call in progress between turns: no eviction, 507 when nothing else can go', async () => {
    const config = [endpoint({ 'local-large': 'big-27b', 'local-voice': 'small-4b' }, GUARD)];
    let call = true;
    const unloadedNames: string[] = [];
    const { memory, unloaded, events } = memoryWith(config, {
      pinned: (_endpoint, name) => call && name === 'small-4b',
      unload: (_endpoint, name) => { unloadedNames.push(name); return Promise.resolve(true); },
    });
    const model = memory.wrap(fakeModel(), config);
    await model.chat({ model: 'local-voice', messages: [] });
    let open: () => void = () => undefined;
    const running = memory.wrap(fakeModel(new Promise<void>((resolve) => { open = resolve; })), config).chat({ model: 'local-large', messages: [] });
    await tick();
    const trial = [endpoint({ 'local-large': 'mid-9b', 'local-voice': 'small-4b' }, GUARD)];
    await assert.rejects(memory.wrap(fakeModel(), trial).chat({ model: 'local-large', messages: [] }), (error: unknown) => error instanceof LocalModelError && error.status === 507);
    assert.deepEqual(unloadedNames, []);
    assert.deepEqual(unloaded, []);
    assert.equal(events.at(-1)?.type, 'refused');
    open();
    await running;
    // Without a call the same model may go.
    call = false;
    await memory.wrap(fakeModel(), trial).chat({ model: 'local-large', messages: [] });
    assert.deepEqual(unloadedNames, ['big-27b']);
  });

  it('a request for a model being unloaded for a role change waits for the unload to end', async () => {
    const before = [endpoint({ 'local-large': 'big-27b' })];
    const after = [endpoint({ 'local-large': 'mid-9b' })];
    const order: string[] = [];
    let finish: () => void = () => undefined;
    const { memory } = memoryWith(before, {
      unload: (_endpoint, name) => {
        order.push(`unload ${name} start`);
        return new Promise<boolean>((resolve) => { finish = () => { order.push(`unload ${name} end`); resolve(true); }; });
      },
    });
    const old = fakeModel();
    const model = memory.wrap(old, before);
    await model.chat({ model: 'local-large', messages: [] });
    const changed = memory.modelsChanged(before, after);
    await tick();
    const again = model.chat({ model: 'local-large', messages: [] }).then(() => order.push('chat'));
    await tick();
    assert.deepEqual(order, ['unload big-27b start']);
    finish();
    await changed;
    await again;
    assert.deepEqual(order, ['unload big-27b start', 'unload big-27b end', 'chat']);
  });

  it('names a model outside the catalog "uncatalogued" in events and snapshot', async () => {
    const before = [endpoint({ 'local-large': 'my-private-model' })];
    const { memory, events } = memoryWith(before);
    await memory.wrap(fakeModel(), before).chat({ model: 'local-large', messages: [] });
    assert.deepEqual(memory.snapshot().loaded, [{ endpoint: 'omlx', model: UNCATALOGUED, gib: null, busy: false }]);
    await memory.modelsChanged(before, [endpoint({ 'local-large': 'big-27b' })]);
    assert.deepEqual(events, [{ type: 'unloaded', endpoint: 'omlx', model: UNCATALOGUED, reason: 'role-changed' }]);
    assert.ok(!JSON.stringify(events).includes('my-private-model'));
  });

  it('a catalogued model keeps its id in events', async () => {
    const before = [endpoint({ 'local-large': 'big-27b' })];
    const { memory, events } = memoryWith(before);
    await memory.modelsChanged(before, [endpoint({ 'local-large': 'mid-9b' })]);
    assert.deepEqual(events, [{ type: 'unloaded', endpoint: 'omlx', model: 'big-27b', reason: 'role-changed' }]);
  });

  it('an unload that hangs holds a load for at most the timeout', async () => {
    const config = [endpoint({ 'local-large': 'big-27b' }, GUARD)];
    const { memory } = memoryWith(config, { unload: () => new Promise<boolean>(() => undefined), unloadTimeoutMs: 20 });
    await memory.wrap(fakeModel(), config).chat({ model: 'local-large', messages: [] });
    const trial = [endpoint({ 'local-large': 'mid-9b' }, GUARD)];
    const started = Date.now();
    await memory.wrap(fakeModel(), trial).chat({ model: 'local-large', messages: [] });
    assert.ok(Date.now() - started < 2_000);
    assert.deepEqual(memory.snapshot().loaded.map(({ model }) => model), ['mid-9b']);
  });

  it('a model already in the account does not wait behind a slow unload of another', async () => {
    const config = [endpoint({ 'local-large': 'big-27b', 'local-small': 'small-4b' })];
    let finish: () => void = () => undefined;
    const { memory } = memoryWith(config, { unload: () => new Promise<boolean>((resolve) => { finish = () => { resolve(true); }; }) });
    const model = memory.wrap(fakeModel(), config);
    await model.chat({ model: 'local-large', messages: [] });
    await model.chat({ model: 'local-small', messages: [] });
    const changed = memory.modelsChanged(config, [endpoint({ 'local-large': 'big-27b', 'local-small': 'mid-9b' })]);
    await tick();
    let done = false;
    const chat = model.chat({ model: 'local-large', messages: [] }).then(() => { done = true; });
    await tick();
    await tick();
    assert.equal(done, true);
    finish();
    await changed;
    await chat;
  });

  it('a request that fails on a model it was to load leaves it out of the account', async () => {
    const config = [endpoint({ 'local-large': 'big-27b' })];
    const { memory } = memoryWith(config);
    const failing: LocalModel = { chat: () => Promise.reject(new LocalModelError('unavailable', 'down')) };
    await assert.rejects(memory.wrap(failing, config).chat({ model: 'local-large', messages: [] }));
    assert.deepEqual(memory.snapshot().loaded, []);
  });

  it('a request cancelled or timed out on a model it was loading keeps it in the account', async () => {
    const config = [endpoint({ 'local-large': 'big-27b', 'local-small': 'small-4b' })];
    const { memory } = memoryWith(config);
    const failing = (kind: 'cancelled' | 'timeout'): LocalModel => ({ chat: () => Promise.reject(new LocalModelError(kind, kind)) });
    await assert.rejects(memory.wrap(failing('cancelled'), config).chat({ model: 'local-large', messages: [] }));
    await assert.rejects(memory.wrap(failing('timeout'), config).chat({ model: 'local-small', messages: [] }));
    assert.deepEqual(memory.snapshot().loaded.map(({ model, busy }) => ({ model, busy })), [
      { model: 'big-27b', busy: false },
      { model: 'small-4b', busy: false },
    ]);
  });

  it('a model that answered once stays in the account even after an error that would prove otherwise', async () => {
    const config = [endpoint({ 'local-large': 'big-27b' })];
    const { memory } = memoryWith(config);
    await memory.wrap(fakeModel(), config).chat({ model: 'local-large', messages: [] });
    const down: LocalModel = { chat: () => Promise.reject(new LocalModelError('unavailable', 'down')) };
    await assert.rejects(memory.wrap(down, config).chat({ model: 'local-large', messages: [] }));
    assert.deepEqual(memory.snapshot().loaded.map(({ model }) => model), ['big-27b']);
  });

  it('a 404 or a 507 of the server on a new model leaves it out of the account', async () => {
    const config = [endpoint({ 'local-large': 'big-27b', 'local-small': 'small-4b' })];
    const { memory } = memoryWith(config);
    const http = (status: number): LocalModel => ({ chat: () => Promise.reject(new LocalModelError('http', String(status), { status })) });
    await assert.rejects(memory.wrap(http(404), config).chat({ model: 'local-large', messages: [] }));
    await assert.rejects(memory.wrap(http(507), config).chat({ model: 'local-small', messages: [] }));
    assert.deepEqual(memory.snapshot().loaded, []);
  });

  it('a request cancelled by its signal on a model in the account frees it, and the stale model is unloaded after', async () => {
    const before = [endpoint({ 'local-large': 'big-27b' })];
    const { memory, unloaded } = memoryWith(before);
    await memory.wrap(fakeModel(), before).chat({ model: 'local-large', messages: [] });
    const stop = new AbortController();
    const listening: LocalModel = {
      chat: (request) =>
        new Promise<ChatResult>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => { reject(new LocalModelError('cancelled', 'cancelled')); });
        }),
    };
    const running = memory.wrap(listening, before).chat({ model: 'local-large', messages: [], signal: stop.signal });
    await tick();
    assert.equal(memory.snapshot().loaded[0]?.busy, true);
    await memory.modelsChanged(before, [endpoint({ 'local-large': 'mid-9b' })]);
    assert.deepEqual(unloaded, []);
    stop.abort();
    await assert.rejects(running);
    await tick();
    await tick();
    assert.deepEqual(unloaded, ['big-27b']);
    assert.deepEqual(memory.snapshot().loaded, []);
  });

  it('after stop no unload and no event', async () => {
    const before = [endpoint({ 'local-large': 'big-27b' })];
    const { memory, unloaded, events } = memoryWith(before);
    memory.stop();
    await memory.modelsChanged(before, [endpoint({ 'local-large': 'mid-9b' })]);
    assert.deepEqual(unloaded, []);
    assert.deepEqual(events, []);
  });

  it('evicts a model of another endpoint, found among the endpoints of the wrapped model', async () => {
    const a = { ...endpoint({ 'local-large': 'mid-9b' }, GUARD), id: 'a' };
    const b = { ...endpoint({ 'local-large': 'big-27b' }, GUARD), id: 'b' };
    const where: string[] = [];
    // The current configuration no longer lists b: the fallback is the wrapped model's list.
    const { memory } = memoryWith([a], { unload: (config, name) => { where.push(`${config.id}:${name}`); return Promise.resolve(true); } });
    await memory.wrap(fakeModel(), [b]).chat({ model: 'local-large', messages: [] });
    await memory.wrap(fakeModel(), [a, b]).chat({ model: 'local-large', messages: [] });
    assert.deepEqual(where, ['b:big-27b']);
  });

  it('a catalog that throws does not stop a request: the model goes unestimated', async () => {
    const config = [endpoint({ 'local-large': 'big-27b' })];
    const errors: unknown[] = [];
    const { memory } = memoryWith(config, { catalog: () => { throw new Error('catalog being edited'); }, onError: (error) => errors.push(error) });
    await memory.wrap(fakeModel(), config).chat({ model: 'local-large', messages: [] });
    assert.equal(errors.length, 1);
    assert.deepEqual(memory.snapshot().loaded, [{ endpoint: 'omlx', model: UNCATALOGUED, gib: null, busy: false }]);
  });

  it('serverReset forgets a stale model waiting for its request: no unload after the restart', async () => {
    const before = [endpoint({ 'local-large': 'big-27b' })];
    const { memory, unloaded } = memoryWith(before);
    let open: () => void = () => undefined;
    const running = memory.wrap(fakeModel(new Promise<void>((resolve) => { open = resolve; })), before).chat({ model: 'local-large', messages: [] });
    await tick();
    await memory.modelsChanged(before, [endpoint({ 'local-large': 'mid-9b' })]);
    memory.serverReset('omlx');
    open();
    await running;
    await tick();
    assert.deepEqual(unloaded, []);
  });
});

describe('createModelMemory, unloadNow (I-3, stage M4)', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('unloads an idle model at once and takes it out of the account', async () => {
    const config = [endpoint({ 'local-large': 'big-27b' })];
    const { memory, unloaded, events } = memoryWith(config);
    await memory.wrap(fakeModel(), config).chat({ model: 'local-large', messages: [] });
    assert.equal(await memory.unloadNow(endpoint({ 'local-large': 'big-27b' }), 'big-27b'), 'unloaded');
    assert.deepEqual(unloaded, ['big-27b']);
    assert.deepEqual(events, [{ type: 'unloaded', endpoint: 'omlx', model: 'big-27b', reason: 'user' }]);
    assert.deepEqual(memory.snapshot().loaded, []);
  });

  it('refuses a model a request is using, and keeps it', async () => {
    const config = [endpoint({ 'local-large': 'big-27b' })];
    const { memory, unloaded } = memoryWith(config);
    let open: () => void = () => undefined;
    const running = memory.wrap(fakeModel(new Promise<void>((resolve) => { open = resolve; })), config).chat({ model: 'local-large', messages: [] });
    await tick();
    assert.equal(await memory.unloadNow(endpoint({ 'local-large': 'big-27b' }), 'big-27b'), 'busy');
    open();
    await running;
    assert.deepEqual(unloaded, []);
    assert.equal(memory.snapshot().loaded.length, 1);
  });

  it('refuses a model a call holds', async () => {
    const config = [endpoint({ 'local-voice': 'small-4b' })];
    const { memory, unloaded } = memoryWith(config, { pinned: () => true });
    await memory.wrap(fakeModel(), config).chat({ model: 'local-voice', messages: [] });
    assert.equal(await memory.unloadNow(endpoint({ 'local-voice': 'small-4b' }), 'small-4b'), 'busy');
    assert.deepEqual(unloaded, []);
  });

  it('keeps the model in the account when the server does not confirm', async () => {
    const config = [endpoint({ 'local-large': 'big-27b' })];
    const { memory, events } = memoryWith(config, { unload: () => Promise.resolve(false) });
    await memory.wrap(fakeModel(), config).chat({ model: 'local-large', messages: [] });
    assert.equal(await memory.unloadNow(endpoint({ 'local-large': 'big-27b' }), 'big-27b'), 'failed');
    assert.deepEqual(events, []);
    assert.equal(memory.snapshot().loaded.length, 1);
  });
});
