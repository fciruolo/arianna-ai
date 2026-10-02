import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, loadManifest, parseManifest, resolveHome } from '../src/index.ts';

const SHA = 'a'.repeat(64);
const VALID = `
version: 1
models:
  - name: fake-model-mlx
    role: orchestrator
    runtime: mlx
    files:
      - path: weights/model.safetensors
        url: https://example.org/fake-model/model.safetensors
        size_bytes: 1024
        sha256: ${SHA}
`;

test('a valid manifest is parsed', () => {
  assert.deepEqual(parseManifest(VALID), {
    version: 1,
    models: [
      {
        name: 'fake-model-mlx',
        role: 'orchestrator',
        runtime: 'mlx',
        files: [
          {
            path: 'weights/model.safetensors',
            url: 'https://example.org/fake-model/model.safetensors',
            sizeBytes: 1024,
            sha256: SHA,
          },
        ],
      },
    ],
  });
});

test('the committed manifest loads', () => {
  assert.equal(loadManifest(resolveHome({})).version, 1);
});

test('an empty model list is valid, a missing one is not', () => {
  assert.deepEqual(parseManifest('version: 1\nmodels: []\n').models, []);
  assert.throws(() => parseManifest('version: 1\n'), ConfigError);
});

test('unsupported versions, roles and runtimes are rejected', () => {
  assert.throws(() => parseManifest(VALID.replace('version: 1', 'version: 2')), ConfigError);
  assert.throws(() => parseManifest(VALID.replace('orchestrator', 'boss')), ConfigError);
  assert.throws(() => parseManifest(VALID.replace('runtime: mlx', 'runtime: ollama')), ConfigError);
});

test('files must be verifiable and stay inside the model folder', () => {
  assert.throws(() => parseManifest(VALID.replace(SHA, 'abc')), ConfigError);
  assert.throws(() => parseManifest(VALID.replace('https://', 'http://')), ConfigError);
  assert.throws(() => parseManifest(VALID.replace('1024', '0')), ConfigError);
  assert.throws(() => parseManifest(VALID.replace('weights/', '../')), ConfigError);
  assert.throws(() => parseManifest(VALID.replace('weights/', '/')), ConfigError);
});

test('duplicate model names and unknown keys are rejected', () => {
  const second = VALID.slice(VALID.indexOf('  - name'));
  assert.throws(() => parseManifest(VALID + second), ConfigError);
  assert.throws(() => parseManifest(`${VALID}extra: true\n`), ConfigError);
});
