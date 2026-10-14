// oMLX restarted after a download from the "Modelli" page (D-201): never
// under a generation, once for several downloads, never for a server the core
// did not start. A fake list of servers and a fake restart; at the end a real
// restart of a fake oMLX run as a process.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, loadCuratedCatalog, resolveHome } from '@arianna/config';

import { createLocalReload, servedByLocalServer, type LocalReloadOptions } from '../src/local-reload.ts';
import { createLocalServers, type LocalServerEvent } from '../src/local-servers.ts';

type Server = ReturnType<LocalReloadOptions['servers']>[number];

const MANAGED: Server = { id: 'omlx', managed: true, adopted: false };

function setup(options: { servers?: Server[]; busy?: () => Promise<boolean>; restart?: (id: string) => Promise<boolean> } = {}) {
  const restarts: string[] = [];
  const events: { outcome: string; models: string }[] = [];
  const errors: unknown[] = [];
  const reload = createLocalReload({
    servers: () => options.servers ?? [MANAGED],
    restart:
      options.restart ??
      ((id) => {
        restarts.push(id);
        return Promise.resolve(true);
      }),
    busy: options.busy ?? (() => Promise.resolve(false)),
    checkMs: 2,
    onEvent: (payload) => events.push(payload),
    onError: (error) => errors.push(error),
  });
  return { reload, restarts, events, errors };
}

/** Busy for the first `count` checks, then free. */
function busyFor(count: number): { busy: () => Promise<boolean>; checks: () => number } {
  let checks = 0;
  return {
    busy: () => {
      checks += 1;
      return Promise.resolve(checks <= count);
    },
    checks: () => checks,
  };
}

describe('servedByLocalServer', () => {
  it('is true for an MLX model of oMLX, also one without a role yet', () => {
    assert.equal(servedByLocalServer({ runtime: 'mlx', roles: ['orchestrator', 'extractor'] }), true);
    assert.equal(servedByLocalServer({ runtime: 'mlx', roles: ['voice', 'tts'] }), true);
    assert.equal(servedByLocalServer({ runtime: 'mlx', roles: [] }), true);
  });

  it('is false for a model only of apps/voice and for another runtime', () => {
    assert.equal(servedByLocalServer({ runtime: 'mlx', roles: ['stt'] }), false);
    assert.equal(servedByLocalServer({ runtime: 'mlx', roles: ['stt', 'tts'] }), false);
    assert.equal(servedByLocalServer({ runtime: 'llama.cpp', roles: ['orchestrator'] }), false);
  });

  it('is false for a model of data/guard/models, whatever else it says (D-203)', () => {
    assert.equal(servedByLocalServer({ runtime: 'transformers', roles: ['pii'], dir: 'guard' }), false);
    assert.equal(servedByLocalServer({ runtime: 'mlx', roles: ['orchestrator'], dir: 'guard' }), false);
    assert.equal(servedByLocalServer({ runtime: 'mlx', roles: ['orchestrator'], dir: 'models' }), true);
  });

  it('is false for every pii model of the committed catalog: oMLX never restarts for it (D-203)', () => {
    const pii = loadCuratedCatalog(resolveHome({})).models.filter((model) => model.roles.includes('pii'));
    assert.ok(pii.length > 0);
    for (const model of pii) assert.equal(servedByLocalServer(model), false, model.id);
  });
});

