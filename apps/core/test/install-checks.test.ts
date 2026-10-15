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
  assert.deepEqual(
    checks.map((check) => [check.id, check.ok]),
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
  assert.equal(detail('local.b.settings'), 'settings.json sets auth.skip_api_key_verification, auth.sub_keys, network.https_proxy, network.no_proxy, mcp.config_path, server.distributed_inference_enabled: reset in data/open/settings.json');
  assert.match(detail('local.c.settings'), /cannot be read/);
  assert.match(detail('local.e.base-path'), /add --base-path data\/omlx/);
  assert.equal(detail('local.h.flags'), 'remove --api-key, --mcp-config: the key comes from data/h.key');
  // The value of a key never goes in a detail.
  assert.ok(!checks.some((check) => check.detail.includes("'k'")));
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
