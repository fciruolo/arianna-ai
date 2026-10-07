// Hugging Face on the "Modelli" page (I-10, D-139): a fake hub, never the network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CATALOG_FILE, hubFileUrl, loadCatalog, loadUserCatalog, type ModelRole } from '@arianna/config';
import { gatewayCheck, markLogged, secretMatcher, type Labeled, type Target } from '@arianna/policy';

import type { Sql } from '../src/db/client.ts';
import { HubError, type HubClient } from '../src/hub-http.ts';
import { cardOf, createHuggingFace, excludedReason, gitBlobId, suggestedIdOf, suggestedRolesOf, type HubGateway } from '../src/huggingface.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

const REPO = 'fake-org/Fake-Model-4bit';
const REV = '1'.repeat(40);
const WEIGHTS_SHA = 'c'.repeat(64);
const CONFIG = Buffer.from('{"model_type":"fake"}\n');
const TOKENIZER = Buffer.from('{"version":"fake"}\n');

const CURATED = `version: 1
models:
  - id: curated-model
    family: fake
    runtime: mlx
    ram_min_gib: 2
    roles: [orchestrator]
    status: experimental
    source: https://huggingface.co/curated-org/Curated-Model
    files:
      - path: model.safetensors
        url: https://huggingface.co/curated-org/Curated-Model/resolve/${'2'.repeat(40)}/model.safetensors
        size_bytes: 10
        sha256: ${'d'.repeat(64)}
`;

/** The answer of GET /api/models/<repo>?blobs=true, as the public API gives it. */
function info(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REPO,
    sha: REV,
    private: false,
    gated: false,
    disabled: false,
    downloads: 1234,
    likes: 56,
    library_name: 'mlx',
    pipeline_tag: 'text-generation',
    tags: ['mlx', 'safetensors', 'license:apache-2.0'],
    config: { model_type: 'fake' },
    lastModified: '2026-09-01T10:00:00.000Z',
    siblings: [
      { rfilename: '.gitattributes', size: 1500, blobId: 'a'.repeat(40) },
      { rfilename: 'README.md', size: 900, blobId: 'b'.repeat(40) },
      { rfilename: 'config.json', size: CONFIG.length, blobId: gitBlobId(CONFIG) },
      { rfilename: 'tokenizer.json', size: TOKENIZER.length, blobId: gitBlobId(TOKENIZER) },
      { rfilename: 'model.safetensors', size: 3 * 1024 ** 3, blobId: 'e'.repeat(40), lfs: { sha256: WEIGHTS_SHA, size: 3 * 1024 ** 3, pointerSize: 134 } },
      { rfilename: 'pytorch_model.bin', size: 5000, blobId: 'f'.repeat(40), lfs: { sha256: 'f'.repeat(64), size: 5000, pointerSize: 134 } },
      { rfilename: 'modeling_fake.py', size: 400, blobId: '3'.repeat(40) },
    ],
    ...overrides,
  };
}

interface Hub {
  client: HubClient;
  urls: string[];
  card: Record<string, unknown>;
  search: unknown;
  files: Map<string, Buffer>;
}

function fakeHub(): Hub {
  const hub: Hub = {
    urls: [],
    card: info(),
    search: [
      { id: REPO, downloads: 1234, likes: 56, tags: ['mlx', 'license:mit'], pipeline_tag: 'text-generation', private: false },
      { id: 'curated-org/Curated-Model', downloads: 9, likes: 1, tags: [], pipeline_tag: 'text-generation' },
      { id: 'not a repo', downloads: 1 },
      { id: 'secret-org/Private', private: true },
    ],
    files: new Map([
      [hubFileUrl(REPO, REV, 'config.json'), CONFIG],
      [hubFileUrl(REPO, REV, 'tokenizer.json'), TOKENIZER],
    ]),
    client: {
      json: (url) => {
        hub.urls.push(url);
        return Promise.resolve(url.startsWith('https://huggingface.co/api/models?') ? hub.search : hub.card);
      },
      bytes: (url, maxBytes) => {
        hub.urls.push(url);
        const content = hub.files.get(url);
        if (content === undefined) return Promise.reject(new HubError('not-found', 'no such file'));
        if (content.length > maxBytes) return Promise.reject(new HubError('upstream', 'too large'));
        return Promise.resolve(content);
      },
    },
  };
  return hub;
}

