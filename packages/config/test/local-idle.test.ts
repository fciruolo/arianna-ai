// `[local] idle_unload_minutes` (D-316): minutes without requests before the
// core unloads a local model; 0 never, 30 when absent.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { ConfigError, DEFAULT_IDLE_UNLOAD_MINUTES, diffConfig, EMPTY_CATALOG, parseConfig, readSettings, renderSettings } from '../src/index.ts';

const HOME = resolve('some-home');
const VALID = `
[paths]
data = "data"

[database]
host = "127.0.0.1"
port = 54329
name = "arianna"
user = "arianna"
`;
const ENDPOINT = '[[local.endpoints]]\nid = "omlx"\nurl = "http://127.0.0.1:7001/v1"\nmodels = { "local-large" = "big" }\n';
const idle = (section: string) => parseConfig(`${VALID}\n${section}\n`, HOME).local.idleUnloadMinutes;

test('[local] idle_unload_minutes: 30 when absent, with or without endpoints', () => {
  assert.equal(DEFAULT_IDLE_UNLOAD_MINUTES, 30);
  assert.equal(idle(''), 30);
  assert.equal(idle(ENDPOINT), 30);
});

test('[local] idle_unload_minutes: a whole number from 0 (never) to 1440', () => {
  assert.equal(idle('[local]\nidle_unload_minutes = 0'), 0);
  assert.equal(idle(`[local]\nidle_unload_minutes = 5\n\n${ENDPOINT}`), 5);
  assert.equal(idle('[local]\nidle_unload_minutes = 1440'), 1440);
  for (const bad of ['-1', '1441', '2.5', '"30"', 'true']) {
    assert.throws(() => idle(`[local]\nidle_unload_minutes = ${bad}`), ConfigError, bad);
  }
});

test('[local] idle_unload_minutes: written back only when the file has it, applied without a restart and without touching the servers', () => {
  const text = `${VALID}\n${ENDPOINT}`;
  const before = readSettings(text, HOME, EMPTY_CATALOG);
  assert.equal(before.idleUnloadMinutes, undefined);
  assert.match(renderSettings(before), /^# idle_unload_minutes = 30$/m);
  const written = renderSettings({ ...before, idleUnloadMinutes: 10 });
  assert.match(written, /^\[local\]\nidle_unload_minutes = 10$/m);
  const after = readSettings(written, HOME, EMPTY_CATALOG);
  assert.equal(after.idleUnloadMinutes, 10);
  assert.deepEqual(after.endpoints, before.endpoints);
  assert.deepEqual(diffConfig(parseConfig(text, HOME), parseConfig(written, HOME)), { applied: ['local.idle'], restart: [] });
});
