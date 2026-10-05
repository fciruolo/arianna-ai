import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  CATALOG_FILE,
  cloudModelName,
  CONFIG_FILE,
  ConfigError,
  defaultCloudModels,
  enabledCloudModels,
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
    cloud: { executors: [], models: defaultCloudModels() },
    projects: [],
    characters: {},
    personas: {},
    agents: {},
    sprites: { model: 'sonnet' },
  });
});

test('characters (D-060): agent = "<pack>/<character>", nothing else', () => {
  const characters = (section: string) => parseConfig(`${VALID}\n[characters]\n${section}\n`, HOME).characters;
  assert.deepEqual(characters('arianna = "originali/arianna"\ncoder = "my-pack/robot_2"'), {
    arianna: 'originali/arianna',
    coder: 'my-pack/robot_2',
  });
  const dotted = ['..', 'x'].join('/');
  for (const bad of ['arianna = "arianna"', 'arianna = "a/b/c"', `arianna = "${dotted}"`, 'arianna = "Pack/x"', 'arianna = "p/x.png"', 'arianna = ""', 'arianna = 1', 'Arianna = "p/x"']) {
    assert.throws(() => characters(bad), { name: 'ConfigError' }, bad);
  }
});

// The user's home of these tests: ARIANNA_HOME is not inside it.
const USER = resolve('some-user');
const projects = (sections: string, userHome = USER) => parseConfig(`${VALID}\n${sections}\n`, HOME, undefined, userHome).projects;
const section = (name: string, path: string, label?: string) =>
  `[[project]]\nname = "${name}"\npath = "${path}"\n${label === undefined ? '' : `label = "${label}"\n`}`;

test('projects (D-058): a folder under the home or repos/<name>, L1 by default', () => {
  assert.deepEqual(projects(`${section('site', '~/Projects/site')}\n${section('demo', 'repos/demo', 'L0')}`), [
    { name: 'site', path: '~/Projects/site', absolute: join(USER, 'Projects', 'site'), label: 'L1' },
    { name: 'demo', path: 'repos/demo', absolute: join(HOME, 'repos', 'demo'), label: 'L0' },
  ]);
  assert.deepEqual(projects(''), []);
});

test('projects refuse the home, hidden folders, Library, other forms and labels above L1', () => {
  const rejects = (sections: string, pattern: RegExp, userHome = USER): void => {
    assert.throws(
      () => projects(sections, userHome),
      (error: unknown) => error instanceof ConfigError && pattern.test(error.message),
    );
  };
  rejects(section('home', '~/'), /plain name/);
  rejects(section('home', '~'), /write ~\/<folder>/);
  rejects(section('ssh', '~/.ssh'), /plain name/);
  rejects(section('deep', '~/Projects/.hidden/site'), /plain name/);
  rejects(section('up', '~/Projects/../x'), /plain name/);
  rejects(section('dot', '~/Projects/./x'), /plain name/);
  rejects(section('lib', '~/Library/Mobile Documents'), /Library/);
  rejects(section('abs', '/opt/site'), /write ~\/<folder>/);
  rejects(section('rel', 'Projects/site'), /write ~\/<folder>/);
  rejects(section('demo', 'repos/other'), /repos\/demo/);
  rejects(section('demo', 'repos/demo/sub'), /repos\/demo/);
  rejects(section('Site', '~/Projects/site'), /lowercase/);
  rejects(section('a.b', '~/Projects/site'), /lowercase/);
  rejects(section('site', '~/Projects/site', 'L2'), /L0 or L1/);
  rejects(section('site', '~/Projects/site', 'L3'), /L0 or L1/);
  rejects(section('site', '~/Projects/site', 'top'), /L0, L1/);
  rejects(`[[project]]\nname = "site"\npath = "~/Projects/site"\nextra = 1\n`, /unknown key/);
});

