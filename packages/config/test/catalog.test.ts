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
  assert.throws(() => parseCatalog(`${VALID}extra: true\n`), ConfigError);
  assert.throws(() => parseCatalog(VALID.replace('family: fake', 'family: fake\n    name: x')), ConfigError);
});
