import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ensureOmlxHfCacheOff, startsOmlx } from '../src/omlx-settings.ts';

const HOME = mkdtempSync(join(tmpdir(), 'arianna-omlx-settings-'));
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const serve = (base: string): string[] => ['omlx', 'serve', '--model-dir', 'data/models', '--base-path', base];

test('the core writes huggingface.hf_cache_enabled: false in a missing settings.json of oMLX, with that key alone (D-263)', () => {
  const home = join(HOME, 'missing');
  const data = join(home, 'data');
  mkdirSync(data, { recursive: true });
  assert.equal(ensureOmlxHfCacheOff(home, data, serve('data/omlx')), 'written');
  const file = join(data, 'omlx', 'settings.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { huggingface: { hf_cache_enabled: false } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // Twice is harmless, and the folder holds nothing else.
  assert.equal(ensureOmlxHfCacheOff(home, data, serve('data/omlx')), 'already-off');
  assert.deepEqual(readdirSync(join(data, 'omlx')), ['settings.json']);
});

test('an existing settings.json keeps every other key and its permissions; only hf_cache_enabled changes (D-263)', () => {
  const home = join(HOME, 'existing');
  const data = join(home, 'data');
  mkdirSync(join(data, 'omlx'), { recursive: true });
  const file = join(data, 'omlx', 'settings.json');
  const before = { version: '1.0', auth: { api_key: 'x', sub_keys: [] }, huggingface: { endpoint: '', hf_cache_enabled: true }, unknown: { kept: [1, 2] } };
  writeFileSync(file, JSON.stringify(before));
  chmodSync(file, 0o640);
  writeFileSync(join(data, 'omlx', 'model_settings.json'), '{"models":{}}');
  assert.equal(ensureOmlxHfCacheOff(home, data, serve('data/omlx')), 'written');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...before, huggingface: { endpoint: '', hf_cache_enabled: false } });
  assert.equal(statSync(file).mode & 0o777, 0o640);
  // No other file of oMLX touched, no temporary file left.
  assert.equal(readFileSync(join(data, 'omlx', 'model_settings.json'), 'utf8'), '{"models":{}}');
  assert.deepEqual(readdirSync(join(data, 'omlx')).sort(), ['model_settings.json', 'settings.json']);
  // A settings.json without the huggingface section gets it.
  writeFileSync(file, JSON.stringify({ server: { port: 7001 } }));
  assert.equal(ensureOmlxHfCacheOff(home, data, serve('data/omlx')), 'written');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { server: { port: 7001 }, huggingface: { hf_cache_enabled: false } });
});

test('an unreadable settings.json, a command that is not oMLX and a --base-path outside data/ are left alone (D-263)', () => {
  const home = join(HOME, 'alone');
  const data = join(home, 'data');
  mkdirSync(join(data, 'broken'), { recursive: true });
  for (const [name, content] of [['broken', '{not json'], ['array', '[]'], ['odd-section', '{"huggingface":"off"}']] as const) {
    mkdirSync(join(data, name), { recursive: true });
    writeFileSync(join(data, name, 'settings.json'), content);
    assert.equal(ensureOmlxHfCacheOff(home, data, serve(`data/${name}`)), 'unreadable');
    assert.equal(readFileSync(join(data, name, 'settings.json'), 'utf8'), content);
  }
  // Not oMLX: nothing written, not even the folder.
  assert.equal(ensureOmlxHfCacheOff(home, data, ['llama-server', 'serve', '--base-path', 'data/llama']), 'not-omlx');
  assert.equal(existsSync(join(data, 'llama')), false);
  // Outside data/, data/ itself, no --base-path, a link leading outside.
  mkdirSync(join(home, 'outside'), { recursive: true });
  symlinkSync(join(home, 'outside'), join(data, 'linked'));
  assert.equal(ensureOmlxHfCacheOff(home, data, serve('elsewhere')), 'outside-data');
  assert.equal(ensureOmlxHfCacheOff(home, data, serve('data')), 'outside-data');
  assert.equal(ensureOmlxHfCacheOff(home, data, ['omlx', 'serve']), 'outside-data');
  assert.equal(ensureOmlxHfCacheOff(home, data, serve('data/linked')), 'outside-data');
  assert.equal(existsSync(join(home, 'elsewhere')), false);
  assert.deepEqual(readdirSync(join(home, 'outside')), []);
  assert.equal(existsSync(join(data, 'settings.json')), false);
});

test('startsOmlx: omlx, the wrapper of the app and python -m omlx.cli; look-alikes are not oMLX', () => {
  assert.equal(startsOmlx(['omlx', 'serve']), true);
  assert.equal(startsOmlx(['/Applications/oMLX.app/Contents/MacOS/omlx-cli', 'serve']), true);
  assert.equal(startsOmlx(['python3', '-m', 'omlx.cli', 'serve']), true);
  assert.equal(startsOmlx(['omlx']), false);
  assert.equal(startsOmlx(['notomlx', 'serve']), false);
  assert.equal(startsOmlx(['python3', '-m', 'omlx.client', 'serve']), false);
});
