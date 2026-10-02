import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { CONFIG_FILE, ConfigError, loadConfig, parseConfig, resolveHome } from '../src/index.ts';

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

test('a valid configuration is parsed and its paths are resolved inside home', () => {
  assert.deepEqual(parseConfig(VALID, HOME), {
    home: HOME,
    paths: { data: join(HOME, 'data') },
    database: { host: '127.0.0.1', port: 54329, name: 'arianna', user: 'arianna' },
  });
});

test('the committed configuration loads', () => {
  const config = loadConfig({});
  assert.equal(config.home, resolveHome({}));
  assert.equal(config.paths.data, join(config.home, 'data'));
});

test('unknown keys are rejected', () => {
  assert.throws(() => parseConfig(`${VALID}\n[telemetry]\nenabled = true\n`, HOME), ConfigError);
  assert.throws(() => parseConfig(VALID.replace('user =', 'usr ='), HOME), ConfigError);
});

test('absolute and escaping data paths are rejected', () => {
  const absolute = JSON.stringify(resolve('elsewhere'));
  assert.throws(() => parseConfig(VALID.replace('"data"', absolute), HOME), ConfigError);
  assert.throws(() => parseConfig(VALID.replace('"data"', '"../data"'), HOME), ConfigError);
});

test('wrong types and malformed TOML are rejected', () => {
  assert.throws(() => parseConfig(VALID.replace('54329', '"54329"'), HOME), ConfigError);
  assert.throws(() => parseConfig(VALID.replace('54329', '70000'), HOME), ConfigError);
  assert.throws(() => parseConfig('[paths', HOME), ConfigError);
});

test('moving the folder moves every path with it', () => {
  // A second home inside data/ (never in git), with a copy of the committed configuration.
  const movedHome = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
  mkdirSync(join(movedHome, 'config'), { recursive: true });
  try {
    cpSync(join(resolveHome({}), CONFIG_FILE), join(movedHome, CONFIG_FILE));
    const config = loadConfig({ ARIANNA_HOME: movedHome });
    assert.equal(config.home, movedHome);
    assert.equal(config.paths.data, join(movedHome, 'data'));
  } finally {
    rmSync(movedHome, { recursive: true });
  }
});
