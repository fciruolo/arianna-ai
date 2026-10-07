import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { addLines, cardBlockers, cleanQuery, countText, excludedFiles, forgetBlocked, hubErrorText, keptFiles, lockedRoles, promoteLines, resultLine, type HubCard } from '../src/lib/huggingface.ts';
import type { LocalModelView } from '../src/lib/models-page.ts';

const card = (overrides: Partial<HubCard> = {}): HubCard => ({
  repo: 'fake-org/Fake-4bit',
  revision: 'abcdef1'.padEnd(40, '0'),
  license: 'apache-2.0',
  pipeline: 'text-generation',
  modelType: 'fake',
  downloads: 1234,
  likes: 5,
  lastModified: null,
  files: [
    { path: 'config.json', sizeBytes: 100, sha256: null, lfs: false, blobId: 'a'.repeat(40), excluded: null },
    { path: 'model.safetensors', sizeBytes: 2_000_000_000, sha256: 'c'.repeat(64), lfs: true, blobId: null, excluded: null },
    { path: 'pytorch_model.bin', sizeBytes: 10, sha256: 'd'.repeat(64), lfs: true, blobId: null, excluded: 'pickle' },
  ],
  sizeBytes: 2_000_000_100,
  ramMinGib: 3,
  suggestedId: 'fake-4bit',
  suggestedRoles: ['orchestrator'],
  inCatalog: null,
  problems: [],
  ...overrides,
});

const local = (overrides: Partial<LocalModelView> = {}): LocalModelView => ({
  locality: 'local',
  id: 'fake-4bit',
  family: 'fake',
  runtime: 'mlx',
  ramMinGib: 3,
  status: 'experimental',
  sizeBytes: 2_000_000_100,
  provider: 'fake-org (Hugging Face)',
  contextTokens: null,
  strengths: [],
  license: null,
  notes: null,
  source: 'https://huggingface.co/fake-org/Fake-4bit',
  suitedRoles: [],
  origin: 'huggingface',
  roles: [],
  aliases: [],
  agents: [],
  uses: [],
  present: false,
  state: 'missing',
  hasFiles: false,
  missingBytes: 2_000_000_100,
  action: null,
  loaded: [],
  lastEval: null,
  ...overrides,
});

describe('Hugging Face on the Modelli page', () => {
  it('accepts one line of 1-100 characters as the core does', () => {
    assert.equal(cleanQuery('  qwen 4bit '), 'qwen 4bit');
    assert.equal(cleanQuery('   '), undefined);
    assert.equal(cleanQuery('x'.repeat(101)), undefined);
    assert.equal(cleanQuery('two\nlines'), undefined);
  });

  it('writes counts and the line of a result in Italian', () => {
    assert.equal(countText(null), '—');
    assert.equal(countText(56), '56');
    assert.equal(countText(1234), '1,2 mila');
    assert.equal(countText(3_400_000), '3,4 mln');
    assert.equal(resultLine({ downloads: 1234, likes: null, license: null, pipeline: 'text-generation' }), '1,2 mila download · licenza non indicata · text-generation');
  });

  it('splits the files and says why a card cannot be added', () => {
    assert.deepEqual(keptFiles(card()).map((file) => file.path), ['config.json', 'model.safetensors']);
    assert.deepEqual(excludedFiles(card()).map((file) => file.path), ['pytorch_model.bin']);
    assert.deepEqual(cardBlockers(card()), []);
    assert.deepEqual(cardBlockers(card({ inCatalog: 'fake-4bit', problems: ['gated'] })), ['È già nel catalogo come fake-4bit.', 'È ad accesso controllato: serve un account Hugging Face, e Arianna non fa login.']);
  });

  it('the confirmation says what is written, what leaves and that it has no role', () => {
    const lines = addLines(card()).join(' ');
    assert.match(lines, /fake-4bit in config\/models\.user-catalog\.yaml/);
    assert.match(lines, /commit abcdef1/);
    assert.match(lines, /sperimentale e senza ruoli/);
    assert.match(lines, /Esce solo l’id fake-org\/Fake-4bit/);
    assert.match(lines, /i 1 file piccoli/);
    assert.match(addLines(card({ files: [] })).join(' '), /non ci sono file piccoli/);
    assert.match(promoteLines(local(), ['orchestrator', 'voice']).join(' '), /i ruoli Orchestratore, Voce/);
  });

  it('taking it out of the catalog waits for roles, actions and files', () => {
    assert.equal(forgetBlocked(local(), []), undefined);
    assert.match(forgetBlocked(local(), ['orchestrator']) ?? '', /Orchestratore/);
    assert.match(forgetBlocked(local({ hasFiles: true }), []) ?? '', /Togli dal disco/);
    assert.match(forgetBlocked(local({ action: { modelId: 'fake-4bit', kind: 'download', status: 'running', bytesDone: 0, bytesTotal: 1, startedAt: '', finishedAt: null, error: null, bad: [] } }), []) ?? '', /ferma/);
    assert.deepEqual(lockedRoles(local({ suitedRoles: ['orchestrator', 'voice'] }), ['voice']), ['voice']);
    assert.deepEqual(lockedRoles(local(), ['voice']), []);
  });

  it('turns the refusals of the core into Italian, without repeating the query', () => {
    assert.match(hubErrorText(new ApiError(403, 'the gateway did not let it out (scanner): payload matches iban')), /dato personale/);
    assert.match(hubErrorText(new ApiError(403, 'the gateway did not let it out (cloud-label): x')), /non è uscito nulla/);
    assert.match(hubErrorText(new ApiError(502, 'huggingface.co cannot be reached')), /non risponde/);
    assert.match(hubErrorText(new ApiError(404, 'huggingface.co answered 401')), /privato/);
    assert.match(hubErrorText(new ApiError(502, 'huggingface.co answered 503')), /\(503\)/);
    assert.equal(hubErrorText(new ApiError(409, 'the model cannot be added: gated, not-mlx')), 'È ad accesso controllato: serve un account Hugging Face, e Arianna non fa login. Non è in formato MLX: il server locale (oMLX) non lo può usare.');
    assert.equal(hubErrorText(new ApiError(409, 'the model is already in the catalog as fake-4bit')), 'È già nel catalogo come fake-4bit.');
    assert.match(hubErrorText(new ApiError(409, 'the model has the role orchestrator, voice: give it to another model first')), /Orchestratore, Voce/);
    assert.match(hubErrorText(new ApiError(404, 'not found')), /riavvialo/);
  });
});
