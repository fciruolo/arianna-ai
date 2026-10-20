import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { parseCatalog, resolveHome } from '@arianna/config';

import { DATA_LAYOUT, ensureLayout, guardDirChecks, layoutCheck, omlxLogChecks, omlxSettingsChecks, systemChecks, voiceCheck, type Runner } from '../src/install-checks.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `home-${randomUUID()}`);

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const versions: Record<string, string> = { pnpm: '12.8.1', docker: '28.1.1', sops: 'sops 3.13.3 (latest)\nmore', age: 'v1.3.2', uv: 'uv 0.12.23' };
const runner = (missing: string[] = []): Runner => (binary) =>
  missing.includes(binary) ? Promise.reject(new Error('ENOENT')) : Promise.resolve(versions[binary] ?? '');

test('prerequisites present: every check passes, with the versions found', async () => {
  const checks = await systemChecks({ run: runner(), nodeVersion: 'v22.18.0' });
  assert.ok(checks.every((check) => check.ok));
  assert.equal(checks.find((check) => check.id === 'system.sops')?.detail, 'sops 3.13.3 (latest)');
});

test('an old Node, a missing binary or a stopped Docker fail with what to do', async () => {
  const checks = await systemChecks({ run: runner(['docker', 'age']), nodeVersion: 'v22.17.9' });
  const failed = checks.filter((check) => !check.ok).map((check) => check.id);
  assert.deepEqual(failed, ['system.node', 'system.docker', 'system.age']);
  assert.match(checks.find((check) => check.id === 'system.docker')?.detail ?? '', /start Docker Desktop/);
  assert.equal((await systemChecks({ run: runner(), nodeVersion: 'v24.0.0' }))[0]?.ok, true);
});

test('uv is checked only when [voice] is configured, and the voice environment is reported (D-066)', async () => {
  assert.ok(!(await systemChecks({ run: runner(['uv']), nodeVersion: 'v22.18.0' })).some((check) => check.id === 'system.uv'));
  const missing = await systemChecks({ run: runner(['uv']), nodeVersion: 'v22.18.0', voice: true });
  assert.match(missing.find((check) => check.id === 'system.uv' && !check.ok)?.detail ?? '', /brew install uv/);
  const present = await systemChecks({ run: runner(), nodeVersion: 'v22.18.0', voice: true });
  assert.equal(present.find((check) => check.id === 'system.uv')?.detail, 'uv 0.12.23');
  assert.equal(voiceCheck(join(import.meta.dirname, 'arianna-no-such-python')).ok, false);
  assert.equal(voiceCheck(process.execPath).ok, true);
});

test('install creates data/ and its folders, private where they hold secrets; twice is harmless', () => {
  const data = join(HOME, 'data');
  assert.equal(layoutCheck(HOME, data)[0]?.ok, false);
  assert.deepEqual(ensureLayout(data), ['data', ...DATA_LAYOUT.map((dir) => `data/${dir}`)]);
  assert.deepEqual(ensureLayout(data), []);
  assert.equal(statSync(data).mode & 0o777, 0o700);
  assert.equal(statSync(join(data, 'vault')).mode & 0o777, 0o700);
  assert.deepEqual(layoutCheck(HOME, data)[0], { id: 'layout.data', ok: true, detail: 'every folder present' });

  chmodSync(data, 0o755);
  chmodSync(join(data, 'vault'), 0o755);
  assert.match(layoutCheck(HOME, data)[0]?.detail ?? '', /readable by other users: data, data\/vault/);
  assert.deepEqual(ensureLayout(data), ['data (now private)', 'data/vault (now private)']);
  assert.equal(statSync(data).mode & 0o777, 0o700);
  assert.equal(layoutCheck(HOME, data)[0]?.ok, true);
});

