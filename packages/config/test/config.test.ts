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
    server: { host: '127.0.0.1', port: 7420 },
    local: { endpoints: [] },
    cloud: { allowlist: [] },
  });
});

test('cloud.allowlist keeps repositories inside ARIANNA_HOME, as relative paths', () => {
  const config = parseConfig(`${VALID}\n[cloud]\nallowlist = ["repos/site", "./work/app/"]\n`, HOME);
  assert.deepEqual(config.cloud, { allowlist: ['repos/site', 'work/app'] });
});

test('cloud.allowlist rejects home itself, data/, escapes, duplicates and nesting', () => {
  const rejects = (list: string, pattern: RegExp): void => {
    assert.throws(
      () => parseConfig(`${VALID}\n[cloud]\nallowlist = [${list}]\n`, HOME),
      (error: unknown) => error instanceof ConfigError && pattern.test(error.message),
    );
  };
  rejects('"."', /ARIANNA_HOME itself/);
  rejects('"data"', /data\//);
  rejects('"data/worktrees/x"', /data\//);
  rejects('"/abs/repo"', /absolute/);
  rejects('"repos/../../x"', /escapes/);
  rejects('"repos/a", "repos/a/"', /twice/);
  rejects('"repos/a", "repos/a/b"', /nested/);
  rejects('"repos/a/b", "repos/a"', /nested/);
  rejects('"data/..cache"', /data\//);
  rejects('"repos/A", "repos/a/b"', /nested/);
  rejects('"Repos/x", "repos/X"', /twice/);
});

test('cloud.allowlist accepts siblings that only share a prefix', () => {
  const config = parseConfig(`${VALID}\n[cloud]\nallowlist = ["repos/a", "repos/ab", "..cache/x"]\n`, HOME);
  assert.deepEqual(config.cloud.allowlist, ['repos/a', 'repos/ab', '..cache/x']);
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

test('the data folder must be the one git ignores', () => {
  assert.throws(() => parseConfig(VALID.replace('"data"', '"storage"'), HOME), ConfigError);
  assert.throws(() => parseConfig(VALID.replace('"data"', '"."'), HOME), ConfigError);
  assert.throws(() => parseConfig(VALID.replace('"data"', '"data/../.git"'), HOME), ConfigError);
  assert.equal(parseConfig(VALID.replace('"data"', '"./data"'), HOME).paths.data, join(HOME, 'data'));
});

test('the database must be on this machine', () => {
  assert.throws(() => parseConfig(VALID.replace('127.0.0.1', 'db.example.org'), HOME), ConfigError);
  assert.throws(() => parseConfig(VALID.replace('127.0.0.1', '0.0.0.0'), HOME), ConfigError);
  assert.equal(parseConfig(VALID.replace('127.0.0.1', 'localhost'), HOME).database.host, 'localhost');
});

test('the server listens on loopback only', () => {
  const server = (body: string) => parseConfig(`${VALID}\n[server]\n${body}\n`, HOME).server;
  assert.deepEqual(server('port = 8080'), { host: '127.0.0.1', port: 8080 });
  assert.deepEqual(server('host = "::1"'), { host: '::1', port: 7420 });
  assert.throws(() => server('host = "0.0.0.0"'), ConfigError);
  assert.throws(() => server('host = "192.168.1.10"'), ConfigError);
  // A name depends on /etc/hosts: addresses only.
  assert.throws(() => server('host = "localhost"'), ConfigError);
  assert.throws(() => server('port = 0'), ConfigError);
  assert.throws(() => server('tls = true'), ConfigError);
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

const LOCAL = `
[[local.endpoints]]
id = "omlx"
url = "http://127.0.0.1:8000/v1"
command = ["omlx", "serve", "--port", "8000"]
models = { "local-large" = "qwen-large", "local-small" = "qwen-small" }

[[local.endpoints]]
id = "lmstudio"
url = "http://[::1]:1234/v1"
models = { "local-large" = "qwen-large-gguf" }
`;

test('local endpoints are parsed in order, command optional', () => {
  assert.deepEqual(parseConfig(`${VALID}${LOCAL}`, HOME).local, {
    endpoints: [
      {
        id: 'omlx',
        url: 'http://127.0.0.1:8000/v1',
        command: ['omlx', 'serve', '--port', '8000'],
        models: { 'local-large': 'qwen-large', 'local-small': 'qwen-small' },
      },
      { id: 'lmstudio', url: 'http://[::1]:1234/v1', models: { 'local-large': 'qwen-large-gguf' } },
    ],
  });
});

test('local endpoints must be on this machine', () => {
  for (const url of ['http://192.168.1.10:8000/v1', 'https://api.example.com/v1', 'http://0.0.0.0:8000/v1', 'http://localhost:8000/v1']) {
    assert.throws(() => parseConfig(`${VALID}${LOCAL.replace('http://127.0.0.1:8000/v1', url)}`, HOME), ConfigError, url);
  }
  assert.throws(() => parseConfig(`${VALID}${LOCAL.replace('127.0.0.1:8000/v1', 'u:p@127.0.0.1:8000/v1')}`, HOME), ConfigError);
  assert.throws(() => parseConfig(`${VALID}${LOCAL.replace('http://127.0.0.1', 'file://127.0.0.1')}`, HOME), ConfigError);
});

test('invalid local endpoints are rejected', () => {
  assert.throws(() => parseConfig(`${VALID}${LOCAL.replace('"lmstudio"', '"omlx"')}`, HOME), ConfigError);
  assert.throws(() => parseConfig(`${VALID}${LOCAL.replace('"omlx"', '"Omlx Server"')}`, HOME), ConfigError);
  assert.throws(() => parseConfig(`${VALID}${LOCAL.replace('command = ["omlx", "serve", "--port", "8000"]', 'command = []')}`, HOME), ConfigError);
  assert.throws(() => parseConfig(`${VALID}${LOCAL.replace('command = ["omlx", "serve", "--port", "8000"]', 'command = "omlx serve"')}`, HOME), ConfigError);
  assert.throws(() => parseConfig(`${VALID}${LOCAL.replace('"local-small" = "qwen-small"', '"Local Small" = "x"')}`, HOME), ConfigError);
  assert.throws(() => parseConfig(`${VALID}${LOCAL.replace('id = "lmstudio"', 'id = "lmstudio"\nkey = "x"')}`, HOME), ConfigError);
});
