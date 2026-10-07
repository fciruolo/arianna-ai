// The actions of the "Modelli" page on a local model (I-3, stage M4, D-137):
// download, verify, remove into the bin, empty the bin, unload. Fake weights
// from a fake fetcher, a fake memory account, no database, no network.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { after, describe, it } from 'node:test';

import { DATA_DIR, resolveHome, type CatalogEntry, type ModelCatalog, type ModelRole } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { createModelActions, diskState, folderBytes, ModelActionError, TRASH_DIR, type ModelAction, type ModelActionsOptions, type UnloadOutcome } from '../src/model-actions.ts';
import type { Download, Fetcher } from '../src/model-files.ts';
import { startApiServer } from '../src/server/http.ts';

// Fake weights: random bytes, never a real model.
const WEIGHTS = randomBytes(40 * 1024 + 7);
const CONFIG = Buffer.from('{"fake": true}\n');
const sha = (body: Buffer): string => createHash('sha256').update(body).digest('hex');
const BODIES: Record<string, Buffer> = { 'https://example.org/weights.bin': WEIGHTS, 'https://example.org/config.json': CONFIG };

function entry(id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    family: 'fake',
    runtime: 'mlx',
    ramMinGib: 2,
    roles: ['orchestrator', 'extractor'],
    status: 'experimental',
    files: [
      { path: 'weights/model.bin', url: 'https://example.org/weights.bin', sizeBytes: WEIGHTS.length, sha256: sha(WEIGHTS) },
      { path: 'config.json', url: 'https://example.org/config.json', sizeBytes: CONFIG.length, sha256: sha(CONFIG) },
    ],
    ...overrides,
  };
}

const CATALOG: ModelCatalog = {
  version: 1,
  models: [
    entry('fake-a'),
    entry('fake-b'),
    // A catalog whose sha256 is wrong for what the server sends.
    entry('fake-bad', { files: [{ path: 'model.bin', url: 'https://example.org/weights.bin', sizeBytes: WEIGHTS.length, sha256: 'b'.repeat(64) }] }),
  ],
};

const ROOT = join(resolveHome({}), DATA_DIR, 'test-tmp', `model-actions-${randomUUID()}`);
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Serves the bodies from the requested offset, like a server with Range. */
function fakeFetch(seen: { url: string; offset: number }[] = []): Fetcher {
  return (url, offset): Promise<Download> => {
    seen.push({ url, offset });
    const body = BODIES[url];
    if (body === undefined) return Promise.resolve({ status: 404, body: Readable.from([]) });
    if (offset === 0) return Promise.resolve({ status: 200, body: Readable.from([body]) });
    return Promise.resolve({ status: 206, body: Readable.from([body.subarray(offset)]), contentRange: `bytes ${String(offset)}-${String(body.length - 1)}/${String(body.length)}` });
  };
}

interface Setup {
  data: string;
  events: { kind: string; payload: Record<string, string | number> }[];
  roles: Partial<Record<ModelRole, string>>;
  loaded: Map<string, { endpoint: string; busy: boolean }[]>;
  trials: Set<string>;
  unloads: string[];
  unloadOutcome: UnloadOutcome;
}

function setup(extra: Partial<ModelActionsOptions> = {}) {
  const state: Setup = { data: join(ROOT, randomUUID()), events: [], roles: {}, loaded: new Map(), trials: new Set(), unloads: [], unloadOutcome: 'unloaded' };
  mkdirSync(state.data, { recursive: true });
  const actions = createModelActions({
    catalog: () => CATALOG,
    dataDir: state.data,
    roles: () => state.roles,
    fetch: fakeFetch(),
    loaded: (id) => state.loaded.get(id) ?? [],
    unload: (id) => {
      state.unloads.push(id);
      return Promise.resolve(state.unloadOutcome);
    },
    trialOpen: (id) => Promise.resolve(state.trials.has(id)),
    onEvent: (kind, payload) => state.events.push({ kind, payload }),
    freeBytes: () => 1e12,
    now: () => new Date('2026-10-07T21:00:00.000Z'),
    ...extra,
  });
  return { actions, state };
}

