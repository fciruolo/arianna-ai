// The settings page of the web chat (D-071): read with the fingerprint, the
// ordinary changes written at once, the privacy ones only after a
// confirmation bound to the exact change.
import assert from 'node:assert/strict';
import { createECDH, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import {
  CATALOG_FILE,
  CONFIG_FILE,
  DATA_DIR,
  DEFAULT_SETTINGS,
  DEFAULT_VOICE,
  LABELS_FILE,
  loadCatalog,
  parseConfig,
  renderSettings,
  resolveHome,
  settingsFingerprint,
  type Settings,
} from '@arianna/config';

import { changedSections, createSettingsPage, SettingsError, type SettingsChange, type SettingsPage } from '../src/settings-page.ts';

const REPO = resolveHome({});
const root = join(REPO, DATA_DIR, 'test-tmp', randomUUID());
const home = join(root, 'home');
const userHome = join(root, 'user');
const file = join(home, CONFIG_FILE);

/** A VAPID public key: an uncompressed P-256 point, base64url. */
function publicKey(): string {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString('base64url');
}
const [PUB, NEW_PUB] = [publicKey(), publicKey()];

const START: Settings = {
  ...DEFAULT_SETTINGS,
  roles: { orchestrator: 'qwen3.8-27b-4bit', voice: 'qwen3-4b-instruct-2507-4bit' },
  endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:7001/v1', command: ['omlx', 'serve', '--port', '7001'] }],
  cloud: { executors: ['claude'] },
  projects: [{ name: 'demo', path: 'repos/demo', label: 'L1' }],
  telegram: { token: 'vault://my-bot', chats: [123] },
  voice: { ...structuredClone(DEFAULT_VOICE), push: { publicKey: PUB, privateKey: 'vault://my-vapid', subject: 'mailto:a@example.org' } },
};

let page: SettingsPage;
let changes: SettingsChange[];
let clock: number;

function running() {
  return parseConfig(renderSettings(START), home, loadCatalog(home), userHome);
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(home, 'config'), { recursive: true });
  mkdirSync(userHome, { recursive: true });
  copyFileSync(join(REPO, CATALOG_FILE), join(home, CATALOG_FILE));
  writeFileSync(join(home, LABELS_FILE), '[[folder]]\npath = "kb/private"\nlabel = "L2"\n');
  writeFileSync(file, renderSettings(START));
  changes = [];
  clock = Date.parse('2026-10-04T12:00:00Z');
  const config = running();
  page = createSettingsPage({ home, userHome, dataDir: join(home, DATA_DIR), running: () => config, onChanged: (change) => changes.push(change), now: () => clock });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const text = (): string => readFileSync(file, 'utf8');
const fingerprint = (): string => settingsFingerprint(text());

function refused(code: SettingsError['code'], pattern?: RegExp): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof SettingsError, String(error));
    assert.equal(error.code, code, error.message);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return true;
  };
}

describe('read', () => {
  it('values with the fingerprint of the file, never a vault reference, the database or the server', () => {
    const view = page.read();
    assert.equal(view.fingerprint, fingerprint());
    assert.equal(view.error, null);
    assert.deepEqual(view.values?.executors, ['claude']);
    assert.deepEqual(view.values.telegram, { chats: [123] });
    assert.deepEqual(view.values.voice?.push, { publicKey: PUB, subject: 'mailto:a@example.org' });
    assert.deepEqual(view.values.cloudModels, { models: { sonnet: true, opus: true, fable: true, codex: true }, default: null });
    const shown = JSON.stringify(view.values);
    for (const hidden of ['vault://', 'database', '54329', '7420']) assert.ok(!shown.includes(hidden), hidden);
    assert.deepEqual(view.restartOnly, ['paths', 'database', 'server']);
    assert.deepEqual(view.restartPending, []);
    assert.match(view.labels ?? '', /kb\/private/);
    const orchestrator = view.catalog.find((model) => model.id === 'qwen3.8-27b-4bit');
    assert.deepEqual([orchestrator?.roles, orchestrator?.present], [['orchestrator'], false]);
  });

  it('a change of [server] by hand waits for a restart', () => {
    writeFileSync(file, renderSettings({ ...START, server: { host: '127.0.0.1', port: 7499 } }));
    assert.deepEqual(page.read().restartPending, ['server']);
  });

  it('an unreadable catalog: 409 with its rule, and a confirmation is not written', () => {
    const proposal = page.prepare({ fingerprint: fingerprint(), values: { executors: [] } });
    writeFileSync(join(home, CATALOG_FILE), 'version: 2\n');
    assert.throws(() => page.read(), refused('unreadable', /catalog/));
    assert.throws(() => page.confirm({ id: proposal.id }), refused('unreadable', /catalog/));
    assert.equal(text(), renderSettings(START));
  });

  it('a TOML syntax error never shows the values around it', () => {
    writeFileSync(file, `${text()}\n[telegram]\ntoken = "vault://kept-secret" x\n`);
    const view = page.read();
    assert.match(view.error ?? '', /invalid TOML at line/);
    assert.ok(!(view.error ?? '').includes('kept-secret'));
    assert.throws(() => page.update({ fingerprint: fingerprint(), values: { roles: {} } }), (error: unknown) => error instanceof SettingsError && error.code === 'unreadable' && !error.message.includes('kept-secret'));
  });

  it('changedSections sees every section, privacy ones included', () => {
    const next = structuredClone(START);
    next.cloud.executors = ['claude', 'codex'];
    next.server = { host: '127.0.0.1', port: 7499 };
    assert.deepEqual(changedSections(START, next), ['executors', 'server']);
  });

  it('an invalid file: no values, the rule that failed', () => {
    writeFileSync(file, `${text()}\n[nonsense]\n`);
    const view = page.read();
    assert.equal(view.values, null);
    assert.match(view.error ?? '', /nonsense/);
    assert.equal(view.fingerprint, fingerprint());
  });
});

