import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  CATALOG_FILE,
  DEFAULT_SETTINGS,
  EMPTY_CATALOG,
  loadConfig,
  parseCatalog,
  resolveHome,
  type Settings,
} from '@arianna/config';

import { currentSettings, installedExecutors, writeSettings } from '../src/init.ts';
import { selectedModels } from '../src/models.ts';
import { runWizard, type Prompter, type WizardContext } from '../src/wizard.ts';

const GIB = 2 ** 30;
const SHA = 'e'.repeat(64);
const CATALOG_TEXT = `version: 1
models:
  - id: large-mlx
    family: fake
    runtime: mlx
    ram_min_gib: 20
    roles: [orchestrator]
    status: verified
    files: [{ path: m.bin, url: "https://example.org/large", size_bytes: ${String(18 * GIB)}, sha256: ${SHA} }]
  - id: small-mlx
    family: fake
    runtime: mlx
    ram_min_gib: 6
    roles: [extractor, orchestrator]
    status: experimental
    files: [{ path: m.bin, url: "https://example.org/small", size_bytes: ${String(4 * GIB)}, sha256: ${SHA} }]
`;
const CATALOG = parseCatalog(CATALOG_TEXT);

const HOME = join(resolveHome({}), 'data', 'test-tmp', `wizard-${randomUUID()}`);

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/** Answers in order; every line said is kept. Running out of answers is a test error. */
function scripted(answers: string[]): Prompter & { said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    said,
    asked,
    say: (text) => said.push(text),
    ask: (question) => {
      asked.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`no answer left for: ${question}`);
      return Promise.resolve(answer);
    },
  };
}

function context(overrides: Partial<WizardContext> = {}): WizardContext {
  return {
    catalog: CATALOG,
    settings: DEFAULT_SETTINGS,
    home: HOME,
    freeBytes: 500 * GIB,
    ramBytes: 32 * GIB,
    installed: { claude: true, codex: false },
    ...overrides,
  };
}

test('defaults everywhere: the verified model for the orchestrator, oMLX added, nothing cloud, no Telegram', async () => {
  // Orchestrator, extractor, add oMLX, Claude, Codex, Telegram, write.
  const io = scripted(['', '', '', '', '', '', '']);
  const settings = await runWizard(io, context());
  assert.ok(settings !== undefined);
  assert.deepEqual(settings.roles, { orchestrator: 'large-mlx' });
  assert.deepEqual(settings.endpoints, [
    {
      id: 'omlx',
      url: 'http://127.0.0.1:8001/v1',
      command: ['omlx', 'serve', '--model-dir', 'data/models', '--host', '127.0.0.1', '--port', '8001'],
    },
  ]);
  assert.deepEqual(settings.cloud.executors, []);
  assert.equal(settings.telegram, undefined);
  // Step 4 only informs: autonomy is not a question.
  assert.ok(io.said.some((line) => line.includes('A1')));
  assert.ok(!io.asked.some((question) => /autonomia/i.test(question)));
});

test('choices: both roles, Claude and Codex with login hints, Telegram with chat ids', async () => {
  const io = scripted(['1', '1', 's', 's', 'si', 's', '123, 456', 's']);
  const settings = await runWizard(io, context());
  assert.ok(settings !== undefined);
  assert.deepEqual(settings.roles, { orchestrator: 'large-mlx', extractor: 'small-mlx' });
  assert.deepEqual(settings.cloud.executors, ['claude', 'codex']);
  assert.deepEqual(settings.telegram, { token: 'vault://telegram-bot-token', chats: [123, 456] });
  assert.ok(io.said.some((line) => line.includes('/login')));
  assert.ok(io.said.some((line) => line.includes('codex login')));
  assert.ok(io.said.some((line) => line.includes('pnpm vault:edit')));
  // The wizard never asks for a secret.
  assert.ok(!io.asked.some((question) => /token|password/i.test(question)));
});