/** Waits for the end of the action in progress of the model. */
async function settled(actions: ReturnType<typeof setup>['actions'], id: string): Promise<ModelAction> {
  for (let tries = 0; tries < 500; tries += 1) {
    const action = actions.list().find((item) => item.modelId === id);
    if (action !== undefined && action.status !== 'running') return action;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('the action did not end');
}

function modelDir(data: string, id: string): string {
  return join(data, 'models', id);
}

function install(data: string, id: string): void {
  mkdirSync(join(modelDir(data, id), 'weights'), { recursive: true });
  writeFileSync(join(modelDir(data, id), 'weights', 'model.bin'), WEIGHTS);
  writeFileSync(join(modelDir(data, id), 'config.json'), CONFIG);
}

const code = (expected: ModelActionError['code']) => (error: unknown) => error instanceof ModelActionError && error.code === expected;

/** Events carry the model id, the outcome and counts: never a path of the machine. */
function assertNoPaths(events: Setup['events'], data: string): void {
  for (const { payload } of events) {
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(data) && !text.includes('/'), text);
    for (const key of Object.keys(payload)) assert.ok(['modelId', 'outcome', 'error', 'bad', 'removed'].includes(key), key);
  }
}

describe('download', () => {
  it('downloads every file of a missing model in the background, with progress and L0 events', async () => {
    const { actions, state } = setup();
    const started = actions.download('fake-a');
    assert.equal(started.status, 'running');
    assert.equal(started.bytesTotal, WEIGHTS.length + CONFIG.length);
    const done = await settled(actions, 'fake-a');
    assert.equal(done.status, 'done');
    assert.equal(done.bytesDone, done.bytesTotal);
    assert.deepEqual(readFileSync(join(modelDir(state.data, 'fake-a'), 'weights', 'model.bin')), WEIGHTS);
    assert.deepEqual(diskState(state.data, entry('fake-a')), { hasFiles: true, missingBytes: 0 });
    assert.deepEqual(state.events, [
      { kind: 'model.download.started', payload: { modelId: 'fake-a' } },
      { kind: 'model.download.finished', payload: { modelId: 'fake-a', outcome: 'ok' } },
    ]);
    assertNoPaths(state.events, state.data);
  });

  it('resumes a partial file from its .part', async () => {
    const seen: { url: string; offset: number }[] = [];
    const { actions, state } = setup({ fetch: fakeFetch(seen) });
    mkdirSync(join(modelDir(state.data, 'fake-a'), 'weights'), { recursive: true });
    writeFileSync(join(modelDir(state.data, 'fake-a'), 'weights', 'model.bin.part'), WEIGHTS.subarray(0, 1000));
    assert.equal(diskState(state.data, entry('fake-a')).missingBytes, WEIGHTS.length - 1000 + CONFIG.length);
    const started = actions.download('fake-a');
    assert.equal(started.status, 'running');
    assert.equal((await settled(actions, 'fake-a')).status, 'done');
    assert.deepEqual(seen[0], { url: 'https://example.org/weights.bin', offset: 1000 });
    assert.deepEqual(readFileSync(join(modelDir(state.data, 'fake-a'), 'weights', 'model.bin')), WEIGHTS);
  });

  it('fails on a sha256 the catalog does not list, with the code and no file installed', async () => {
    const { actions, state } = setup();
    actions.download('fake-bad');
    const done = await settled(actions, 'fake-bad');
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'wrong-hash');
    assert.equal(existsSync(join(modelDir(state.data, 'fake-bad'), 'model.bin')), false);
    assert.deepEqual(state.events.at(-1), { kind: 'model.download.finished', payload: { modelId: 'fake-bad', outcome: 'failed', error: 'wrong-hash' } });
  });

  it('refuses a model out of the catalog, a path, the bin, a model already on the disk, a second action and a full disk', async () => {
    const { actions, state } = setup();
    assert.throws(() => actions.download('nope'), code('not-found'));
    assert.throws(() => actions.download('../fake-a'), code('not-found'));
    assert.throws(() => actions.download(TRASH_DIR), code('not-found'));
    install(state.data, 'fake-b');
    assert.throws(() => actions.download('fake-b'), code('conflict'));
    actions.download('fake-a');
    assert.throws(() => actions.download('fake-bad'), code('conflict'));
    assert.throws(() => actions.verify('fake-b'), code('conflict'));
    await settled(actions, 'fake-a');
    const full = setup({ freeBytes: () => 10 });
    assert.throws(() => full.actions.download('fake-a'), code('conflict'));
    assert.deepEqual(full.state.events, []);
    // A file of the wrong size counts once: exactly the room it needs is enough.
    const exact = setup({ freeBytes: () => WEIGHTS.length });
    install(exact.state.data, 'fake-a');
    writeFileSync(join(modelDir(exact.state.data, 'fake-a'), 'weights', 'model.bin'), WEIGHTS.subarray(0, 10));
    assert.equal(exact.actions.download('fake-a').bytesTotal, WEIGHTS.length);
    assert.equal((await settled(exact.actions, 'fake-a')).status, 'done');
    assert.equal(exact.actions.trash().entries.length, 1);
  });

  it('is stopped by cancel: the .part stays and the outcome is cancelled', async () => {
    const stalled = new PassThrough();
    const { actions, state } = setup({
      fetch: () => {
        stalled.write(WEIGHTS.subarray(0, 500));
        return Promise.resolve({ status: 200, body: stalled });
      },
    });
    actions.download('fake-a');
    // The first bytes reach the .part before the cancel.
    for (let tries = 0; tries < 200 && (actions.list()[0]?.bytesDone ?? 0) === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(actions.cancel('fake-a').status, 'running');
    const done = await settled(actions, 'fake-a');
    assert.equal(done.status, 'cancelled');
    assert.ok(existsSync(join(modelDir(state.data, 'fake-a'), 'weights', 'model.bin.part')));
    assert.deepEqual(state.events.at(-1), { kind: 'model.download.finished', payload: { modelId: 'fake-a', outcome: 'cancelled', error: 'cancelled' } });
    assert.throws(() => actions.cancel('fake-a'), code('conflict'));
  });
});