describe('update (ordinary)', () => {
  it('writes the roles at once, reports the section, keeps the rest of the file', () => {
    const before = page.read();
    const view = page.update({ fingerprint: before.fingerprint, values: { roles: { orchestrator: 'qwen3.5-9b-mlx-4bit', voice: 'qwen3-4b-instruct-2507-4bit' } } });
    assert.equal(view.values?.roles.orchestrator, 'qwen3.5-9b-mlx-4bit');
    assert.notEqual(view.fingerprint, before.fingerprint);
    assert.equal(view.fingerprint, fingerprint());
    assert.deepEqual(changes, [{ sections: ['roles'], privacy: false }]);
    assert.equal(text(), renderSettings({ ...START, roles: { orchestrator: 'qwen3.5-9b-mlx-4bit', voice: 'qwen3-4b-instruct-2507-4bit' } }));
  });

  it('cloud models, characters and [voice]; the vault reference of the push key is kept', () => {
    const voice = { ...structuredClone(DEFAULT_VOICE), port: 7431, push: { publicKey: NEW_PUB, subject: 'mailto:b@example.org' } };
    page.update({
      fingerprint: fingerprint(),
      values: { cloudModels: { models: { sonnet: true, opus: 'claude-opus-5-5', fable: false, codex: true }, default: 'opus' }, characters: { arianna: 'originali/arianna' }, voice },
    });
    assert.deepEqual(changes, [{ sections: ['cloudModels', 'characters', 'voice'], privacy: false }]);
    const config = parseConfig(text(), home, loadCatalog(home), userHome);
    assert.deepEqual(config.cloud.models.opus, { enabled: true, name: 'claude-opus-5-5' });
    assert.equal(config.cloud.models.fable.enabled, false);
    assert.equal(config.cloud.defaultModel, 'opus');
    assert.equal(config.voice?.port, 7431);
    assert.deepEqual(config.voice.push, { publicKey: NEW_PUB, privateKey: 'vault://my-vapid', subject: 'mailto:b@example.org' });
    assert.deepEqual(config.cloud.executors, ['claude']);
  });

  it('[voice] off with null', () => {
    page.update({ fingerprint: fingerprint(), values: { voice: null } });
    assert.equal(parseConfig(text(), home, loadCatalog(home), userHome).voice, undefined);
  });

  it('the same values: nothing written, no event', () => {
    const before = text();
    page.update({ fingerprint: fingerprint(), values: { roles: START.roles } });
    assert.equal(text(), before);
    assert.deepEqual(changes, []);
  });

  it('refuses a file changed since the page read it, and leaves it alone', () => {
    const old = fingerprint();
    writeFileSync(file, `${text()}# by hand\n`);
    const before = text();
    assert.throws(() => page.update({ fingerprint: old, values: { roles: {} } }), refused('changed'));
    assert.equal(text(), before);
    assert.deepEqual(changes, []);
  });

  it('refuses a missing or malformed fingerprint', () => {
    assert.throws(() => page.update({ values: { roles: {} } }), refused('invalid', /fingerprint/));
    assert.throws(() => page.update({ fingerprint: 'abc', values: { roles: {} } }), refused('invalid', /fingerprint/));
  });

  it('refuses a privacy section: it takes the confirmation', () => {
    for (const values of [{ executors: ['claude', 'codex'] }, { telegram: null }, { projects: [] }, { endpoints: [] }]) {
      assert.throws(() => page.update({ fingerprint: fingerprint(), values }), refused('invalid', /unknown field/));
    }
    assert.deepEqual(changes, []);
  });

  it('refuses shapes that are not the expected ones, before anything is rendered', () => {
    const cases: Record<string, unknown>[] = [
      { roles: { orchestrator: 7 } },
      { roles: { painter: 'x' } },
      { cloudModels: { models: { sonnet: 1 }, default: null } },
      { cloudModels: { models: {}, default: 'gpt' } },
      // A key written unquoted in TOML: never a way into another section.
      { characters: { 'a = "x"\n[cloud]\nexecutors = ["codex"]\n#': 'originali/arianna' } },
      { voice: { ...DEFAULT_VOICE, port: '7421\n[telegram]' } },
      { voice: { ...DEFAULT_VOICE, port: 7421.5 } },
      JSON.parse('{ "roles": { "__proto__": "qwen3.8-27b-4bit" } }') as Record<string, unknown>,
      { voice: { ...DEFAULT_VOICE, push: { publicKey: PUB, subject: 'mailto:x@example.org', privateKey: 'vault://other' } } },
    ];
    for (const values of cases) assert.throws(() => page.update({ fingerprint: fingerprint(), values }), refused('invalid'), JSON.stringify(values));
    assert.equal(text(), renderSettings(START));
  });

  it('refuses what the core would refuse, with its rule, and writes nothing', () => {
    assert.throws(() => page.update({ fingerprint: fingerprint(), values: { roles: { orchestrator: 'no-such-model' } } }), refused('invalid', /roles/));
    assert.throws(
      () => page.update({ fingerprint: fingerprint(), values: { cloudModels: { models: { sonnet: 'claude-fable-5-1' }, default: null } } }),
      refused('invalid', /sonnet/),
    );
    assert.equal(text(), renderSettings(START));
  });

  it('refuses an empty change or unknown fields', () => {
    assert.throws(() => page.update({ fingerprint: fingerprint(), values: {} }), refused('invalid', /nothing/));
    assert.throws(() => page.update({ fingerprint: fingerprint(), values: { roles: {} }, extra: 1 }), refused('invalid', /extra/));
  });
});