const homes: string[] = [];
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

interface Sent {
  payload: readonly Labeled<unknown>[];
  target: Target;
  summary: string | undefined;
}

function setup(options: { roles?: Partial<Record<ModelRole, string>>; busy?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'arianna-hf-'));
  homes.push(home);
  mkdirSync(join(home, 'config'));
  writeFileSync(join(home, CATALOG_FILE), CURATED);
  const dataDir = join(home, 'data');
  mkdirSync(dataDir);
  const hub = fakeHub();
  const sent: Sent[] = [];
  const events: [string, Record<string, string | number>][] = [];
  const state = { roles: options.roles ?? {}, busy: options.busy ?? false };
  // The real decision of the policy, logged as the core's passGateway does.
  const gateway: HubGateway = (payload, context, target, meta) => {
    sent.push({ payload, target, summary: meta.summary });
    const decision = gatewayCheck(payload, context, target, secretMatcher([]));
    if (decision.decision === 'allow') markLogged(decision);
    return Promise.resolve(decision);
  };
  const huggingface = createHuggingFace({
    home,
    dataDir,
    client: hub.client,
    gateway,
    roles: () => state.roles,
    busy: () => state.busy,
    onEvent: (kind, payload) => events.push([kind, payload]),
    now: () => new Date('2026-10-07T12:00:00Z'),
  });
  return { home, dataDir, hub, sent, events, state, huggingface };
}

const code = (expected: HubError['code']) => (error: unknown) => error instanceof HubError && error.code === expected;

describe('search', () => {
  it('sends only the typed text, through the gateway as L0 towards the web, and reads the public list', async () => {
    const { hub, sent, huggingface } = setup();
    const results = await huggingface.search('  qwen 4bit  ');
    assert.equal(sent.length, 1);
    const [first] = sent;
    assert.ok(first !== undefined);
    assert.deepEqual(
      first.payload.map((fragment) => [fragment.value, fragment.label]),
      [['qwen 4bit', 'L0']],
    );
    assert.deepEqual(first.target, { kind: 'web' });
    // The summary in gateway_log never holds the query.
    assert.equal(first.summary?.includes('qwen'), false);
    assert.deepEqual(hub.urls, ['https://huggingface.co/api/models?search=qwen+4bit&filter=mlx&sort=downloads&direction=-1&limit=20']);
    assert.deepEqual(results, [
      { repo: REPO, downloads: 1234, likes: 56, license: 'mit', pipeline: 'text-generation', inCatalog: null },
      { repo: 'curated-org/Curated-Model', downloads: 9, likes: 1, license: null, pipeline: 'text-generation', inCatalog: 'curated-model' },
    ]);
  });

  it('refuses an empty, long or multi-line query before anything leaves', async () => {
    const { hub, sent, huggingface } = setup();
    for (const query of ['', '   ', 'x'.repeat(101), 'two\nlines', 42, undefined]) {
      await assert.rejects(huggingface.search(query), code('invalid'));
    }
    assert.equal(sent.length, 0);
    assert.deepEqual(hub.urls, []);
  });

  it('a query the gateway blocks never reaches huggingface.co', async () => {
    const { hub, sent, huggingface } = setup();
    // A fake IBAN: the scanner of the gateway stops it.
    await assert.rejects(huggingface.search('IT60X0542811101000000123456'), (error: unknown) => error instanceof HubError && error.code === 'blocked' && !error.message.includes('IT60'));
    assert.equal(sent.length, 1);
    assert.deepEqual(hub.urls, []);
  });

  it('an answer that is not a list is an error of the hub', async () => {
    const { hub, huggingface } = setup();
    hub.search = { error: 'nope' };
    await assert.rejects(huggingface.search('qwen'), code('upstream'));
  });
});

