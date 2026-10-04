import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_SETTINGS,
  EXAMPLE_CONFIG_FILE,
  parseCatalog,
  parseConfig,
  readSettings,
  renderSettings,
  resolveHome,
  type Settings,
} from '../src/index.ts';

const HOME = resolve('some-home');
const SHA = 'c'.repeat(64);
const CATALOG = parseCatalog(`
version: 1
models:
  - id: big-mlx
    family: fake
    runtime: mlx
    ram_min_gib: 20
    roles: [orchestrator, extractor]
    status: verified
    files: [{ path: m.bin, url: "https://example.org/big", size_bytes: 1, sha256: ${SHA} }]
`);

const FULL: Settings = {
  database: {
    host: '::1',
    port: 5433,
    name: 'arianna',
    user: 'owner',
    password: 'vault://db-owner-password',
    appPassword: 'vault://db-app-password',
  },
  server: { host: '::1', port: 7500 },
  roles: { orchestrator: 'big-mlx', extractor: 'big-mlx' },
  endpoints: [
    { id: 'omlx', url: 'http://127.0.0.1:7001/v1', command: ['omlx', 'serve', '--model-dir', 'data/models'] },
    { id: 'spare', url: 'http://[::1]:1234/v1', models: { 'local-large': 'Qwen "large"' } },
  ],
  cloud: { executors: ['claude', 'codex'] },
  projects: [
    { name: 'site', path: '~/Projects/odd "name" à', label: 'L1' },
    { name: 'demo', path: 'repos/demo', label: 'L0' },
  ],
  characters: { arianna: 'originali/arianna', coder: 'my-pack/robot_2' },
  telegram: { token: 'vault://telegram-bot-token', chats: [12345, 67890] },
};

test('the committed example is the rendering of the defaults', () => {
  const example = readFileSync(join(resolveHome({}), EXAMPLE_CONFIG_FILE), 'utf8');
  assert.equal(example, renderSettings(DEFAULT_SETTINGS), 'regenerate config/arianna.example.toml with renderSettings(DEFAULT_SETTINGS)');
});

test('every setting survives rendering and reading back', () => {
  for (const settings of [DEFAULT_SETTINGS, FULL]) {
    assert.deepEqual(readSettings(renderSettings(settings), HOME, CATALOG), settings);
  }
});

test('backslashes, newlines, tabs and control characters are escaped', () => {
  const odd = 'a\\b\n"c"\td\u007fe\u0001f';
  const settings: Settings = { ...DEFAULT_SETTINGS, endpoints: [{ id: 'spare', url: 'http://[::1]:1234/v1', models: { 'local-large': odd } }] };
  assert.deepEqual(readSettings(renderSettings(settings), HOME, CATALOG), settings);
});

test('the rendered file is what loadConfig reads: roles become the names of the first endpoint', () => {
  const config = parseConfig(renderSettings(FULL), HOME, CATALOG);
  assert.deepEqual(config.local.endpoints[0]?.models, { 'local-large': 'big-mlx', 'local-small': 'big-mlx' });
  assert.deepEqual(config.local.endpoints[1]?.models, { 'local-large': 'Qwen "large"' });
  assert.deepEqual(config.cloud.executors, ['claude', 'codex']);
});

test('reading validates: an invalid file is not turned into settings', () => {
  assert.throws(() => readSettings(renderSettings(FULL), HOME, parseCatalog('version: 1\nmodels: []\n')));
  assert.throws(() => readSettings(`${renderSettings(DEFAULT_SETTINGS)}\n[extra]\n`, HOME, CATALOG));
});

test('absent optional sections stay commented out, not set', () => {
  const text = renderSettings(DEFAULT_SETTINGS);
  assert.match(text, /^# password = "vault:\/\/db-owner-password"$/m);
  assert.match(text, /^# \[telegram\]$/m);
  assert.match(text, /^# \[\[local\.endpoints\]\]$/m);
  assert.doesNotMatch(text, /^\[telegram\]$/m);
});