test('wrong answers are asked again; models that do not fit RAM or disk are flagged', async () => {
  const io = scripted(['7', 'x', '1', '1', 'forse', 's', 'n', 'n', 's', '-3', 'abc', '42', 's']);
  const settings = await runWizard(io, context({ ramBytes: 16 * GIB, freeBytes: 10 * GIB }));
  assert.ok(settings !== undefined);
  assert.deepEqual(settings.telegram?.chats, [42]);
  assert.ok(io.said.some((line) => line.includes('Scrivi un numero fra 0 e 2')));
  assert.ok(io.said.some((line) => line.includes('Rispondi s oppure n')));
  assert.ok(io.said.some((line) => /26 GiB di RAM, la macchina ne ha 16/.test(line)));
  assert.ok(io.said.some((line) => /da scaricare 22\.0 GiB, liberi 10\.0 GiB/.test(line)));
});

test('reconfigure starts from the current values and can remove what was there', async () => {
  const current: Settings = {
    ...DEFAULT_SETTINGS,
    roles: { orchestrator: 'small-mlx', extractor: 'small-mlx' },
    endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:8001/v1' }],
    cloud: { allowlist: ['repos/site'], executors: ['claude'] },
    telegram: { token: 'vault://my-bot', chats: [7] },
  };
  // Enter keeps: orchestrator, extractor, Claude (on), Codex (off), Telegram (on), chats, write.
  const kept = await runWizard(scripted(['', '', '', '', '', '', '']), context({ settings: current }));
  assert.deepEqual(kept, current);
  // No model at all: the endpoint that takes its names from the roles goes too.
  const io = scripted(['0', '0', 'n', '', 'n', '']);
  const cleared = await runWizard(io, context({ settings: current }));
  assert.ok(cleared !== undefined);
  assert.deepEqual(cleared.roles, {});
  assert.deepEqual(cleared.endpoints, []);
  assert.deepEqual(cleared.cloud, { allowlist: ['repos/site'], executors: [] });
  assert.equal(cleared.telegram, undefined);
});

test('an empty catalog leaves the roles alone; declining the summary writes nothing', async () => {
  const io = scripted(['', '', '', 'n']);
  assert.equal(await runWizard(io, context({ catalog: EMPTY_CATALOG })), undefined);
  assert.ok(io.said.some((line) => line.includes('non ha ancora modelli')));
});

test('the written file loads, keeps what the wizard does not ask, and selects the models to download', async () => {
  mkdirSync(join(HOME, 'config'), { recursive: true });
  writeFileSync(join(HOME, CATALOG_FILE), CATALOG_TEXT);
  assert.equal(currentSettings(HOME, CATALOG), undefined);

  const settings = await runWizard(scripted(['2', '1', '', '', '', '', '']), context());
  assert.ok(settings !== undefined);
  writeSettings(HOME, CATALOG, { ...settings, cloud: { ...settings.cloud, allowlist: ['repos/site'] } });
  const config = loadConfig({ ARIANNA_HOME: HOME });
  assert.deepEqual(config.local.endpoints[0]?.models, { 'local-large': 'small-mlx', 'local-small': 'small-mlx' });
  assert.deepEqual(currentSettings(HOME, CATALOG)?.cloud.allowlist, ['repos/site']);
  assert.deepEqual(selectedModels(config, CATALOG).map((model) => model.id), ['small-mlx']);
  assert.ok(!existsSync(join(HOME, 'config', `.arianna.toml.${String(process.pid)}`)));
});

test('an invalid result is refused before anything is written', () => {
  const home = join(HOME, 'refused');
  mkdirSync(join(home, 'config'), { recursive: true });
  assert.throws(() => {
    writeSettings(home, EMPTY_CATALOG, { ...DEFAULT_SETTINGS, roles: { orchestrator: 'large-mlx' } });
  });
  assert.equal(currentSettings(home, EMPTY_CATALOG), undefined);
});

test('installed executors are looked up on PATH, never run', () => {
  const bin = join(HOME, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), '');
  assert.deepEqual(installedExecutors({ PATH: bin }), { claude: false, codex: true });
  assert.deepEqual(installedExecutors({}), { claude: false, codex: false });
});

