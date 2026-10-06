// The list of the "Modelli" page (I-3, stage M2) from fake catalogs, a fake
// memory account and fake trials: no database, no local server, no network.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { DATA_DIR, defaultCloudModels, parseCloudCatalog, resolveHome, type CatalogEntry, type CloudCatalog, type ModelCatalog } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { weightsDigest } from '../src/model-evals.ts';
import type { MemorySnapshot } from '../src/model-memory.ts';
import { buildModelsOverview, loadModelsOverview, type LastEval, type OverviewInputs } from '../src/models-overview.ts';
import { startApiServer } from '../src/server/http.ts';

const SHA = 'a'.repeat(64);

function entry(id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    family: 'fake',
    runtime: 'mlx',
    ramMinGib: 8,
    roles: ['orchestrator'],
    status: 'experimental',
    files: [
      { path: 'model.safetensors', url: 'https://example.org/model.safetensors', sizeBytes: 20, sha256: SHA },
      { path: 'config.json', url: 'https://example.org/config.json', sizeBytes: 5, sha256: SHA },
    ],
    ...overrides,
  };
}

const LARGE = entry('fake-large', { provider: 'Fake Lab', strengths: ['Pianifica bene'], license: 'Apache-2.0', source: 'https://example.org/fake-large' });
const SMALL = entry('fake-small', { roles: ['extractor', 'voice'], ramMinGib: 3 });
const SPARE = entry('fake-spare');
const CATALOG: ModelCatalog = { version: 1, models: [LARGE, SMALL, SPARE] };

const CLOUD: CloudCatalog = parseCloudCatalog(`
version: 1
sources:
  - id: fake-page
    url: https://example.org/models
    read: "2026-10-01"
models:
  - alias: opus
    provider: Fake Provider
    family: Claude Opus
    executor: claude
    names:
      - name: claude-opus-9-9
        context_tokens: 1000
        source: fake-page
`);

const MEMORY: MemorySnapshot = {
  memoryGib: 64,
  budgets: [{ endpoint: 'omlx', gib: 48 }],
  loaded: [
    { endpoint: 'omlx', model: 'fake-large', gib: 8, busy: true },
    { endpoint: 'omlx', model: 'uncatalogued', gib: null, busy: false },
  ],
  estimatedGib: 8,
  swap: null,
};

const LAST: LastEval[] = [
  {
    id: '7',
    modelId: 'fake-large',
    role: 'orchestrator',
    status: 'passed',
    passed: 9,
    total: 10,
    latencyMedianMs: 1200,
    requestedAt: new Date('2026-10-01T10:00:00Z'),
    finishedAt: new Date('2026-10-01T10:05:00Z'),
    weightsSha256: weightsDigest(LARGE),
  },
  {
    id: '8',
    modelId: 'fake-spare',
    role: 'orchestrator',
    status: 'failed',
    passed: 2,
    total: 10,
    latencyMedianMs: 900,
    requestedAt: new Date('2026-10-02T10:00:00Z'),
    finishedAt: new Date('2026-10-02T10:05:00Z'),
    weightsSha256: 'b'.repeat(64),
  },
];

function inputs(overrides: Partial<OverviewInputs> = {}): OverviewInputs {
  return {
    catalog: CATALOG,
    cloudCatalog: CLOUD,
    config: {
      roles: { orchestrator: 'fake-large', extractor: 'fake-small', voice: 'fake-small' },
      cloud: { executors: ['claude'], models: { ...defaultCloudModels(), fable: { enabled: false }, opus: { enabled: true, name: 'claude-opus-9-9' } } },
      agents: { coder: { model: 'opus' }, revisore: { model: 'opus' }, grafico: {} },
    },
    present: (model) => model.id !== 'fake-spare',
    memory: MEMORY,
    lastEvals: LAST,
    adapters: { claude: true, codex: false },
    ...overrides,
  };
}