describe('verify', () => {
  it('hashes every file: ok when they match', async () => {
    const { actions, state } = setup();
    install(state.data, 'fake-a');
    actions.verify('fake-a');
    const done = await settled(actions, 'fake-a');
    assert.equal(done.status, 'done');
    assert.deepEqual(done.bad, []);
    assert.deepEqual(state.events.at(-1), { kind: 'model.verify.finished', payload: { modelId: 'fake-a', outcome: 'ok', bad: 0 } });
  });

  it('names a file of the right size with the wrong sha256, and a download then replaces it, the wrong one into the bin', async () => {
    const { actions, state } = setup();
    install(state.data, 'fake-a');
    const flipped = Buffer.from(WEIGHTS);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    writeFileSync(join(modelDir(state.data, 'fake-a'), 'weights', 'model.bin'), flipped);
    actions.verify('fake-a');
    const verified = await settled(actions, 'fake-a');
    assert.deepEqual(verified.bad, ['weights/model.bin']);
    assert.deepEqual(state.events.at(-1), { kind: 'model.verify.finished', payload: { modelId: 'fake-a', outcome: 'mismatch', bad: 1 } });
    // Only the wrong file is downloaded again.
    assert.equal(actions.download('fake-a').bytesTotal, WEIGHTS.length);
    assert.equal((await settled(actions, 'fake-a')).status, 'done');
    assert.deepEqual(readFileSync(join(modelDir(state.data, 'fake-a'), 'weights', 'model.bin')), WEIGHTS);
    const trash = actions.trash();
    assert.equal(trash.entries.length, 1);
    assert.equal(trash.sizeBytes, WEIGHTS.length);
    assert.match(trash.entries[0]?.name ?? '', /^2026-10-07T21-00-00-000Z-fake-a$/);
    assertNoPaths(state.events, state.data);
  });

  it('refuses a model with files missing', () => {
    const { actions } = setup();
    assert.throws(() => actions.verify('fake-a'), code('conflict'));
    assert.throws(() => actions.verify('nope'), code('not-found'));
  });
});

