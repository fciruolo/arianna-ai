import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { guardPaths, loadCuratedCatalog, MODEL_ROLES, resolveHome, uvEnvironment, voicePaths } from '@arianna/config';

const HOME = join('/', 'arianna-home');
const DATA = join(HOME, 'data');

test('guardPaths: everything inside ARIANNA_HOME, apart from the voice (D-113)', () => {
  const guard = guardPaths(HOME, DATA);
  const voice = voicePaths(HOME, DATA);
  assert.equal(guard.project, join(HOME, 'apps', 'guard'));
  assert.equal(guard.python, join(DATA, 'guard', 'venv', 'bin', 'python'));
  assert.equal(guard.models, voice.models);
  assert.equal(guard.evals, join(DATA, 'evals'));
  const all: string[] = [guard.src, guard.project, guard.venv, guard.python, guard.uvPython, guard.uvCache, guard.tmp, guard.models, guard.evals];
  for (const path of all) assert.ok(path.startsWith(HOME), path);
  assert.notEqual(guard.venv, voice.venv);
  assert.equal(uvEnvironment(guard).UV_PROJECT_ENVIRONMENT, guard.venv);
  assert.equal(uvEnvironment(guard).UV_CACHE_DIR, join(DATA, 'guard', 'cache'));
});

test('catalog: the pii role has a model loaded by transformers, not served by oMLX', () => {
  assert.ok(MODEL_ROLES.includes('pii'));
  const models = loadCuratedCatalog(resolveHome()).models.filter((model) => model.roles.includes('pii'));
  assert.ok(models.length > 0);
  for (const model of models) {
    assert.equal(model.runtime, 'transformers');
    assert.deepEqual(model.roles, ['pii']);
    assert.ok(model.files.some((file) => file.path === 'model.safetensors'));
  }
  // A model of another role never runs under transformers by mistake.
  const others = loadCuratedCatalog(resolveHome()).models.filter((model) => !model.roles.includes('pii'));
  assert.ok(others.every((model) => model.runtime !== 'transformers'));
});