describe('buildModelsOverview', () => {
  it('lists every catalog model with its card, roles, aliases, agents and state', () => {
    const overview = buildModelsOverview(inputs());
    assert.deepEqual(
      overview.local.map(({ id, state, roles, aliases, agents }) => ({ id, state, roles, aliases, agents })),
      [
        { id: 'fake-large', state: 'loaded', roles: ['orchestrator'], aliases: ['local-large'], agents: ['arianna'] },
        { id: 'fake-small', state: 'on-disk', roles: ['extractor', 'voice'], aliases: ['local-small', 'local-voice'], agents: [] },
        { id: 'fake-spare', state: 'missing', roles: [], aliases: [], agents: [] },
      ],
    );
    const [large] = overview.local;
    assert.ok(large !== undefined);
    assert.equal(large.locality, 'local');
    assert.equal(large.sizeBytes, 25);
    assert.equal(large.provider, 'Fake Lab');
    assert.deepEqual(large.strengths, ['Pianifica bene']);
    assert.equal(large.license, 'Apache-2.0');
    assert.equal(large.contextTokens, null);
    assert.deepEqual(large.loaded, [{ endpoint: 'omlx', gib: 8, busy: true }]);
    assert.deepEqual(large.suitedRoles, ['orchestrator']);
  });

  it('gives each local model the steps of its aliases, from the router', () => {
    const [large, small, spare] = buildModelsOverview(inputs()).local;
    assert.deepEqual(large?.uses.map(({ kind, tier, fallback }) => `${kind}:${String(tier)}${fallback === true ? ' fallback' : ''}`), [
      'extract:1',
      'classify:1',
      'summarize:1',
      'plan:0',
      'judge:0',
      'coding:0 fallback',
      'review:0 fallback',
    ]);
    // local-voice is not a step of the router: the extractor's steps only.
    assert.deepEqual(small?.uses.map(({ kind, tier }) => `${kind}:${String(tier)}`), ['extract:0', 'classify:0', 'summarize:0']);
    assert.deepEqual(spare?.uses, []);
  });

  it('a model serving both local aliases keeps the best tier of each step', () => {
    const both = buildModelsOverview(inputs({ config: { ...inputs().config, roles: { orchestrator: 'fake-large', extractor: 'fake-large' } } }));
    const large = both.local[0];
    assert.deepEqual(large?.aliases, ['local-large', 'local-small']);
    assert.equal(large.uses.find(({ kind }) => kind === 'extract')?.tier, 0);
    assert.equal(large.uses.find(({ kind }) => kind === 'plan')?.tier, 0);
  });

  it('says whether the last trial ran on the weights listed now', () => {
    const [large, small, spare] = buildModelsOverview(inputs()).local;
    assert.equal(large?.lastEval?.status, 'passed');
    assert.equal(large.lastEval.sameWeights, true);
    assert.equal(small?.lastEval, null);
    assert.equal(spare?.lastEval?.sameWeights, false);
    assert.equal(Object.keys(spare.lastEval).includes('weightsSha256'), false);
  });

  it('lists the four cloud aliases with switch, name, state, budget and agents', () => {
    const cloud = buildModelsOverview(inputs()).cloud;
    assert.deepEqual(
      cloud.map(({ alias, executor, enabled, name, state, budgetApproval, agents }) => ({ alias, executor, enabled, name, state, budgetApproval, agents })),
      [
        { alias: 'sonnet', executor: 'claude', enabled: true, name: null, state: 'on', budgetApproval: false, agents: [] },
        { alias: 'opus', executor: 'claude', enabled: true, name: 'claude-opus-9-9', state: 'on', budgetApproval: false, agents: ['coder', 'revisore'] },
        { alias: 'fable', executor: 'claude', enabled: false, name: null, state: 'off', budgetApproval: true, agents: [] },
        { alias: 'codex', executor: 'codex', enabled: true, name: null, state: 'not-connected', budgetApproval: false, agents: [] },
      ],
    );
    assert.equal(cloud[1]?.card?.names[0]?.contextTokens, 1000);
    assert.equal(cloud[0]?.card, null);
    assert.deepEqual(cloud[0].uses.map(({ kind, tier }) => `${kind}:${String(tier)}`), ['coding:0', 'review:0']);
  });

  it('an executor left out of [cloud] executors, or without an adapter, is never "on"', () => {
    const off = buildModelsOverview(inputs({ config: { ...inputs().config, cloud: { executors: [], models: defaultCloudModels() } } })).cloud;
    assert.deepEqual(off.map(({ state }) => state), ['executor-off', 'executor-off', 'executor-off', 'not-connected']);
    const noAdapter = buildModelsOverview(inputs({ adapters: { claude: false, codex: false } })).cloud;
    assert.equal(noAdapter.some(({ state }) => state === 'on'), false);
    // An adapter for Codex (task 1.16) with codex enabled turns it on.
    const codex = buildModelsOverview(inputs({ adapters: { claude: true, codex: true }, config: { ...inputs().config, cloud: { executors: ['codex'], models: defaultCloudModels() } } })).cloud;
    assert.deepEqual(codex.map(({ state }) => state), ['executor-off', 'executor-off', 'executor-off', 'on']);
  });

  it('keeps the memory totals, not the loaded list, and null without an account', () => {
    assert.deepEqual(buildModelsOverview(inputs()).memory, { memoryGib: 64, budgets: [{ endpoint: 'omlx', gib: 48 }], estimatedGib: 8, swap: null });
    assert.equal(buildModelsOverview(inputs({ memory: undefined })).memory, null);
    assert.equal(buildModelsOverview(inputs({ memory: undefined })).local[0]?.state, 'on-disk');
  });

  it('puts on each local model what is on the disk and its last action, and carries the bin (I-3, M4)', () => {
    const plain = buildModelsOverview(inputs());
    assert.equal(plain.trash, null);
    assert.deepEqual(
      plain.local.map(({ id, hasFiles, missingBytes, action }) => ({ id, hasFiles, missingBytes, action })),
      plain.local.map(({ id, present }) => ({ id, hasFiles: present, missingBytes: present ? 0 : 25, action: null })),
    );
    const action = { modelId: 'fake-spare', kind: 'download' as const, status: 'running' as const, bytesDone: 5, bytesTotal: 25, startedAt: '2026-10-07T21:00:00.000Z', finishedAt: null, error: null, bad: [] };
    const trash = { folder: 'data/models/eliminati', entries: [{ name: '2026-10-07T21-00-00-000Z-fake-old', sizeBytes: 9 }], sizeBytes: 9 };
    const overview = buildModelsOverview(inputs({ actions: [action], trash, disk: (model) => ({ hasFiles: model.id !== 'fake-small', missingBytes: model.id === 'fake-spare' ? 20 : 0 }) }));
    const spare = overview.local.find(({ id }) => id === 'fake-spare');
    assert.deepEqual(spare?.action, action);
    assert.equal(spare.missingBytes, 20);
    assert.equal(overview.local.find(({ id }) => id === 'fake-small')?.hasFiles, false);
    assert.equal(overview.local.find(({ id }) => id === 'fake-large')?.action, null);
    assert.deepEqual(overview.trash, trash);
  });

  it('carries the sources of the cards and no error by default', () => {
    const overview = buildModelsOverview(inputs());
    assert.deepEqual(overview.sources, [{ id: 'fake-page', url: 'https://example.org/models', read: '2026-10-01' }]);
    assert.deepEqual(overview.errors, { catalog: null, cloudCatalog: null, evals: null });
  });
});