describe('remove and the bin', () => {
  it('moves the folder into data/models/eliminati with the id typed, never erasing it', async () => {
    const { actions, state } = setup();
    install(state.data, 'fake-a');
    const result = await actions.remove('fake-a', 'fake-a');
    assert.deepEqual(result, { modelId: 'fake-a', folder: `data/models/${TRASH_DIR}/2026-10-07T21-00-00-000Z-fake-a` });
    assert.equal(existsSync(modelDir(state.data, 'fake-a')), false);
    const moved = join(state.data, 'models', TRASH_DIR, '2026-10-07T21-00-00-000Z-fake-a', 'weights', 'model.bin');
    assert.deepEqual(readFileSync(moved), WEIGHTS);
    assert.deepEqual(state.events, [{ kind: 'model.removed', payload: { modelId: 'fake-a', outcome: 'ok' } }]);
    assert.equal(diskState(state.data, entry('fake-a')).hasFiles, false);
  });

  it('removes a partial download too', async () => {
    const { actions, state } = setup();
    mkdirSync(modelDir(state.data, 'fake-a'), { recursive: true });
    writeFileSync(join(modelDir(state.data, 'fake-a'), 'config.json.part'), 'x');
    assert.equal(diskState(state.data, entry('fake-a')).hasFiles, true);
    await actions.remove('fake-a', 'fake-a');
    assert.equal(existsSync(modelDir(state.data, 'fake-a')), false);
  });

  it('refuses without the id, for a model with a role, loaded, under trial, downloading or with nothing on the disk', async () => {
    const { actions, state } = setup();
    install(state.data, 'fake-a');
    await assert.rejects(actions.remove('fake-a', 'fake'), code('invalid'));
    await assert.rejects(actions.remove('fake-a', true), code('invalid'));
    state.roles = { orchestrator: 'fake-a', extractor: 'fake-a' };
    await assert.rejects(actions.remove('fake-a', 'fake-a'), (error: unknown) => code('conflict')(error) && /orchestrator, extractor/.test((error as Error).message));
    state.roles = { orchestrator: 'fake-bad' };
    state.loaded.set('fake-a', [{ endpoint: 'omlx', busy: false }]);
    await assert.rejects(actions.remove('fake-a', 'fake-a'), code('conflict'));
    state.loaded.clear();
    state.trials.add('fake-a');
    await assert.rejects(actions.remove('fake-a', 'fake-a'), code('conflict'));
    state.trials.clear();
    state.roles = {};
    actions.download('fake-bad');
    await assert.rejects(actions.remove('fake-bad', 'fake-bad'), code('conflict'));
    await settled(actions, 'fake-bad');
    await assert.rejects(actions.remove('fake-b', 'fake-b'), code('not-found'));
    await assert.rejects(actions.remove(TRASH_DIR, TRASH_DIR), code('not-found'));
    assert.ok(existsSync(modelDir(state.data, 'fake-a')));
    assert.equal(state.events.some(({ kind }) => kind === 'model.removed'), false);
  });

  it('empties the bin only with confirm: true, and tells how much it freed', async () => {
    const { actions, state } = setup();
    assert.deepEqual(actions.trash(), { folder: `data/models/${TRASH_DIR}`, entries: [], sizeBytes: 0 });
    install(state.data, 'fake-a');
    await actions.remove('fake-a', 'fake-a');
    assert.equal(actions.trash().sizeBytes, WEIGHTS.length + CONFIG.length);
    assert.throws(() => actions.emptyTrash('yes'), code('invalid'));
    assert.equal(actions.trash().entries.length, 1);
    assert.deepEqual(actions.emptyTrash(true), { removed: 1, sizeBytes: WEIGHTS.length + CONFIG.length });
    assert.deepEqual(readdirSync(join(state.data, 'models', TRASH_DIR)), []);
    assert.deepEqual(state.events.at(-1), { kind: 'model.trash.emptied', payload: { outcome: 'ok', removed: 1 } });
  });

  it('counts a folder without following links out of it, and empties a link without touching what it points at', () => {
    const outside = join(ROOT, randomUUID());
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'big'), Buffer.alloc(100_000));
    const dir = join(ROOT, randomUUID());
    mkdirSync(join(dir, 'inner'), { recursive: true });
    writeFileSync(join(dir, 'inner', 'a'), 'abc');
    symlinkSync(outside, join(dir, 'inner', 'link'));
    assert.ok(folderBytes(dir) < 1000);
    const { actions, state } = setup();
    const bin = join(state.data, 'models', TRASH_DIR);
    mkdirSync(bin, { recursive: true });
    symlinkSync(outside, join(bin, 'linked'));
    assert.ok(actions.trash().sizeBytes < 1000);
    assert.equal(actions.emptyTrash(true).removed, 1);
    assert.ok(existsSync(join(outside, 'big')));
  });

  it('refuses to empty the bin while a download runs', async () => {
    const { actions, state } = setup();
    install(state.data, 'fake-b');
    await actions.remove('fake-b', 'fake-b');
    actions.download('fake-a');
    assert.throws(() => actions.emptyTrash(true), code('conflict'));
    await settled(actions, 'fake-a');
    assert.equal(actions.trash().entries.length, 1);
  });

  it('checks again after waiting for the trials: a download started meanwhile stops the removal', async () => {
    let release: () => void = () => undefined;
    const { actions, state } = setup({ trialOpen: () => new Promise<boolean>((resolve) => { release = () => { resolve(false); }; }) });
    mkdirSync(modelDir(state.data, 'fake-a'), { recursive: true });
    const removing = actions.remove('fake-a', 'fake-a');
    actions.download('fake-a');
    release();
    await assert.rejects(removing, code('conflict'));
    await settled(actions, 'fake-a');
    assert.ok(existsSync(join(modelDir(state.data, 'fake-a'), 'config.json')));
  });

  it('two removals in the same millisecond get two folders of the bin', async () => {
    const { actions, state } = setup();
    install(state.data, 'fake-a');
    await actions.remove('fake-a', 'fake-a');
    install(state.data, 'fake-a');
    const second = await actions.remove('fake-a', 'fake-a');
    assert.match(second.folder, /-fake-a-2$/);
    assert.equal(actions.trash().entries.length, 2);
  });
});