test('links that leave ARIANNA_HOME are reported, links inside are not', () => {
  const data = join(HOME, 'data');
  ensureLayout(data);
  const elsewhere = join(HOME, '..', `elsewhere-${randomUUID()}`);
  mkdirSync(elsewhere);
  try {
    symlinkSync(join(data, 'kb'), join(data, 'models', 'inside'));
    assert.match(layoutCheck(HOME, data)[1]?.detail ?? '', /no link leaves/);
    symlinkSync(elsewhere, join(data, 'models', 'big-disk'));
    const links = layoutCheck(HOME, data)[1];
    assert.ok(links !== undefined);
    assert.equal(links.ok, true);
    assert.match(links.detail, /data\/models\/big-disk/);
    assert.doesNotMatch(links.detail, /inside/);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('an ARIANNA_HOME reached through a link does not make its own links look outside', () => {
  const data = join(HOME, 'data');
  ensureLayout(data);
  const alias = join(HOME, '..', `alias-${randomUUID()}`);
  symlinkSync(HOME, alias);
  try {
    const links = layoutCheck(alias, join(alias, 'data'))[1];
    assert.ok(links !== undefined);
    assert.doesNotMatch(links.detail, /inside/);
  } finally {
    rmSync(alias);
  }
});

test('omlxLogChecks refuses the oMLX levels that log the prompts, and only for oMLX servers (D-136)', () => {
  const serve = (...extra: string[]): string[] => ['omlx', 'serve', '--model-dir', 'data/models', ...extra];
  const checks = omlxLogChecks([
    { id: 'a', command: serve('--log-level', 'info') },
    { id: 'b', command: serve('--log-level', 'trace') },
    { id: 'c', command: serve('--log-level=DEBUG') },
    { id: 'd', command: serve() },
    { id: 'e', command: ['/srv/bin/omlx', 'serve', '--log-level', 'warning'] },
    { id: 'f', command: ['llama-server', '--log-level', 'trace'] },
    { id: 'g' },
    // The last value counts, as the parser of oMLX applies it.
    { id: 'h', command: serve('--log-level', 'info', '--log-level', 'trace') },
    { id: 'i', command: serve('--log-level', 'trace', '--log-level=info') },
    // A flag without a value, an unknown level, a launcher in front.
    { id: 'j', command: serve('--log-level') },
    { id: 'k', command: serve('--log-level', 'verbose') },
    { id: 'l', command: ['uvx', 'omlx', 'serve', '--log-level', 'trace'] },
  ]);
  assert.deepEqual(
    checks.map((check) => [check.id, check.ok]),
    [
      ['local.a.log-level', true],
      ['local.b.log-level', false],
      ['local.c.log-level', false],
      ['local.d.log-level', false],
      ['local.e.log-level', true],
      ['local.h.log-level', false],
      ['local.i.log-level', true],
      ['local.j.log-level', false],
      ['local.k.log-level', false],
      ['local.l.log-level', false],
    ],
  );
  assert.match(checks[1]?.detail ?? '', /data\/b\.log/);
  assert.match(checks[3]?.detail ?? '', /add --log-level info/);
  assert.match(checks[7]?.detail ?? '', /without a value/);
});

test('omlxSettingsChecks: oMLX settings inside data/, no key or MCP on the command line, nothing that reopens it (D-221)', () => {
  const home = join(HOME, 'omlx-settings');
  const data = join(home, 'data');
  const serve = (...extra: string[]): string[] => ['omlx', 'serve', '--model-dir', 'data/models', ...extra];
  const settings = (dir: string, content: unknown): void => {
    mkdirSync(join(data, dir), { recursive: true });
    writeFileSync(join(data, dir, 'settings.json'), typeof content === 'string' ? content : JSON.stringify(content));
  };
  settings('clean', { auth: { api_key: 'x', skip_api_key_verification: false, sub_keys: [] }, network: { http_proxy: '', https_proxy: '', no_proxy: '' }, mcp: { config_path: null }, server: { distributed_inference_enabled: false } });
  settings('open', { auth: { skip_api_key_verification: true, sub_keys: [{ name: 'x' }] }, network: { https_proxy: 'http://proxy.example:3128', no_proxy: '*' }, mcp: { config_path: '/x/mcp.json' }, server: { distributed_inference_enabled: true } });
  settings('broken', '{not json');
  // A link inside data/ that leads outside it.
  mkdirSync(join(home, 'outside'), { recursive: true });
  symlinkSync(join(home, 'outside'), join(data, 'linked'));
  const checks = omlxSettingsChecks(home, data, [
    { id: 'a', command: serve('--base-path', 'data/clean') },
    { id: 'b', command: serve('--base-path', 'data/open') },
    { id: 'c', command: serve('--base-path', 'data/broken') },
    // Not started yet: no settings.json.
    { id: 'd', command: serve('--base-path=data/omlx') },
    { id: 'e', command: serve() },
    { id: 'f', command: serve('--base-path', 'elsewhere') },
    { id: 'g', command: serve('--base-path', 'data') },
    { id: 'h', command: serve('--base-path', 'data/omlx', '--api-key', 'k', '--mcp-config=m.json') },
    { id: 'k', command: serve('--base-path', 'data/linked') },
    { id: 'i', command: ['llama-server', '--api-key', 'k'] },
    { id: 'j' },
  ]);
  // No GGUF anywhere here: one passing check per oMLX server (the GGUF test is below).
  assert.deepEqual(
    checks.filter((check) => check.id.endsWith('.gguf')).map((check) => [check.id, check.ok]),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'k'].map((id) => [`local.${id}.gguf`, true]),
  );
  assert.deepEqual(
    checks.filter((check) => !check.id.endsWith('.gguf')).map((check) => [check.id, check.ok]),
    [
      ['local.a.flags', true],
      ['local.a.base-path', true],
      ['local.a.settings', true],
      ['local.b.flags', true],
      ['local.b.base-path', true],
      ['local.b.settings', false],
      ['local.c.flags', true],
      ['local.c.base-path', true],
      ['local.c.settings', false],
      ['local.d.flags', true],
      ['local.d.base-path', true],
      ['local.d.settings', true],
      ['local.e.flags', true],
      ['local.e.base-path', false],
      ['local.f.flags', true],
      ['local.f.base-path', false],
      ['local.g.flags', true],
      ['local.g.base-path', false],
      ['local.h.flags', false],
      ['local.h.base-path', true],
      ['local.h.settings', true],
      ['local.k.flags', true],
      ['local.k.base-path', false],
    ],
  );
  const detail = (id: string): string => checks.find((check) => check.id === id)?.detail ?? '';
  assert.equal(detail('local.b.settings'), 'oMLX settings in data/open set auth.skip_api_key_verification, auth.sub_keys, network.https_proxy, network.no_proxy, mcp.config_path, server.distributed_inference_enabled: reset them');
  assert.match(detail('local.c.settings'), /cannot be read/);
  assert.match(detail('local.e.base-path'), /add --base-path data\/omlx/);
  assert.equal(detail('local.h.flags'), 'remove --api-key, --mcp-config: the key comes from data/h.key, and oMLX needs no MCP servers nor proxy');
  // The value of a key never goes in a detail.
  assert.ok(!checks.some((check) => check.detail.includes("'k'")));
});

test('omlxSettingsChecks reads the settings of oMLX 0.7.1: keyless inference, Splash, proxy flags, the wrapper of the macOS app (D-221)', () => {
  const home = join(HOME, 'omlx-071');
  const data = join(home, 'data');
  const write = (dir: string, file: string, content: unknown): void => {
    mkdirSync(join(data, dir), { recursive: true });
    writeFileSync(join(data, dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  };
  // As 0.7.1 writes them: the new key present and off, Splash unset, no external engine.
  write('clean', 'settings.json', { auth: { api_key: 'x', skip_api_key_verification: false, allow_unauthenticated_inference: false, sub_keys: [] }, integrations: { splash_path: null, web_search_provider: 'ddgs' }, server: { distributed_inference_enabled: false } });
  write('clean', 'model_settings.json', { version: 1, models: { 'qwen-a': { external_engine: null }, 'qwen-b': {} } });
  write('keyless', 'settings.json', { auth: { allow_unauthenticated_inference: true } });
  write('splash', 'settings.json', { integrations: { splash_path: '/opt/homebrew/bin/splash' } });
  write('engine', 'model_settings.json', { version: 1, models: { 'qwen-a': { external_engine: 'splash' }, 'qwen-b': { external_engine: 'splash' }, 'qwen-c': {} } });
  write('broken-models', 'model_settings.json', '[]');
  // 0.6.x and 0.7.x share «Disable all authentication»; an odd value counts as on.
  write('odd', 'settings.json', { auth: { skip_api_key_verification: 'yes' }, server: { distributed_inference_enabled: 1 } });
  const serve = (base: string, ...extra: string[]): string[] => ['omlx', 'serve', '--base-path', `data/${base}`, ...extra];
  const checks = omlxSettingsChecks(home, data, [
    { id: 'a', command: serve('clean') },
    { id: 'b', command: serve('keyless') },
    { id: 'c', command: serve('splash') },
    { id: 'd', command: serve('engine') },
    { id: 'e', command: serve('broken-models') },
    { id: 'f', command: serve('odd') },
    { id: 'g', command: serve('clean', '--https-proxy', 'http://proxy.example:3128', '--no-proxy=*') },
    // The wrapper inside the app, which 0.7 no longer links into /opt/homebrew/bin, is still oMLX.
    { id: 'h', command: ['/Applications/oMLX.app/Contents/MacOS/omlx-cli', 'serve', '--base-path', 'data/keyless'] },
    // Not oMLX: a name that only ends like it.
    { id: 'i', command: ['/usr/bin/notomlx-cli', 'serve', '--api-key', 'k'] },
  ]);
  const result = (id: string): boolean | undefined => checks.find((check) => check.id === id)?.ok;
  const detail = (id: string): string => checks.find((check) => check.id === id)?.detail ?? '';
  assert.equal(result('local.a.settings'), true);
  assert.equal(result('local.a.flags'), true);
  assert.equal(detail('local.b.settings'), 'oMLX settings in data/keyless set auth.allow_unauthenticated_inference: reset them');
  assert.equal(detail('local.c.settings'), 'oMLX settings in data/splash set integrations.splash_path: reset them');
  // How many models, never their names.
  assert.equal(detail('local.d.settings'), 'oMLX settings in data/engine set external_engine of 2 models in model_settings.json: reset them');
  assert.ok(!detail('local.d.settings').includes('qwen'));
  assert.equal(result('local.e.settings'), false);
  assert.match(detail('local.e.settings'), /model_settings\.json cannot be read/);
  assert.equal(detail('local.f.settings'), 'oMLX settings in data/odd set auth.skip_api_key_verification, server.distributed_inference_enabled: reset them');
  assert.equal(result('local.g.flags'), false);
  assert.match(detail('local.g.flags'), /^remove --https-proxy, --no-proxy:/);
  assert.equal(result('local.g.settings'), true);
  assert.equal(result('local.h.settings'), false);
  assert.ok(!checks.some((check) => check.id.startsWith('local.i.')));
  // A proxy flag alone is enough.
  const proxyAlone = omlxSettingsChecks(home, data, [{ id: 'p', command: serve('clean', '--http-proxy', 'http://proxy.example:3128') }]);
  assert.equal(proxyAlone.find((check) => check.id === 'local.p.flags')?.ok, false);
  assert.match(proxyAlone.find((check) => check.id === 'local.p.flags')?.detail ?? '', /^remove --http-proxy:/);
  // What the wrapper of the app runs is oMLX too; modules that only look like it are not.
  const modules = omlxSettingsChecks(home, data, [
    { id: 'm1', command: ['python3', '-m', 'omlx.cli', 'serve', '--base-path', 'data/keyless'] },
    { id: 'm2', command: ['/Applications/oMLX.app/Contents/Resources/python/bin/python3.12', '-m', 'omlx.cli', 'serve', '--api-key', 'k'] },
    { id: 'm3', command: ['python', '-m', 'omlx.cli', 'serve'] },
    { id: 'n1', command: ['python3', '-m', 'omlx.client', 'serve', '--api-key', 'k'] },
    { id: 'n2', command: ['python3', '-m', 'notomlx.cli', 'serve', '--api-key', 'k'] },
    { id: 'n3', command: ['mypython3', '-m', 'omlx.cli', 'serve', '--api-key', 'k'] },
    { id: 'n4', command: ['python3', 'omlx.cli', 'serve', '--api-key', 'k'] },
  ]);
  assert.deepEqual([...new Set(modules.map((check) => check.id.split('.')[1]))], ['m1', 'm2', 'm3']);
  assert.equal(modules.find((check) => check.id === 'local.m1.settings')?.ok, false);
  assert.equal(modules.find((check) => check.id === 'local.m2.flags')?.ok, false);
  // The log level is checked for the wrapper too.
  assert.deepEqual(
    omlxLogChecks([{ id: 'h', command: ['/Applications/oMLX.app/Contents/MacOS/omlx-cli', 'serve', '--log-level', 'trace'] }]).map((check) => check.ok),
    [false],
  );
});

test('omlxSettingsChecks fails on GGUF files where oMLX 0.7.1 finds them, which it would serve through Splash: a count, never a name (D-221)', () => {
  const home = join(HOME, 'omlx-gguf');
  const data = join(home, 'data');
  const file = (path: string): void => {
    mkdirSync(join(home, path, '..'), { recursive: true });
    writeFileSync(join(home, path), 'x');
  };
  // MLX models only: safetensors, and names that merely contain gguf.
  file('data/models/qwen-mlx/model.safetensors');
  file('data/models/qwen-mlx/gguf-notes.txt');
  mkdirSync(join(home, 'data/models/folder.gguf'), { recursive: true });
  // GGUF files: at the root of a model folder, deeper, upper case, in another --model-dir, in gguf/ of --base-path.
  file('data/models-gguf/secret-model/secret-model-Q4.gguf');
  file('data/models-gguf/secret-model/split/part-00001-of-00002.GGUF');
  file('data/more/other.gguf');
  file('data/omlx-gguf/gguf/staged/staged.gguf');
  // Without --model-dir oMLX looks in <base-path>/models.
  file('data/omlx-default/models/a/a.gguf');
  const serve = (...extra: string[]): string[] => ['omlx', 'serve', ...extra];
  const checks = omlxSettingsChecks(home, data, [
    { id: 'a', command: serve('--model-dir', 'data/models', '--base-path', 'data/omlx') },
    { id: 'b', command: serve('--model-dir', 'data/models-gguf', '--base-path', 'data/omlx') },
    { id: 'c', command: serve('--model-dir=data/models, data/more', '--base-path', 'data/omlx') },
    { id: 'd', command: serve('--model-dir', 'data/models', '--base-path', 'data/omlx-gguf') },
    { id: 'e', command: serve('--base-path', 'data/omlx-default') },
    // Without --base-path the model folders are still checked.
    { id: 'f', command: serve('--model-dir', 'data/models-gguf') },
  ]);
  const gguf = (id: string): { ok: boolean; detail: string } | undefined => checks.find((check) => check.id === `local.${id}.gguf`);
  assert.deepEqual(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => gguf(id)?.ok),
    [true, false, false, false, false, false],
  );
  assert.match(gguf('b')?.detail ?? '', /^2 GGUF files in the model folders/);
  assert.match(gguf('c')?.detail ?? '', /^1 GGUF file in the model folders/);
  assert.ok(!checks.some((check) => /secret|staged|other|part-/.test(check.detail)));
});

test('a model of data/guard/models left in data/models fails the doctor: oMLX would list it (D-203)', () => {
  const sha = 'a'.repeat(64);
  const entry = (id: string, extra: string) => `
  - id: ${id}
    family: fake
${extra}    ram_min_gib: 1
    status: experimental
    files:
      - path: model.safetensors
        url: https://example.org/${id}/model.safetensors
        size_bytes: 10
        sha256: ${sha}
`;
  const catalog = parseCatalog(`version: 1\nmodels:${entry('fake-pii', '    runtime: transformers\n    dir: guard\n    roles: [pii]\n')}${entry('fake-mlx', '    runtime: mlx\n    roles: [orchestrator]\n')}`);
  const data = join(HOME, 'guard-dir');
  mkdirSync(join(data, 'models', 'fake-mlx'), { recursive: true });
  mkdirSync(join(data, 'guard', 'models', 'fake-pii'), { recursive: true });
  assert.deepEqual(guardDirChecks(catalog, data).map(({ id, ok }) => ({ id, ok })), [{ id: 'models.guard-dir', ok: true }]);
  mkdirSync(join(data, 'models', 'fake-pii'), { recursive: true });
  const stray = guardDirChecks(catalog, data).find((check) => check.id === 'models.guard-dir');
  assert.equal(stray?.ok, false);
  assert.match(stray.detail, /data\/models\/fake-pii .*oMLX may see it, move it to data\/guard\/models\/fake-pii/);
  // A copy in the bin of data/models counts too.
  rmSync(join(data, 'models', 'fake-pii'), { recursive: true });
  mkdirSync(join(data, 'models', 'eliminati', '2026-10-07T21-00-00-000Z-fake-pii'), { recursive: true });
  assert.equal(guardDirChecks(catalog, data)[0]?.ok, false);
  // Without a model of apps/guard in the catalog there is nothing to check.
  assert.deepEqual(guardDirChecks({ version: 1, models: catalog.models.filter((model) => model.dir !== 'guard') }, data), []);
});