test('projects refuse ARIANNA_HOME, folders inside it and folders around it', () => {
  // Here ARIANNA_HOME (some-home) sits inside the user's home (the folder that contains it).
  const userHome = resolve('.');
  const rejects = (path: string): void => {
    assert.throws(
      () => projects(section('x', path), userHome),
      (error: unknown) => error instanceof ConfigError && /ARIANNA_HOME/.test(error.message),
    );
  };
  rejects('~/some-home');
  rejects('~/some-home/repos/x');
  rejects('~/some-home/data');
  // Case does not open a way around it: on macOS the disk ignores it.
  rejects('~/Some-Home/repos/x');
  rejects('~/SOME-HOME');
  assert.equal(projects(section('x', '~/some-home-other'), userHome)[0]?.name, 'x');
  // Two levels around: a folder that holds the folder that holds ARIANNA_HOME.
  const deep = resolve('a', 'b', 'arianna');
  assert.throws(() => parseConfig(`${VALID}\n${section('x', '~/a')}\n`, deep, undefined, resolve('.')), /ARIANNA_HOME/);
});

test('projects refuse Library in any case and a home that is not a real folder', () => {
  assert.throws(() => projects(section('lib', '~/library/x')), /Library/);
  assert.throws(() => projects(section('lib', '~/LIBRARY')), /Library/);
  assert.throws(() => projects(section('x', '~/etc'), '/'), /HOME/);
  assert.throws(() => projects(section('x', '~/etc'), 'relative/home'), /HOME/);
  assert.deepEqual(projects('', '/'), []);
});

test('projects: names once, no folder twice nor one inside another, also by case', () => {
  const rejects = (sections: string, pattern: RegExp): void => {
    assert.throws(
      () => projects(sections),
      (error: unknown) => error instanceof ConfigError && pattern.test(error.message),
    );
  };
  rejects(`${section('a', '~/P/a')}\n${section('a', '~/P/b')}`, /twice/);
  rejects(`${section('a', '~/P/a')}\n${section('b', '~/P/a')}`, /same folder/);
  rejects(`${section('a', '~/P')}\n${section('b', '~/P/b')}`, /one inside the other/);
  rejects(`${section('a', '~/P/A')}\n${section('b', '~/p/a/x')}`, /one inside the other/);
  assert.equal(projects(`${section('a', '~/P/a')}\n${section('ab', '~/P/ab')}`).length, 2);
});