describe('unload', () => {
  it('unloads a loaded idle model and leaves an event', async () => {
    const { actions, state } = setup();
    state.loaded.set('fake-a', [{ endpoint: 'omlx', busy: false }]);
    assert.deepEqual(await actions.unload('fake-a'), { modelId: 'fake-a', outcome: 'unloaded' });
    assert.deepEqual(state.unloads, ['fake-a']);
    assert.deepEqual(state.events, [{ kind: 'model.unloaded', payload: { modelId: 'fake-a', outcome: 'unloaded' } }]);
  });

  it('refuses a model not loaded or at work, and says when the memory found it busy', async () => {
    const { actions, state } = setup();
    await assert.rejects(actions.unload('fake-a'), code('conflict'));
    state.loaded.set('fake-a', [{ endpoint: 'omlx', busy: true }]);
    await assert.rejects(actions.unload('fake-a'), code('conflict'));
    assert.deepEqual(state.unloads, []);
    state.loaded.set('fake-a', [{ endpoint: 'omlx', busy: false }]);
    state.unloadOutcome = 'busy';
    await assert.rejects(actions.unload('fake-a'), code('conflict'));
    await assert.rejects(actions.unload('nope'), code('not-found'));
  });
});

describe('routes', () => {
  async function post(origin: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = httpRequest(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> });
        });
      });
      request.on('error', reject);
      request.end(payload);
    });
  }

  async function server(withActions: boolean) {
    const { actions, state } = setup();
    const api = await startApiServer({
      // Unused by these routes.
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      ...(withActions ? { modelActions: actions } : {}),
    });
    return { api, actions, state, origin: `http://127.0.0.1:${String(api.port)}` };
  }

  it('starts, refuses and confirms with the status codes of the API', async () => {
    const { api, actions, state, origin } = await server(true);
    try {
      const started = await post(origin, '/api/models/fake-a/download', {});
      assert.equal(started.status, 202);
      assert.equal((started.body.action as ModelAction).modelId, 'fake-a');
      await settled(actions, 'fake-a');
      assert.equal((await post(origin, '/api/models/nope/download', {})).status, 404);
      assert.equal((await post(origin, '/api/models/fake-a/download', {})).status, 409);
      assert.equal((await post(origin, '/api/models/fake-a/download', { url: 'https://elsewhere' })).status, 400);
      assert.equal((await post(origin, '/api/models/fake-a/remove', { confirm: 'wrong' })).status, 400);
      state.roles = { orchestrator: 'fake-a' };
      const refused = await post(origin, '/api/models/fake-a/remove', { confirm: 'fake-a' });
      assert.equal(refused.status, 409);
      assert.match(String(refused.body.error), /role orchestrator/);
      state.roles = {};
      assert.equal((await post(origin, '/api/models/fake-a/verify', {})).status, 202);
      await settled(actions, 'fake-a');
      const removed = await post(origin, '/api/models/fake-a/remove', { confirm: 'fake-a' });
      assert.equal(removed.status, 200);
      assert.match(String(removed.body.folder), /^data\/models\/eliminati\//);
      assert.equal((await post(origin, '/api/models/trash/empty', {})).status, 400);
      assert.deepEqual((await post(origin, '/api/models/trash/empty', { confirm: true })).body, { removed: 1, sizeBytes: WEIGHTS.length + CONFIG.length });
      assert.equal((await post(origin, '/api/models/fake-a/unload', {})).status, 409);
    } finally {
      await api.close();
    }
  });

  it('answers 404 when the core has no actions', async () => {
    const { api, origin } = await server(false);
    try {
      assert.equal((await post(origin, '/api/models/fake-a/download', {})).status, 404);
      assert.equal((await post(origin, '/api/models/trash/empty', { confirm: true })).status, 404);
    } finally {
      await api.close();
    }
  });
});