describe('prepare and confirm (privacy)', () => {
  it('prepare writes nothing and says what changes and what may leave; confirm writes it once', () => {
    const before = text();
    const proposal = page.prepare({ fingerprint: fingerprint(), values: { executors: ['claude', 'codex'] } });
    assert.equal(text(), before);
    assert.deepEqual(changes, []);
    assert.deepEqual(proposal.sections, ['executors']);
    assert.deepEqual(proposal.changes, { executors: { before: ['claude'], after: ['claude', 'codex'] } });
    assert.deepEqual(proposal.exits.executors, ['claude', 'codex']);
    assert.deepEqual(proposal.exits.projects, [{ name: 'demo', label: 'L1' }]);
    assert.deepEqual(proposal.exits.telegram, { chats: 1 });
    assert.equal(proposal.expiresAt, new Date(clock + 5 * 60_000).toISOString());

    const view = page.confirm({ id: proposal.id });
    assert.deepEqual(view.values?.executors, ['claude', 'codex']);
    assert.deepEqual(changes, [{ sections: ['executors'], privacy: true, confirmation: proposal.id }]);
    assert.throws(() => page.confirm({ id: proposal.id }), refused('unknown'));
    assert.equal(changes.length, 1);
  });

  it('Telegram: the token reference is kept, null turns it off, a new one gets the usual reference', () => {
    page.confirm({ id: page.prepare({ fingerprint: fingerprint(), values: { telegram: { chats: [123, 456] } } }).id });
    assert.deepEqual(parseConfig(text(), home, loadCatalog(home), userHome).telegram, { token: 'vault://my-bot', chats: [123, 456] });
    page.confirm({ id: page.prepare({ fingerprint: fingerprint(), values: { telegram: null } }).id });
    assert.equal(parseConfig(text(), home, loadCatalog(home), userHome).telegram, undefined);
    const proposal = page.prepare({ fingerprint: fingerprint(), values: { telegram: { chats: [9] } } });
    assert.deepEqual(proposal.changes.telegram, { before: null, after: { chats: [9] } });
    page.confirm({ id: proposal.id });
    assert.equal(parseConfig(text(), home, loadCatalog(home), userHome).telegram?.token, 'vault://telegram-bot-token');
  });

  it('projects and local servers: added, removed and changed', () => {
    const proposal = page.prepare({
      fingerprint: fingerprint(),
      values: {
        projects: [{ name: 'demo', path: 'repos/demo', label: 'L0' }, { name: 'site', path: '~/code/site', label: 'L1' }],
        endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:7002/v1', command: ['omlx', 'serve', '--port', '7002'] }, { id: 'spare', url: 'http://127.0.0.1:7003/v1' }],
      },
    });
    assert.deepEqual(proposal.sections, ['projects', 'endpoints']);
    assert.deepEqual(proposal.changes.projects, {
      added: [{ name: 'site', path: '~/code/site', label: 'L1' }],
      removed: [],
      changed: [{ name: 'demo', before: { name: 'demo', path: 'repos/demo', label: 'L1' }, after: { name: 'demo', path: 'repos/demo', label: 'L0' } }],
    });
    assert.deepEqual(proposal.changes.endpoints?.added, [{ id: 'spare', url: 'http://127.0.0.1:7003/v1' }]);
    assert.deepEqual(proposal.changes.endpoints.changed.map(({ id }) => id), ['omlx']);
    assert.deepEqual(proposal.exits.endpoints, [
      { id: 'omlx', url: 'http://127.0.0.1:7002/v1', command: ['omlx', 'serve', '--port', '7002'] },
      { id: 'spare', url: 'http://127.0.0.1:7003/v1', command: null },
    ]);
    page.confirm({ id: proposal.id });
    const config = parseConfig(text(), home, loadCatalog(home), userHome);
    assert.deepEqual(config.projects.map(({ name, label }) => [name, label]), [['demo', 'L0'], ['site', 'L1']]);
    assert.deepEqual(config.local.endpoints.map(({ id }) => id), ['omlx', 'spare']);
  });

  it('an expired confirmation writes nothing and cannot be used again', () => {
    const before = text();
    const proposal = page.prepare({ fingerprint: fingerprint(), values: { executors: [] } });
    clock += 5 * 60_000;
    assert.throws(() => page.confirm({ id: proposal.id }), refused('expired'));
    assert.throws(() => page.confirm({ id: proposal.id }), refused('unknown'));
    assert.equal(text(), before);
    assert.deepEqual(changes, []);
  });

  it('a file changed between prepare and confirm: refused, and the id is spent', () => {
    const proposal = page.prepare({ fingerprint: fingerprint(), values: { executors: [] } });
    writeFileSync(file, `${text()}# by hand\n`);
    const before = text();
    assert.throws(() => page.confirm({ id: proposal.id }), refused('changed'));
    assert.equal(text(), before);
    assert.throws(() => page.confirm({ id: proposal.id }), refused('unknown'));
  });

  it('at most 20 confirmations wait: past them the oldest goes', () => {
    const read = fingerprint();
    const first = page.prepare({ fingerprint: read, values: { executors: [] } });
    for (let index = 0; index < 20; index += 1) page.prepare({ fingerprint: read, values: { executors: [] } });
    assert.throws(() => page.confirm({ id: first.id }), refused('unknown'));
  });

  it('a second confirmation prepared on the same file is refused once the first is written', () => {
    const read = fingerprint();
    const first = page.prepare({ fingerprint: read, values: { executors: [] } });
    const second = page.prepare({ fingerprint: read, values: { executors: ['claude', 'codex'] } });
    page.confirm({ id: first.id });
    assert.throws(() => page.confirm({ id: second.id }), refused('changed'));
    assert.deepEqual(parseConfig(text(), home, loadCatalog(home), userHome).cloud.executors, []);
  });

  it('refuses an ordinary section, an unknown id, no change, and what the core would refuse', () => {
    assert.throws(() => page.prepare({ fingerprint: fingerprint(), values: { roles: {} } }), refused('invalid', /unknown field/));
    assert.throws(() => page.confirm({ id: randomUUID() }), refused('unknown'));
    assert.throws(() => page.confirm({ id: 7 }), refused('invalid'));
    assert.throws(() => page.prepare({ fingerprint: fingerprint(), values: { executors: ['claude'] } }), refused('invalid', /nothing changes/));
    assert.throws(() => page.prepare({ fingerprint: fingerprint(), values: { executors: ['gemini'] } }), refused('invalid'));
    assert.throws(() => page.prepare({ fingerprint: fingerprint(), values: { projects: [{ name: 'x', path: 'repos/x', label: 'L2' }] } }), refused('invalid', /L0 or L1/));
    assert.throws(() => page.prepare({ fingerprint: fingerprint(), values: { projects: [{ name: 'x', path: '/etc', label: 'L1' }] } }), refused('invalid', /project/));
    assert.throws(() => page.prepare({ fingerprint: fingerprint(), values: { endpoints: [{ id: 'far', url: 'http://example.org/v1' }] } }), refused('invalid'));
    assert.throws(() => page.prepare({ fingerprint: fingerprint(), values: { telegram: { chats: ['123'] } } }), refused('invalid'));
    assert.equal(text(), renderSettings(START));
  });
});