describe('card', () => {
  it('lists the files with the sha256 of the weights and keeps out pickle, code and README', async () => {
    const { hub, sent, huggingface } = setup();
    const card = await huggingface.card(REPO);
    assert.deepEqual(sent[0]?.payload.map((fragment) => fragment.value), [REPO]);
    assert.deepEqual(hub.urls, [`https://huggingface.co/api/models/${REPO}?blobs=true`]);
    assert.equal(card.revision, REV);
    assert.equal(card.license, 'apache-2.0');
    assert.equal(card.modelType, 'fake');
    assert.deepEqual(
      card.files.map((file) => [file.path, file.excluded]),
      [
        ['.gitattributes', 'not-needed'],
        ['config.json', null],
        ['model.safetensors', null],
        ['modeling_fake.py', 'code'],
        ['pytorch_model.bin', 'pickle'],
        ['README.md', 'not-needed'],
        ['tokenizer.json', null],
      ],
    );
    assert.equal(card.files.find((file) => file.path === 'model.safetensors')?.sha256, WEIGHTS_SHA);
    assert.equal(card.files.find((file) => file.path === 'config.json')?.sha256, null);
    assert.equal(card.sizeBytes, 3 * 1024 ** 3 + CONFIG.length + TOKENIZER.length);
    assert.equal(card.ramMinGib, 4);
    assert.equal(card.suggestedId, 'fake-model-4bit');
    assert.deepEqual(card.suggestedRoles, ['orchestrator', 'extractor', 'voice']);
    assert.deepEqual(card.problems, []);
    assert.equal(card.inCatalog, null);
  });

  it('an id the gateway blocks never reaches huggingface.co, for the card nor for an add', async () => {
    const { hub, huggingface } = setup();
    // A fake IBAN is also a valid owner/name.
    await assert.rejects(huggingface.card('IT60X0542811101000000123456/x'), code('blocked'));
    await assert.rejects(huggingface.add('IT60X0542811101000000123456/x', REV), code('blocked'));
    assert.deepEqual(hub.urls, []);
  });

  it('refuses an id that is not owner/name before anything leaves', async () => {
    const { hub, sent, huggingface } = setup();
    for (const repo of ['model', '../etc/passwd', 'a/b/c', 'a/b?x', 7]) await assert.rejects(huggingface.card(repo), code('invalid'));
    assert.equal(sent.length, 0);
    assert.deepEqual(hub.urls, []);
  });

  it('says why a model cannot be added', () => {
    const problems = (overrides: Record<string, unknown>) => cardOf(info(overrides), REPO, []).problems;
    assert.deepEqual(problems({ gated: 'manual' }), ['gated']);
    assert.deepEqual(problems({ gated: 'auto', private: true }), ['gated', 'private']);
    assert.deepEqual(problems({ disabled: true }), ['disabled']);
    assert.deepEqual(problems({ library_name: 'transformers', tags: [] }), ['not-mlx']);
    assert.deepEqual(problems({ siblings: [{ rfilename: 'config.json', size: 10, blobId: 'a'.repeat(40) }] }), ['no-weights']);
    assert.deepEqual(problems({ siblings: [{ rfilename: 'model.safetensors', size: 10, lfs: { size: 10 } }] }), ['no-sha256']);
    assert.deepEqual(problems({ siblings: [{ rfilename: 'model.safetensors', size: 10, lfs: { sha256: 'a'.repeat(64), size: 10 } }, { rfilename: 'config.json', size: 10 }] }), ['no-sha256']);
    const many = Array.from({ length: 201 }, (_, index) => ({ rfilename: `model-${String(index)}.safetensors`, size: 1, lfs: { sha256: 'a'.repeat(64), size: 1 } }));
    assert.deepEqual(problems({ siblings: many }), ['too-many-files']);
    assert.deepEqual(problems({ siblings: [{ rfilename: 'model.safetensors', size: 1, lfs: { sha256: 'a'.repeat(64), size: 600 * 1024 ** 3 } }] }), ['too-big']);
    assert.deepEqual(problems({ siblings: [{ rfilename: 'model.safetensors', size: 1, lfs: { sha256: 'a'.repeat(64), size: 1 } }, { rfilename: 'big.json', size: 65 * 1024 ** 2, blobId: 'a'.repeat(40) }] }), ['small-files-too-big']);
    const weight = (path: string) => ({ rfilename: path, size: 1, lfs: { sha256: 'a'.repeat(64), size: 1 } });
    assert.deepEqual(problems({ siblings: [weight('Model.safetensors'), weight('model.safetensors')] }), ['path-clash']);
    assert.throws(() => cardOf(info({ sha: 'main' }), REPO, []), code('upstream'));
    assert.throws(() => cardOf([], REPO, []), code('upstream'));
  });
});