describe('createLocalReload', () => {
  it('is idle with nothing downloaded', () => {
    const { reload, restarts } = setup();
    assert.deepEqual(reload.view(), { state: 'idle', models: [] });
    assert.deepEqual(restarts, []);
  });

  it('waits while a local model is at work, then restarts the server the core started', async () => {
    const gate = busyFor(3);
    const { reload, restarts, events } = setup({ busy: gate.busy });
    reload.request('fake-new');
    assert.deepEqual(reload.view(), { state: 'waiting', models: ['fake-new'] });
    await reload.idle();
    assert.ok(gate.checks() >= 4, 'checked again until free');
    assert.deepEqual(restarts, ['omlx']);
    assert.deepEqual(reload.view(), { state: 'idle', models: [] });
    assert.deepEqual(events, [
      { outcome: 'waiting', models: 'fake-new' },
      { outcome: 'restarted', models: 'fake-new' },
    ]);
  });

  it('never restarts while busy stays true', async () => {
    const { reload, restarts } = setup({ busy: () => Promise.resolve(true) });
    reload.request('fake-new');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(restarts, []);
    assert.equal(reload.view().state, 'waiting');
    reload.stop();
    await reload.idle();
    assert.deepEqual(restarts, []);
  });

  it('counts a check that fails as busy: no restart on a guess', async () => {
    let checks = 0;
    const { reload, restarts, errors } = setup({
      busy: () => {
        checks += 1;
        return checks <= 2 ? Promise.reject(new Error('database down')) : Promise.resolve(false);
      },
    });
    reload.request('fake-new');
    await reload.idle();
    assert.equal(errors.length, 2);
    assert.deepEqual(restarts, ['omlx']);
  });

  it('serves several downloads that end while it waits with one restart', async () => {
    let free = false;
    const { reload, restarts } = setup({ busy: () => Promise.resolve(!free) });
    reload.request('fake-a');
    reload.request('fake-b');
    reload.request('fake-a');
    assert.deepEqual(reload.view(), { state: 'waiting', models: ['fake-a', 'fake-b'] });
    free = true;
    await reload.idle();
    assert.deepEqual(restarts, ['omlx']);
  });

  it('shows the restart in progress, and a download during it gets a restart of its own', async () => {
    let release: (() => void) | undefined;
    const restarts: string[] = [];
    const { reload } = setup({
      restart: (id) => {
        restarts.push(id);
        if (restarts.length > 1) return Promise.resolve(true);
        return new Promise((resolve) => {
          release = () => {
            resolve(true);
          };
        });
      },
    });
    reload.request('fake-a');
    for (let tries = 0; tries < 200 && release === undefined; tries += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.deepEqual(reload.view(), { state: 'restarting', models: ['fake-a'] });
    reload.request('fake-b');
    assert.deepEqual(reload.view(), { state: 'restarting', models: ['fake-a', 'fake-b'] });
    release?.();
    await reload.idle();
    assert.deepEqual(restarts, ['omlx', 'omlx']);
    assert.deepEqual(reload.view(), { state: 'idle', models: [] });
  });

  it('restarts only the servers the core started; an adopted one is left to the user', async () => {
    const { reload, restarts, events } = setup({ servers: [MANAGED, { id: 'other', managed: true, adopted: true }, { id: 'watched', managed: false, adopted: false }] });
    reload.request('fake-new');
    await reload.idle();
    assert.deepEqual(restarts, ['omlx']);
    assert.deepEqual(reload.view(), { state: 'manual', models: ['fake-new'] });
    assert.equal(events.at(-1)?.outcome, 'restarted');
  });

  it('with only an adopted server restarts nothing and asks the user; a new download keeps naming the earlier one', async () => {
    let free = true;
    const { reload, restarts, events } = setup({ servers: [{ id: 'omlx', managed: true, adopted: true }], busy: () => Promise.resolve(!free) });
    reload.request('fake-new');
    await reload.idle();
    assert.deepEqual(restarts, []);
    assert.deepEqual(reload.view(), { state: 'manual', models: ['fake-new'] });
    assert.equal(events.at(-1)?.outcome, 'manual');
    free = false;
    reload.request('fake-other');
    assert.deepEqual(reload.view(), { state: 'waiting', models: ['fake-other', 'fake-new'] });
    reload.stop();
  });

  it('without local servers does nothing', async () => {
    const { reload, restarts } = setup({ servers: [] });
    reload.request('fake-new');
    await reload.idle();
    assert.deepEqual(restarts, []);
    assert.deepEqual(reload.view(), { state: 'idle', models: [] });
  });

  it('restarts at once on a free machine, with no waiting event', async () => {
    const { reload, restarts, events } = setup();
    reload.request('fake-new');
    await reload.idle();
    assert.deepEqual(restarts, ['omlx']);
    assert.deepEqual(events, [{ outcome: 'restarted', models: 'fake-new' }]);
  });

  it('a restart that fails stays on the page until the user closes it', async () => {
    const { reload, events, errors } = setup({ restart: () => Promise.reject(new Error('local servers stopped')) });
    reload.request('fake-new');
    await reload.idle();
    assert.equal(events.at(-1)?.outcome, 'failed');
    assert.equal(errors.length, 1);
    assert.deepEqual(reload.view(), { state: 'failed', models: ['fake-new'] });
    reload.dismiss();
    assert.deepEqual(reload.view(), { state: 'idle', models: [] });
  });

  it('a server that answers false to the restart counts as failed; a new download tries again with both models', async () => {
    let answer = false;
    const restarts: string[] = [];
    const { reload } = setup({
      restart: (id) => {
        restarts.push(id);
        return Promise.resolve(answer);
      },
    });
    reload.request('fake-a');
    await reload.idle();
    assert.equal(reload.view().state, 'failed');
    answer = true;
    reload.request('fake-b');
    await reload.idle();
    assert.deepEqual(restarts, ['omlx', 'omlx']);
    assert.deepEqual(reload.view(), { state: 'idle', models: [] });
  });

  it('"Riavvia oMLX" of the user while it waits serves the downloads: no second restart', async () => {
    let free = false;
    const { reload, restarts } = setup({ busy: () => Promise.resolve(!free) });
    reload.request('fake-new');
    assert.equal(reload.view().state, 'waiting');
    reload.restartedByUser();
    free = true;
    await reload.idle();
    assert.deepEqual(restarts, []);
    assert.deepEqual(reload.view(), { state: 'idle', models: [] });
  });

  it('"Riavvia oMLX" of the user also closes the line of a server to restart by hand', async () => {
    const { reload } = setup({ servers: [{ id: 'omlx', managed: false, adopted: false }] });
    reload.request('fake-new');
    await reload.idle();
    assert.equal(reload.view().state, 'manual');
    reload.restartedByUser();
    assert.deepEqual(reload.view(), { state: 'idle', models: [] });
  });

  it('dismiss does nothing while it waits or restarts', () => {
    const { reload } = setup({ busy: () => Promise.resolve(true) });
    reload.request('fake-new');
    reload.dismiss();
    assert.deepEqual(reload.view(), { state: 'waiting', models: ['fake-new'] });
    reload.stop();
  });

  it('after stop ignores new downloads', async () => {
    const { reload, restarts } = setup();
    reload.stop();
    reload.request('fake-new');
    await reload.idle();
    assert.deepEqual(restarts, []);
    assert.deepEqual(reload.view(), { state: 'idle', models: [] });
  });
});

describe('with a fake oMLX run as a process', () => {
  const root = join(resolveHome({}), DATA_DIR, 'test-tmp', `local-reload-${randomUUID()}`);
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('starts oMLX again once free: a new process, up again', async () => {
    mkdirSync(root, { recursive: true });
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    await new Promise<void>((resolve) => probe.close(() => { resolve(); }));
    if (address === null || typeof address === 'string') throw new Error('no port');
    const port = address.port;
    const events: LocalServerEvent[] = [];
    const servers = createLocalServers({
      home: resolveHome({}),
      dataDir: root,
      env: { PATH: process.env.PATH ?? '', HOME: root },
      onEvent: (event) => events.push(event),
      timing: { intervalMs: 50, startupTimeoutMs: 10_000, backoffMs: 10, stopGraceMs: 1_000 },
    });
    try {
      const fake = fileURLToPath(new URL('support/fake-omlx.ts', import.meta.url));
      await servers.sync([{ id: 'omlx', url: `http://127.0.0.1:${String(port)}/v1`, command: [process.execPath, fake, String(port)], models: {} }]);
      const spawns = (): number[] => events.flatMap((event) => (event.type === 'spawn' ? [event.pid] : []));
      assert.equal(spawns().length, 1);
      const reload = createLocalReload({ servers: () => servers.status(), restart: (id) => servers.restart(id), busy: () => Promise.resolve(false), checkMs: 2 });
      reload.request('fake-new');
      await reload.idle();
      assert.equal(spawns().length, 2);
      assert.notEqual(spawns()[0], spawns()[1]);
      assert.equal(servers.status()[0]?.state, 'up');
      assert.equal(servers.isAvailable('omlx'), true);
    } finally {
      await servers.stop();
    }
  });
});
