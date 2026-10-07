import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CATALOG_FILE,
  ConfigError,
  hubFileUrl,
  isHubRepo,
  loadCatalog,
  loadCuratedCatalog,
  loadUserCatalog,
  modelSize,
  parseCatalog,
  renderUserCatalog,
  resolveHome,
  USER_CATALOG_FILE,
  writeUserCatalog,
} from '../src/index.ts';

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
  for (const model of loadCuratedCatalog(resolveHome({})).models) {
    assert.ok(model.provider !== undefined, model.id);
    assert.ok(model.source?.startsWith('https://huggingface.co/'), model.id);
  }
});

// The user catalog (I-10, D-139): models added from Hugging Face on the "Modelli" page.
const REPO = 'fake-org/Fake-Model-4bit';
const REV = 'b'.repeat(40);
const userEntry = (id: string, roles = '[]'): string => `
  - id: ${id}
    family: fake
    runtime: mlx
    ram_min_gib: 2
    roles: ${roles}
    status: experimental
    provider: fake-org (Hugging Face)
    source: https://huggingface.co/${REPO}
    files:
      - path: model.safetensors
        url: ${hubFileUrl(REPO, REV, 'model.safetensors')}
        size_bytes: 1024
        sha256: ${SHA}
      - path: sub dir/config.json
        url: ${hubFileUrl(REPO, REV, 'sub dir/config.json')}
        size_bytes: 10
        sha256: ${SHA}
`;
const USER = `version: 1\nmodels:${userEntry('fake-model-4bit')}`;

test('user catalog: an entry without roles is valid and marked as coming from Hugging Face', () => {
  const [model] = parseCatalog(USER, { user: true }).models;
  assert.ok(model !== undefined);
  assert.deepEqual(model.roles, []);
  assert.equal(model.origin, 'huggingface');
  assert.equal(model.files[1]?.url, `https://huggingface.co/${REPO}/resolve/${REV}/sub%20dir/config.json`);
  // The curated catalog still needs a role, and never marks an origin.
  assert.throws(() => parseCatalog(USER), /at least one role/);
  assert.equal(parseCatalog(VALID).models[0]?.origin, undefined);
});

test('user catalog: files only from one commit of the repository of the page, on huggingface.co', () => {
  const user = (text: string) => () => parseCatalog(text, { user: true });
  assert.throws(user(USER.replace(`source: https://huggingface.co/${REPO}`, 'source: https://example.org/fake')), /repository of huggingface.co/);
  assert.throws(user(USER.replace(`source: https://huggingface.co/${REPO}`, 'source: https://huggingface.co/only-owner')), ConfigError);
  assert.throws(user(USER.replace(/\n {4}source: .*\n/, '\n')), ConfigError);
  // A file of another host, another repository, or another commit.
  assert.throws(user(USER.replace(hubFileUrl(REPO, REV, 'model.safetensors'), 'https://example.org/model.safetensors')), ConfigError);
  assert.throws(user(USER.replace(hubFileUrl(REPO, REV, 'model.safetensors'), hubFileUrl('other/Repo', REV, 'model.safetensors'))), ConfigError);
  assert.throws(user(USER.replace(hubFileUrl(REPO, REV, 'sub dir/config.json'), hubFileUrl(REPO, 'c'.repeat(40), 'sub dir/config.json'))), /at commit/);
  // A branch name is not a commit.
  assert.throws(user(USER.replaceAll(REV, 'main')), ConfigError);
  // A file whose address is not its own path.
  assert.throws(user(USER.replace('path: model.safetensors', 'path: other.safetensors')), ConfigError);
  assert.equal(user(USER)().models.length, 1);
});

test('repository ids of Hugging Face', () => {
  for (const good of ['mlx-community/Qwen3-4B-4bit', 'a/b', 'Org_1/model.v2']) assert.equal(isHubRepo(good), true, good);
  for (const bad of ['', 'model', 'a/b/c', '../x', 'a/..', '-a/b', 'a/ b', 'a/b?x=1', `a/${'b'.repeat(97)}`, 3]) assert.equal(isHubRepo(bad), false, String(bad));
});

test('loadCatalog: the curated entries, then the user ones; an id in both is the curated one', () => {
  const home = mkdtempSync(join(tmpdir(), 'arianna-catalog-'));
  try {
    mkdirSync(join(home, 'config'));
    writeFileSync(join(home, CATALOG_FILE), VALID);
    assert.deepEqual(loadUserCatalog(home).models, []);
    assert.deepEqual(loadCatalog(home).models.map((model) => model.id), ['fake-model-mlx']);
    writeFileSync(join(home, USER_CATALOG_FILE), `${USER}${userEntry('fake-model-mlx', '[orchestrator]')}`);
    const merged = loadCatalog(home).models;
    assert.deepEqual(
      merged.map((model) => [model.id, model.origin ?? 'catalog']),
      [
        ['fake-model-mlx', 'catalog'],
        ['fake-model-4bit', 'huggingface'],
      ],
    );
    assert.deepEqual(loadCuratedCatalog(home).models.map((model) => model.id), ['fake-model-mlx']);
    // A broken user catalog is an error, never a silent empty list.
    writeFileSync(join(home, USER_CATALOG_FILE), USER.replace('runtime: mlx', 'runtime: ollama'));
    assert.throws(() => loadCatalog(home), ConfigError);
    // Every error names the user catalog, also those of the YAML and of the root.
    for (const broken of ['version: 1\nmodels: [\n', 'version: 2\nmodels: []\n', `${USER}${userEntry('fake-model-4bit')}`]) {
      writeFileSync(join(home, USER_CATALOG_FILE), broken);
      assert.throws(() => loadCatalog(home), /^ConfigError: user catalog|user catalog/);
      assert.throws(() => loadUserCatalog(home), (error: unknown) => error instanceof ConfigError && error.message.startsWith('user catalog'));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeUserCatalog writes what it reads back, and refuses an entry outside the rules', () => {
  const home = mkdtempSync(join(tmpdir(), 'arianna-catalog-'));
  try {
    mkdirSync(join(home, 'config'));
    const catalog = parseCatalog(USER, { user: true });
    writeUserCatalog(home, catalog);
    assert.deepEqual(loadUserCatalog(home), catalog);
    assert.match(renderUserCatalog(catalog), /^# Models added from Hugging Face/);
    const [model] = catalog.models;
    assert.ok(model !== undefined);
    const outside = { version: 1 as const, models: [{ ...model, files: model.files.map((file) => ({ ...file, url: 'https://example.org/x' })) }] };
    assert.throws(() => {
      writeUserCatalog(home, outside);
    }, ConfigError);
    // Nothing half-written is left, and the file is the one before.
    assert.deepEqual(readdirSync(join(home, 'config')).sort(), ['models.user-catalog.yaml']);
    assert.deepEqual(loadUserCatalog(home), catalog);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