describe('loadModelsOverview', () => {
  const root = join(resolveHome({}), DATA_DIR, 'test-tmp', `models-overview-${randomUUID()}`);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const noTrials = { unsafe: () => Promise.resolve([]) } as unknown as Sql;
  const options = {
    home,
    dataDir,
    config: () => inputs().config,
    adapters: () => ({ claude: true, codex: false }),
  };

  before(() => {
    mkdirSync(join(home, 'config'), { recursive: true });
    mkdirSync(join(dataDir, 'models', 'fake-small'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'models.catalog.yaml'),
      `version: 1\nmodels:\n  - id: fake-small\n    family: fake\n    runtime: mlx\n    ram_min_gib: 3\n    roles: [extractor]\n    status: experimental\n    provider: Fake Lab\n    files:\n      - path: model.bin\n        url: https://example.org/model.bin\n        size_bytes: 5\n        sha256: "${SHA}"\n  - id: fake-missing\n    family: fake\n    runtime: mlx\n    ram_min_gib: 3\n    roles: [extractor]\n    status: experimental\n    files:\n      - path: model.bin\n        url: https://example.org/model.bin\n        size_bytes: 5\n        sha256: "${SHA}"\n`,
    );
    writeFileSync(join(dataDir, 'models', 'fake-small', 'model.bin'), 'fake!');
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads both catalogs and the files on disk at each request', async () => {
    writeFileSync(join(home, 'config', 'cloud-models.catalog.yaml'), 'version: 1\nsources: []\nmodels:\n  - alias: codex\n    provider: Fake\n    family: Fake Codex\n    executor: codex\n');
    const overview = await loadModelsOverview(noTrials, { ...options, config: () => ({ ...inputs().config, roles: { extractor: 'fake-small' } }) });
    assert.deepEqual(overview.local.map(({ id, state, provider }) => ({ id, state, provider })), [
      { id: 'fake-small', state: 'on-disk', provider: 'Fake Lab' },
      { id: 'fake-missing', state: 'missing', provider: null },
    ]);
    assert.equal(overview.cloud.find(({ alias }) => alias === 'codex')?.card?.family, 'Fake Codex');
    assert.equal(overview.memory, null);
    assert.deepEqual(overview.errors, { catalog: null, cloudCatalog: null, evals: null });
  });

  it('a file of the wrong size is not present', async () => {
    writeFileSync(join(dataDir, 'models', 'fake-small', 'model.bin'), 'fake');
    const overview = await loadModelsOverview(noTrials, options);
    assert.equal(overview.local[0]?.state, 'missing');
    writeFileSync(join(dataDir, 'models', 'fake-small', 'model.bin'), 'fake!');
  });

  it('a cloud catalog that cannot be read leaves the cards out and says why, without values', async () => {
    writeFileSync(join(home, 'config', 'cloud-models.catalog.yaml'), 'version: 1\nsources: []\nmodels:\n  - alias: codex\n    provider: Fake\n    family: Fake\n    executor: claude\n    secret: hunter2\n');
    const overview = await loadModelsOverview(noTrials, options);
    assert.equal(overview.cloud.length, 4);
    assert.equal(overview.cloud.every(({ card }) => card === null), true);
    assert.equal(overview.errors.cloudCatalog, 'config/cloud-models.catalog.yaml is not valid at cloud catalog.models[0]');
    assert.doesNotMatch(overview.errors.cloudCatalog, /hunter2|secret/);
    assert.equal(overview.local.length, 2);
    // A YAML error quotes the lines around it: none of them reaches the page.
    writeFileSync(join(home, 'config', 'cloud-models.catalog.yaml'), 'version: 1\nsources: [\nmodels: hunter2: {\n');
    const broken = (await loadModelsOverview(noTrials, options)).errors.cloudCatalog ?? '';
    assert.match(broken, /^config\/cloud-models\.catalog\.yaml is not valid/);
    assert.doesNotMatch(broken, /hunter2/);
    rmSync(join(home, 'config', 'cloud-models.catalog.yaml'));
    assert.equal((await loadModelsOverview(noTrials, options)).errors.cloudCatalog, 'config/cloud-models.catalog.yaml cannot be read');
  });

  it('trials that cannot be read cost the trials, not the list', async () => {
    const down = { unsafe: () => Promise.reject(new Error('connection refused: password hunter2')) } as unknown as Sql;
    const overview = await loadModelsOverview(down, options);
    assert.equal(overview.errors.evals, 'the trials cannot be read');
    assert.equal(overview.local.length, 2);
    assert.equal(overview.local.every(({ lastEval }) => lastEval === null), true);
  });

  it('a local catalog that cannot be read leaves the local side empty and says why', async () => {
    const empty = join(root, 'empty-home');
    mkdirSync(empty, { recursive: true });
    const overview = await loadModelsOverview(noTrials, { ...options, home: empty });
    assert.deepEqual(overview.local, []);
    assert.equal(overview.errors.catalog, 'config/models.catalog.yaml cannot be read');
    assert.equal(overview.cloud.length, 4);
  });
});

describe('GET /api/models/overview', () => {
  it('answers with the list, and 404 without it; /api/models stays the selector', async () => {
    const server = await startApiServer({
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      models: () => [{ executor: 'claude', model: 'sonnet' }],
      modelsOverview: () => Promise.resolve(buildModelsOverview(inputs())),
    });
    try {
      const origin = `http://127.0.0.1:${String(server.port)}`;
      const response = await fetch(`${origin}/api/models/overview`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { local: { id: string; lastEval: { requestedAt: string } | null }[]; cloud: { alias: string }[] };
      assert.deepEqual(body.local.map(({ id }) => id), ['fake-large', 'fake-small', 'fake-spare']);
      assert.equal(body.local[0]?.lastEval?.requestedAt, '2026-10-01T10:00:00.000Z');
      assert.deepEqual(body.cloud.map(({ alias }) => alias), ['sonnet', 'opus', 'fable', 'codex']);
      assert.deepEqual(await (await fetch(`${origin}/api/models`)).json(), { models: [{ executor: 'claude', model: 'sonnet' }] });
    } finally {
      await server.close();
    }
    const bare = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${String(bare.port)}/api/models/overview`)).status, 404);
    } finally {
      await bare.close();
    }
  });
});