describe('files, ids and roles', () => {
  it('keeps weights in safetensors and the small files of configuration and tokenizer only', () => {
    for (const path of ['model.safetensors', 'sub/model-00001-of-00002.safetensors', 'config.json', 'chat_template.jinja', 'merges.txt', 'tokenizer.model', 'vocab.tiktoken']) {
      assert.equal(excludedReason(path, 10), null, path);
    }
    assert.equal(excludedReason('model.safetensors', 0), 'empty');
    for (const [path, reason] of [
      ['pytorch_model.bin', 'pickle'],
      ['weights.pt', 'pickle'],
      ['model.ckpt', 'pickle'],
      ['modeling.py', 'code'],
      ['setup.sh', 'code'],
      ['model.gguf', 'other-format'],
      ['model.onnx', 'other-format'],
      ['README.md', 'not-needed'],
      ['readme.txt', 'not-needed'],
      ['figure.png', 'not-needed'],
      ['.hidden/config.json', 'not-needed'],
      ['../config.json', 'unsafe-path'],
      ['/config.json', 'unsafe-path'],
      ['a\\b.json', 'unsafe-path'],
      ['a//b.json', 'unsafe-path'],
    ] as const) {
      assert.equal(excludedReason(path, 10), reason, path);
    }
  });

  it('suggests a lowercase id, with the owner when the name is taken', () => {
    assert.equal(suggestedIdOf('mlx-community/Qwen3-4B-4bit', new Set()), 'qwen3-4b-4bit');
    assert.equal(suggestedIdOf('mlx-community/Qwen3-4B-4bit', new Set(['qwen3-4b-4bit'])), 'mlx-community-qwen3-4b-4bit');
    assert.equal(suggestedIdOf('mlx-community/Qwen3-4B-4bit', new Set(['qwen3-4b-4bit', 'mlx-community-qwen3-4b-4bit'])), 'mlx-community-qwen3-4b-4bit-2');
    assert.equal(suggestedIdOf('org/eliminati', new Set()), 'org-eliminati');
    assert.equal(suggestedIdOf('org/_Model+X', new Set()), 'model-x');
  });

  it('suggests roles from the task of the model', () => {
    assert.deepEqual(suggestedRolesOf('feature-extraction'), ['embedder']);
    assert.deepEqual(suggestedRolesOf('automatic-speech-recognition'), ['stt']);
    assert.deepEqual(suggestedRolesOf('text-to-speech'), ['tts']);
    assert.deepEqual(suggestedRolesOf(null), []);
  });

  it('computes the git id of a file as the API gives it', () => {
    // `git hash-object` of an empty file.
    assert.equal(gitBlobId(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});

describe('add, promote, forget', () => {
  it('adds the model as experimental and without a role, pinned to the commit, with every sha256', async () => {
    const { home, hub, sent, events, huggingface } = setup();
    assert.deepEqual(await huggingface.add(REPO, REV), { modelId: 'fake-model-4bit' });
    assert.deepEqual(sent[0]?.payload.map((fragment) => fragment.value), [REPO, REV]);
    assert.deepEqual(hub.urls, [`https://huggingface.co/api/models/${REPO}/revision/${REV}?blobs=true`, hubFileUrl(REPO, REV, 'config.json'), hubFileUrl(REPO, REV, 'tokenizer.json')]);
    const [entry] = loadUserCatalog(home).models;
    assert.ok(entry !== undefined);
    assert.equal(entry.status, 'experimental');
    assert.deepEqual(entry.roles, []);
    assert.equal(entry.origin, 'huggingface');
    assert.equal(entry.family, 'fake');
    assert.equal(entry.runtime, 'mlx');
    assert.equal(entry.ramMinGib, 4);
    assert.equal(entry.license, 'apache-2.0');
    assert.equal(entry.source, `https://huggingface.co/${REPO}`);
    assert.match(entry.notes ?? '', /2026-10-07, commit 1111111/);
    assert.deepEqual(
      entry.files.map((file) => [file.path, file.sha256]),
      [
        ['config.json', createHash('sha256').update(CONFIG).digest('hex')],
        ['model.safetensors', WEIGHTS_SHA],
        ['tokenizer.json', createHash('sha256').update(TOKENIZER).digest('hex')],
      ],
    );
    // The merged catalog has it, after the curated ones; the curated file is untouched.
    assert.deepEqual(loadCatalog(home).models.map((model) => model.id), ['curated-model', 'fake-model-4bit']);
    assert.equal(readFileSync(join(home, CATALOG_FILE), 'utf8'), CURATED);
    assert.deepEqual(events, [['model.catalog.added', { modelId: 'fake-model-4bit', repo: REPO, outcome: 'ok' }]]);
    // A second time: already in the catalog.
    await assert.rejects(huggingface.add(REPO, REV), code('conflict'));
    assert.equal((await huggingface.card(REPO)).inCatalog, 'fake-model-4bit');
  });

  it('refuses a small file that is not the one of the commit, and writes nothing', async () => {
    const { home, hub, huggingface } = setup();
    hub.files.set(hubFileUrl(REPO, REV, 'config.json'), Buffer.from('{"model_type":"other"}\n'));
    await assert.rejects(huggingface.add(REPO, REV), code('upstream'));
    assert.deepEqual(loadUserCatalog(home).models, []);
  });

  it('refuses a model with a problem, another commit, or a revision that is not a commit id', async () => {
    const { home, hub, huggingface } = setup();
    hub.card = info({ gated: 'manual' });
    await assert.rejects(huggingface.add(REPO, REV), (error: unknown) => error instanceof HubError && error.code === 'conflict' && /gated/.test(error.message));
    hub.card = info({ sha: '9'.repeat(40) });
    await assert.rejects(huggingface.add(REPO, REV), code('conflict'));
    await assert.rejects(huggingface.add(REPO, 'main'), code('invalid'));
    await assert.rejects(huggingface.add('nope', REV), code('invalid'));
    assert.deepEqual(loadUserCatalog(home).models, []);
  });

  it('promotes to the roles chosen by the user; a role in use cannot be taken away', async () => {
    const { home, events, state, huggingface } = setup();
    await huggingface.add(REPO, REV);
    assert.throws(() => huggingface.promote('fake-model-4bit', []), code('invalid'));
    assert.throws(() => huggingface.promote('fake-model-4bit', ['boss']), code('invalid'));
    assert.throws(() => huggingface.promote('fake-model-4bit', 'orchestrator'), code('invalid'));
    // Only the models added from Hugging Face: the curated catalog is never written.
    assert.throws(() => huggingface.promote('curated-model', ['extractor']), code('not-found'));
    assert.deepEqual(huggingface.promote('fake-model-4bit', ['extractor', 'orchestrator', 'extractor']), { modelId: 'fake-model-4bit', roles: ['orchestrator', 'extractor'] });
    assert.deepEqual(loadUserCatalog(home).models[0]?.roles, ['orchestrator', 'extractor']);
    assert.deepEqual(events.at(-1), ['model.catalog.promoted', { modelId: 'fake-model-4bit', roles: 'orchestrator,extractor', outcome: 'ok' }]);
    state.roles = { extractor: 'fake-model-4bit' };
    assert.throws(() => huggingface.promote('fake-model-4bit', ['orchestrator']), code('conflict'));
    assert.deepEqual(huggingface.promote('fake-model-4bit', ['extractor']).roles, ['extractor']);
  });

  it('takes a model out of the catalog only when nothing uses it and its files are gone', async () => {
    const { home, dataDir, state, events, huggingface } = setup();
    await huggingface.add(REPO, REV);
    assert.throws(() => huggingface.forget('fake-model-4bit', 'wrong'), code('invalid'));
    assert.throws(() => huggingface.forget('curated-model', 'curated-model'), code('not-found'));
    state.roles = { orchestrator: 'fake-model-4bit' };
    assert.throws(() => huggingface.forget('fake-model-4bit', 'fake-model-4bit'), /role orchestrator/);
    state.roles = {};
    state.busy = true;
    assert.throws(() => huggingface.forget('fake-model-4bit', 'fake-model-4bit'), code('conflict'));
    state.busy = false;
    mkdirSync(join(dataDir, 'models', 'fake-model-4bit'), { recursive: true });
    assert.throws(() => huggingface.forget('fake-model-4bit', 'fake-model-4bit'), /files on the disk/);
    rmSync(join(dataDir, 'models', 'fake-model-4bit'), { recursive: true });
    assert.deepEqual(huggingface.forget('fake-model-4bit', 'fake-model-4bit'), { modelId: 'fake-model-4bit' });
    assert.deepEqual(loadUserCatalog(home).models, []);
    assert.deepEqual(events.at(-1), ['model.catalog.removed', { modelId: 'fake-model-4bit', outcome: 'ok' }]);
  });

  it('one model is added at a time', async () => {
    const { hub, huggingface } = setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = hub;
    const json = (url: string, signal?: AbortSignal) => client.json(url, signal);
    hub.client = {
      ...client,
      json: async (url, signal) => {
        await held;
        return json(url, signal);
      },
    };
    const first = huggingface.add(REPO, REV);
    await assert.rejects(huggingface.add(REPO, REV), code('conflict'));
    release();
    assert.deepEqual(await first, { modelId: 'fake-model-4bit' });
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

  it('answers with the status codes of the API, and 404 without Hugging Face', async () => {
    const { huggingface } = setup();
    const api = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, huggingface });
    const bare = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
    const origin = `http://127.0.0.1:${String(api.port)}`;
    try {
      const search = await post(origin, '/api/models/huggingface/search', { query: 'fake' });
      assert.equal(search.status, 200);
      assert.equal((search.body.results as unknown[]).length, 2);
      assert.equal((await post(origin, '/api/models/huggingface/search', { query: '' })).status, 400);
      assert.equal((await post(origin, '/api/models/huggingface/search', { query: 'IT60X0542811101000000123456' })).status, 403);
      assert.equal((await post(origin, '/api/models/huggingface/search', { query: 'fake', token: 'x' })).status, 400);
      assert.equal((await post(origin, '/api/models/huggingface/card', { repo: REPO })).status, 200);
      assert.equal((await post(origin, '/api/models/huggingface/card', { repo: 'nope' })).status, 400);
      const added = await post(origin, '/api/models/huggingface/add', { repo: REPO, revision: REV });
      assert.equal(added.status, 201);
      assert.equal(added.body.modelId, 'fake-model-4bit');
      assert.equal((await post(origin, '/api/models/huggingface/add', { repo: REPO, revision: REV })).status, 409);
      assert.equal((await post(origin, '/api/models/fake-model-4bit/promote', { roles: ['orchestrator'] })).status, 200);
      assert.equal((await post(origin, '/api/models/curated-model/promote', { roles: ['orchestrator'] })).status, 404);
      assert.equal((await post(origin, '/api/models/fake-model-4bit/forget', { confirm: 'no' })).status, 400);
      assert.equal((await post(origin, '/api/models/fake-model-4bit/forget', { confirm: 'fake-model-4bit' })).status, 200);
      assert.equal((await post(`http://127.0.0.1:${String(bare.port)}`, '/api/models/huggingface/search', { query: 'fake' })).status, 404);
    } finally {
      await api.close();
      await bare.close();
    }
  });
});
