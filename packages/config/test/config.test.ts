import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  CATALOG_FILE,
  CONFIG_FILE,
  ConfigError,
  EXAMPLE_CONFIG_FILE,
  loadConfig,
  parseCatalog,
  parseConfig,
  resolveHome,
} from '../src/index.ts';

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
    roles: {},
    local: { endpoints: [] },
    cloud: { allowlist: [], executors: [] },
  });
});

test('cloud.allowlist keeps repositories inside ARIANNA_HOME, as relative paths', () => {
  const config = parseConfig(`${VALID}\n[cloud]\nallowlist = ["repos/site", "./work/app/"]\n`, HOME);
  assert.deepEqual(config.cloud, { allowlist: ['repos/site', 'work/app'], executors: [] });
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

test('telegram is off without its section, and takes a vault reference and private chat ids', () => {
  assert.equal(parseConfig(VALID, HOME).telegram, undefined);
  const config = parseConfig(`${VALID}\n[telegram]\ntoken = "vault://telegram-bot-token"\nchats = [123456789]\n`, HOME);
  assert.deepEqual(config.telegram, { token: 'vault://telegram-bot-token', chats: [123456789] });
});

test('telegram rejects a token in clear, group chats, duplicates and an empty list', () => {
  const cases: [string, RegExp][] = [
    ['token = "123456:AAAAfake"\nchats = [1]', /vault:\/\/ reference/],
    ['token = "vault://Bad Name"\nchats = [1]', /vault:\/\/ reference/],
    ['token = "vault://telegram-bot-token"\nchats = [-1001234]', /positive id/],
    ['token = "vault://telegram-bot-token"\nchats = ["123"]', /positive id/],
    ['token = "vault://telegram-bot-token"\nchats = [1.5]', /positive id/],
    ['token = "vault://telegram-bot-token"\nchats = [7, 7]', /listed twice/],
    ['token = "vault://telegram-bot-token"\nchats = []', /at least one chat/],
    ['token = "vault://telegram-bot-token"', /expected a list/],
    ['token = "vault://telegram-bot-token"\nchats = [1]\nwebhook = "https://example.invalid"', /unknown key/],
  ];
  for (const [section, pattern] of cases) {
    assert.throws(
      () => parseConfig(`${VALID}\n[telegram]\n${section}\n`, HOME),
      (error: unknown) => error instanceof ConfigError && pattern.test(error.message),
      section,
    );
  }
});

test('the committed example configuration is valid', () => {
  const home = resolveHome({});
  const config = parseConfig(readFileSync(join(home, EXAMPLE_CONFIG_FILE), 'utf8'), home);
  assert.equal(config.paths.data, join(home, 'data'));
});

test('without config/arianna.toml loading fails and names the wizard', () => {
  const emptyHome = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
  mkdirSync(join(emptyHome, 'config'), { recursive: true });
  try {
    assert.throws(
      () => loadConfig({ ARIANNA_HOME: emptyHome }),
      (error: unknown) => error instanceof ConfigError && /arianna:init/.test(error.message),
    );
  } finally {
    rmSync(emptyHome, { recursive: true });
  }
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

test('database passwords are vault references, both or neither, and distinct', () => {
  const database = (lines: string) => parseConfig(VALID.replace('user = "arianna"', `user = "arianna"\n${lines}`), HOME).database;
  assert.deepEqual(database('password = "vault://db-owner"\napp_password = "vault://db-app"'), {
    host: '127.0.0.1',
    port: 54329,
    name: 'arianna',
    user: 'arianna',
    password: 'vault://db-owner',
    appPassword: 'vault://db-app',
  });
  const rejects = (lines: string, pattern: RegExp): void => {
    assert.throws(() => database(lines), (error: unknown) => error instanceof ConfigError && pattern.test(error.message));
  };
  rejects('password = "s3cret-in-clear"\napp_password = "vault://db-app"', /vault:\/\/ reference/);
  rejects('password = "vault://db-owner"\napp_password = "plain"', /vault:\/\/ reference/);
  rejects('password = "vault://db-owner"', /together/);
  rejects('app_password = "vault://db-app"', /together/);
  rejects('password = "vault://db"\napp_password = "vault://db"', /different secret/);
  assert.throws(() => parseConfig(VALID.replace('user = "arianna"', 'user = "arianna_app"'), HOME), /application role/);
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
  // A second home inside data/ (never in git), with a copy of the committed example.
  const movedHome = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
  mkdirSync(join(movedHome, 'config'), { recursive: true });
  try {
    cpSync(join(resolveHome({}), EXAMPLE_CONFIG_FILE), join(movedHome, CONFIG_FILE));
    cpSync(join(resolveHome({}), CATALOG_FILE), join(movedHome, CATALOG_FILE));
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

const SHA = 'b'.repeat(64);
const CATALOG = parseCatalog(`
version: 1
models:
  - id: big-mlx
    family: fake
    runtime: mlx
    ram_min_gib: 20
    roles: [orchestrator]
    status: verified
    files: [{ path: m.bin, url: "https://example.org/big", size_bytes: 1, sha256: ${SHA} }]
  - id: small-mlx
    family: fake
    runtime: mlx
    ram_min_gib: 4
    roles: [extractor, orchestrator]
    status: experimental
    files: [{ path: m.bin, url: "https://example.org/small", size_bytes: 1, sha256: ${SHA} }]
`);

const ROLES = '\n[roles]\norchestrator = "big-mlx"\nextractor = "small-mlx"\n';
const OMLX = '\n[[local.endpoints]]\nid = "omlx"\nurl = "http://127.0.0.1:7001/v1"\n';

test('roles name catalog models suited to them, and endpoints without models take their names', () => {
  const config = parseConfig(`${VALID}${ROLES}${OMLX}`, HOME, CATALOG);
  assert.deepEqual(config.roles, { orchestrator: 'big-mlx', extractor: 'small-mlx' });
  assert.deepEqual(config.local.endpoints[0]?.models, { 'local-large': 'big-mlx', 'local-small': 'small-mlx' });
  // Explicit names win over the roles: a fallback server with other names.
  const explicit = parseConfig(`${VALID}${ROLES}${OMLX}models = { "local-large" = "other" }\n`, HOME, CATALOG);
  assert.deepEqual(explicit.local.endpoints[0]?.models, { 'local-large': 'other' });
});

test('roles outside the catalog, unsuited to the role or unknown are rejected', () => {
  const rejects = (roles: string, pattern: RegExp): void => {
    assert.throws(
      () => parseConfig(`${VALID}\n[roles]\n${roles}\n`, HOME, CATALOG),
      (error: unknown) => error instanceof ConfigError && pattern.test(error.message),
      roles,
    );
  };
  rejects('orchestrator = "missing-mlx"', /not in config\/models\.catalog\.yaml/);
  rejects('extractor = "big-mlx"', /not suited/);
  rejects('planner = "big-mlx"', /expected one of/);
  rejects('orchestrator = ""', /non-empty/);
  // Without a catalog no role can be assigned.
  assert.throws(() => parseConfig(`${VALID}${ROLES}`, HOME), ConfigError);
});

test('an endpoint with neither models nor roles is rejected', () => {
  assert.throws(
    () => parseConfig(`${VALID}${OMLX}`, HOME, CATALOG),
    (error: unknown) => error instanceof ConfigError && /\[roles\]/.test(error.message),
  );
  assert.throws(() => parseConfig(`${VALID}${OMLX}models = {}\n`, HOME, CATALOG), ConfigError);
});

test('cloud.executors lists the enabled official binaries, once each', () => {
  assert.deepEqual(parseConfig(`${VALID}\n[cloud]\nexecutors = ["claude", "codex"]\n`, HOME).cloud.executors, ['claude', 'codex']);
  assert.throws(() => parseConfig(`${VALID}\n[cloud]\nexecutors = ["gemini"]\n`, HOME), ConfigError);
  assert.throws(() => parseConfig(`${VALID}\n[cloud]\nexecutors = ["claude", "claude"]\n`, HOME), ConfigError);
  assert.throws(() => parseConfig(`${VALID}\n[cloud]\nexecutors = "claude"\n`, HOME), ConfigError);
});