test('cloud.allowlist from before D-058 is refused with the way out, unless empty', () => {
  assert.throws(
    () => parseConfig(`${VALID}\n[cloud]\nallowlist = ["repos/demo"]\n`, HOME),
    (error: unknown) => error instanceof ConfigError && /\[\[project\]\]/.test(error.message) && /arianna:init --reconfigure/.test(error.message),
  );
  assert.deepEqual(parseConfig(`${VALID}\n[cloud]\nallowlist = []\n`, HOME).cloud, { executors: [], models: defaultCloudModels() });
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

test('[cloud.models]: every alias on by default, off with false, on under an exact name with a string (D-071)', () => {
  const cloud = (models: string) => parseConfig(`${VALID}\n[cloud]\nexecutors = ["claude"]\n\n[cloud.models]\n${models}\n`, HOME).cloud;
  assert.deepEqual(parseConfig(VALID, HOME).cloud.models, defaultCloudModels());
  const given = cloud('sonnet = true\nopus = "claude-opus-5-5[1m]"\nfable = false');
  assert.deepEqual(given.models, {
    sonnet: { enabled: true },
    opus: { enabled: true, name: 'claude-opus-5-5[1m]' },
    fable: { enabled: false },
    codex: { enabled: true },
  });
  assert.deepEqual(enabledCloudModels(given), ['sonnet', 'opus', 'codex']);
  assert.equal(cloudModelName(given, 'opus'), 'claude-opus-5-5[1m]');
  assert.equal(cloudModelName(given, 'sonnet'), 'sonnet', 'no name: the alias, the newest model for the binary');
});

test('[agents.<id>] model: a cloud model per agent, never for arianna (D-116)', () => {
  const agents = (text: string) => parseConfig(`${VALID}\n${text}\n`, HOME).agents;
  assert.deepEqual(parseConfig(VALID, HOME).agents, {}, 'without a model the router chooses');
  assert.deepEqual(agents('[agents.coder]\nmodel = "opus"\n\n[agents.writer]'), { coder: { model: 'opus' }, writer: {} });
  // A model turned off stays written: the core offers it only while it is on.
  assert.deepEqual(agents('[cloud.models]\nfable = false\n\n[agents.coder]\nmodel = "fable"'), { coder: { model: 'fable' } });
  const rejects = (text: string, pattern: RegExp): void => {
    assert.throws(
      () => parseConfig(`${VALID}\n${text}\n`, HOME),
      (error: unknown) => error instanceof ConfigError && pattern.test(error.message),
    );
  };
  rejects('[agents.arianna]\nmodel = "sonnet"', /agents\.arianna\.model: Arianna's model is the orchestrator/);
  rejects('[agents.coder]\nmodel = "haiku"', /agents\.coder\.model/);
  rejects('[agents.coder]\nmodel = "local-large"', /agents\.coder\.model/);
  rejects('[agents.coder]\ntools = ["repo.write"]', /unknown key/);
  rejects('[agents.Coder]\nmodel = "opus"', /an agent id/);
  rejects('[agents]\ncoder = "opus"', /agents\.coder/);
});

test('default of [cloud.models] from before D-116 is read as the Coder model', () => {
  const agents = (text: string) => parseConfig(`${VALID}\n[cloud.models]\n${text}\n`, HOME).agents;
  assert.deepEqual(agents('default = "opus"'), { coder: { model: 'opus' } });
  assert.deepEqual(agents('fable = false\ndefault = "fable"'), { coder: { model: 'fable' } }, 'off: kept, not offered');
  assert.deepEqual(agents('default = "opus"\n\n[agents.coder]\nmodel = "sonnet"'), { coder: { model: 'sonnet' } }, '[agents] wins');
  assert.deepEqual(agents('default = "opus"\n\n[agents.coder]'), { coder: { model: 'opus' } });
  for (const bad of ['"haiku"', '"local-large"', 'true']) {
    assert.throws(
      () => agents(`default = ${bad}`),
      (error: unknown) => error instanceof ConfigError && /cloud\.models\.default/.test(error.message),
    );
  }
});

test('[cloud.models] refuses unknown aliases and odd names', () => {
  const rejects = (models: string, pattern: RegExp): void => {
    assert.throws(
      () => parseConfig(`${VALID}\n[cloud.models]\n${models}\n`, HOME),
      (error: unknown) => error instanceof ConfigError && pattern.test(error.message),
    );
  };
  rejects('haiku = true', /unknown key/);
  rejects('opus = "-p"', /cloud\.models\.opus/);
  rejects('opus = "claude opus"', /cloud\.models\.opus/);
  rejects('opus = "claude;rm"', /cloud\.models\.opus/);
  rejects('opus = ""', /cloud\.models\.opus/);
  rejects(`opus = "${'a'.repeat(101)}"`, /cloud\.models\.opus/);
  rejects('opus = 1', /cloud\.models\.opus/);
  rejects('sonnet = "claude-fable-5-1"', /of the sonnet family/);
  rejects('sonnet = "fable"', /of the sonnet family/);
  rejects('opus = "opusx"', /of the opus family/);
  rejects('default = "haiku"', /cloud\.models\.default/);
  rejects('default = true', /cloud\.models\.default/);
});

test('cloud.executors lists the enabled official binaries, once each', () => {
  assert.deepEqual(parseConfig(`${VALID}\n[cloud]\nexecutors = ["claude", "codex"]\n`, HOME).cloud.executors, ['claude', 'codex']);
  assert.throws(() => parseConfig(`${VALID}\n[cloud]\nexecutors = ["gemini"]\n`, HOME), ConfigError);
  assert.throws(() => parseConfig(`${VALID}\n[cloud]\nexecutors = ["claude", "claude"]\n`, HOME), ConfigError);
  assert.throws(() => parseConfig(`${VALID}\n[cloud]\nexecutors = "claude"\n`, HOME), ConfigError);
});

test('a TOML syntax error says where, never the lines around it: they may hold values', () => {
  assert.throws(
    () => parseConfig(`${VALID}\n[database]\npassword = "s3cret" x\n`, HOME),
    (error: unknown) => error instanceof ConfigError && /invalid TOML at line \d+, column \d+$/.test(error.message) && !error.message.includes('s3cret'),
  );
});
