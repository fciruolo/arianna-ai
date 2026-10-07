import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, loadCatalog, modelSize, parseCatalog, resolveHome } from '../src/index.ts';

const SHA = 'a'.repeat(64);
const VALID = `
version: 1
models:
  - id: fake-model-mlx
    family: fake
    runtime: mlx
    ram_min_gib: 20
    roles: [orchestrator, extractor]
    status: experimental
    files:
      - path: weights/model.safetensors
        url: https://example.org/fake-model/model.safetensors
        size_bytes: 1024
        sha256: ${SHA}
      - path: config.json
        url: https://example.org/fake-model/config.json
        size_bytes: 10
        sha256: ${SHA}
`;

test('a valid catalog is parsed', () => {
  const [model] = parseCatalog(VALID).models;
  assert.ok(model !== undefined);
  assert.equal(modelSize(model), 1034);
  assert.deepEqual(model, {
    id: 'fake-model-mlx',
    family: 'fake',
    runtime: 'mlx',
    ramMinGib: 20,
    roles: ['orchestrator', 'extractor'],
    status: 'experimental',
    files: [
      { path: 'weights/model.safetensors', url: 'https://example.org/fake-model/model.safetensors', sizeBytes: 1024, sha256: SHA },
      { path: 'config.json', url: 'https://example.org/fake-model/config.json', sizeBytes: 10, sha256: SHA },
    ],
  });
});

test('the committed catalog loads', () => {
  assert.equal(loadCatalog(resolveHome({})).version, 1);
});

test('an empty model list is valid, a missing one is not', () => {
  assert.deepEqual(parseCatalog('version: 1\nmodels: []\n').models, []);
  assert.throws(() => parseCatalog('version: 1\n'), ConfigError);
});

test('unsupported versions, roles, runtimes and statuses are rejected', () => {
  assert.throws(() => parseCatalog(VALID.replace('version: 1', 'version: 2')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('orchestrator', 'boss')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('runtime: mlx', 'runtime: ollama')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('experimental', 'trusted')), ConfigError);
});

test('roles must be listed, once each; RAM must be a positive integer', () => {
  assert.throws(() => parseCatalog(VALID.replace('[orchestrator, extractor]', '[]')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('[orchestrator, extractor]', '[extractor, extractor]')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('ram_min_gib: 20', 'ram_min_gib: 0')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('ram_min_gib: 20', 'ram_min_gib: 7.5')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('    ram_min_gib: 20\n', '')), ConfigError);
});

test('files must be verifiable, stay inside the model folder and be listed once', () => {
  assert.throws(() => parseCatalog(VALID.replace(SHA, 'abc')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('https://', 'http://')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('1024', '0')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('weights/', '../')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('weights/', '/')), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('path: config.json', 'path: weights/model.safetensors')), ConfigError);
});

test('ids are folder names: lowercase and unique; unknown keys are rejected', () => {
  const second = VALID.slice(VALID.indexOf('  - id'));
  assert.throws(() => parseCatalog(VALID + second), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('id: fake-model-mlx', 'id: Fake-Model')), ConfigError);
  // data/models/eliminati is the bin of the removed models (I-3, M4); a name that only contains it is fine.
  assert.throws(() => parseCatalog(VALID.replace('id: fake-model-mlx', 'id: eliminati')), /bin of data\/models/);
  assert.equal(parseCatalog(VALID.replace('id: fake-model-mlx', 'id: eliminati-2')).models[0]?.id, 'eliminati-2');
  assert.throws(() => parseCatalog(`${VALID}extra: true\n`), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('family: fake', 'family: fake\n    name: x')), ConfigError);
});

test('the card fields of I-3 are optional and read when given', () => {
  const card = VALID.replace(
    '    status: experimental\n',
    '    status: experimental\n    provider: Fake Lab\n    context_tokens: 32768\n    strengths: [Quick, Small]\n    license: Apache-2.0\n    notes: Only fake\n    source: https://example.org/fake-model\n',
  );
  const [model] = parseCatalog(card).models;
  assert.ok(model !== undefined);
  assert.equal(model.provider, 'Fake Lab');
  assert.equal(model.contextTokens, 32768);
  assert.deepEqual(model.strengths, ['Quick', 'Small']);
  assert.equal(model.license, 'Apache-2.0');
  assert.equal(model.notes, 'Only fake');
  assert.equal(model.source, 'https://example.org/fake-model');
  const [plain] = parseCatalog(VALID).models;
  assert.ok(plain !== undefined);
  assert.equal('provider' in plain || 'strengths' in plain || 'source' in plain, false);
});

test('the card fields of I-3 are checked', () => {
  const withField = (line: string): string => VALID.replace('    status: experimental\n', `    status: experimental\n    ${line}\n`);
  assert.throws(() => parseCatalog(withField('provider: ""')), ConfigError);
  assert.throws(() => parseCatalog(withField('context_tokens: 0')), ConfigError);
  assert.throws(() => parseCatalog(withField('context_tokens: "32k"')), ConfigError);
  assert.throws(() => parseCatalog(withField('strengths: []')), ConfigError);
  assert.throws(() => parseCatalog(withField('strengths: [a, b, c, d, e]')), ConfigError);
  assert.throws(() => parseCatalog(withField('strengths: "one string"')), ConfigError);
  assert.throws(() => parseCatalog(withField(`strengths: ["${'x'.repeat(201)}"]`)), ConfigError);
  assert.throws(() => parseCatalog(withField('source: http://example.org/fake')), ConfigError);
  assert.throws(() => parseCatalog(withField('source: not a url')), ConfigError);
  assert.throws(() => parseCatalog(withField('license: 3')), ConfigError);
});

test('every entry of the committed catalog has a provider and a source', () => {
  for (const model of loadCatalog(resolveHome({})).models) {
    assert.ok(model.provider !== undefined, model.id);
    assert.ok(model.source?.startsWith('https://huggingface.co/'), model.id);
  }
});
