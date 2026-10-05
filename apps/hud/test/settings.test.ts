import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSettingsPath, SETTINGS_PATH } from '../src/lib/route.ts';
import {
  agentsBody,
  agentsForm,
  changeLines,
  charactersBody,
  chatId,
  cloudModelsBody,
  cloudModelsForm,
  commandText,
  copy,
  countdown,
  endpointsBody,
  endpointsForm,
  executorsBody,
  exitLines,
  keptSections,
  modelBlocker,
  pollAction,
  roleOptions,
  rolesBody,
  sameValue,
  sectionChanged,
  telegramBody,
  telegramForm,
  voiceBody,
  voiceForm,
  voiceProblem,
  writeError,
  type AgentsForm,
  type CatalogModel,
  type VoiceValues,
} from '../src/lib/settings.ts';

const DEFAULTS: VoiceValues = {
  port: 7421,
  voice: 'if_sara',
  limits: { callMinutes: 15, warnSeconds: 60, delegations: 6, delegationSeconds: 90 },
  outgoing: { maxPerDay: 3, quietFrom: '21:00', quietTo: '08:00', quietWeekend: true, ringSeconds: 30, waitingMinutes: 30 },
  push: null,
};

function model(id: string, roles: CatalogModel['roles'], present: boolean): CatalogModel {
  return { id, family: 'qwen', runtime: 'mlx', ramMinGib: 3, roles, status: 'experimental', present };
}

test('the settings page has its own address', () => {
  assert.equal(isSettingsPath(SETTINGS_PATH), true);
  assert.equal(isSettingsPath(`${SETTINGS_PATH}/`), true);
  // A section of the page (D-105) is the settings page too; a deeper path is not.
  assert.equal(isSettingsPath('/impostazioni/x'), true);
  assert.equal(isSettingsPath('/impostazioni/x/y'), false);
  assert.equal(isSettingsPath('/'), false);
});

test('a role offers only the catalog models made for it, those on disk first', () => {
  const catalog = [model('a', ['orchestrator'], false), model('b', ['extractor', 'voice'], true), model('c', ['orchestrator'], true)];
  assert.deepEqual(
    roleOptions(catalog, 'orchestrator').map((entry) => entry.id),
    ['c', 'a'],
  );
  assert.deepEqual(
    roleOptions(catalog, 'voice').map((entry) => entry.id),
    ['b'],
  );
  assert.deepEqual(roleOptions(catalog, 'embedder'), []);
});

test('a copy is deep, drops undefined fields, and goes through proxies like those of Vue', () => {
  const source = { a: { b: [1, 2] }, c: undefined };
  const proxy = new Proxy(source, {});
  const copied = copy(proxy);
  assert.deepEqual(copied, { a: { b: [1, 2] } });
  copied.a.b.push(3);
  assert.deepEqual(source.a.b, [1, 2]);
});

test('values compare by content, not by key order; undefined fields do not count', () => {
  assert.equal(sameValue({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 }), true);
  assert.equal(sameValue({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(sameValue({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(sameValue({ a: null }, { a: false }), false);
});

test('roles and characters leave out what is empty', () => {
  assert.deepEqual(rolesBody({ orchestrator: 'x', embedder: '', tts: 'y' }), { orchestrator: 'x', tts: 'y' });
  assert.deepEqual(charactersBody({ arianna: 'originals/fox', coder: '' }), { arianna: 'originals/fox' });
});

test('cloud models: on, off or an exact name, and back', () => {
  const form = cloudModelsForm({ models: { sonnet: true, opus: 'claude-opus-5-5', fable: false, codex: true } });
  assert.deepEqual(form.rows[1], { alias: 'opus', enabled: true, name: 'claude-opus-5-5' });
  assert.deepEqual(form.rows[2], { alias: 'fable', enabled: false, name: '' });
  assert.deepEqual(cloudModelsBody(form), { models: { sonnet: true, opus: 'claude-opus-5-5', fable: false, codex: true } });
  // A blank name is the alias; a name of a model turned off is dropped.
  const rows = form.rows.map((row) => (row.alias === 'sonnet' ? { ...row, name: '  ' } : row.alias === 'opus' ? { ...row, enabled: false } : row));
  assert.deepEqual(cloudModelsBody({ rows }).models, { sonnet: true, opus: false, fable: false, codex: true });
});

test("agents' models (D-116): every agent with a card, '' is the router, sent back as null", () => {
  const allowed = { arianna: [], coder: ['sonnet', 'opus', 'fable', 'codex'] } as const;
  const form: AgentsForm = agentsForm({ coder: { model: 'opus' }, gone: { model: 'sonnet' } }, { arianna: [], coder: [...allowed.coder] });
  assert.deepEqual(form, { arianna: '', coder: 'opus' }, 'an agent without a card is not in the form');
  assert.deepEqual(agentsBody(form), { arianna: { model: null }, coder: { model: 'opus' } });
  assert.deepEqual(agentsBody({ arianna: '', coder: '' }), { arianna: { model: null }, coder: { model: null } });
});

test('a model of an agent says why it would not start a conversation now', () => {
  const values = (models: Partial<Record<'sonnet' | 'opus' | 'fable' | 'codex', boolean | string>>, executors: string[]) => ({
    cloudModels: { models: { sonnet: true, opus: true, fable: true, codex: true, ...models } },
    executors,
  });
  assert.equal(modelBlocker('opus', values({}, ['claude'])), undefined);
  assert.equal(modelBlocker('opus', values({ opus: 'claude-opus-5-5' }, ['claude'])), undefined);
  assert.equal(modelBlocker('opus', values({ opus: false }, ['claude'])), 'spento in Modelli cloud');
  assert.equal(modelBlocker('opus', values({}, [])), 'esecutore spento');
  assert.equal(modelBlocker('codex', values({}, ['claude'])), 'esecutore spento');
  assert.equal(modelBlocker('codex', values({}, ['claude', 'codex'])), 'vale con il suo adattatore');
});

test('voice: off is null; turning it on starts from the defaults of the core', () => {
  const off = voiceForm(null, DEFAULTS);
  assert.equal(off.enabled, false);
  assert.equal(voiceBody(off), null);
  assert.deepEqual(voiceBody({ ...off, enabled: true }), DEFAULTS);
  const push = { publicKey: 'Bkey', subject: 'mailto:a@example.org' };
  const on = voiceForm({ ...DEFAULTS, voice: 'serena', push }, DEFAULTS);
  assert.deepEqual(voiceBody(on), { ...DEFAULTS, voice: 'serena', push });
  assert.deepEqual(voiceBody({ ...on, push: false })?.push, null);
  // The form is a copy: editing it leaves the defaults alone.
  on.values.limits.callMinutes = 99;
  assert.equal(DEFAULTS.limits.callMinutes, 15);
});

test('telegram: on with its chats, or off', () => {
  assert.deepEqual(telegramForm(null), { enabled: false, chats: [] });
  assert.deepEqual(telegramBody({ enabled: true, chats: [12, -100] }), { chats: [12, -100] });
  assert.equal(telegramBody({ enabled: false, chats: [12] }), null);
});

test('a chat id is an integer, negative for groups', () => {
  assert.equal(chatId(' 123456789 '), 123456789);
  assert.equal(chatId('-1001234'), -1001234);
  for (const text of ['', 'abc', '1.5', '12 34', '99999999999999999999', '1e5']) assert.equal(chatId(text), undefined, text);
});

test('local servers: the command is one argument per line, models kept as they are', () => {
  const endpoints = [
    { id: 'omlx', url: 'http://127.0.0.1:7001/v1', command: ['omlx', 'serve', '--model-dir', 'data/models'] },
    { id: 'other', url: 'http://127.0.0.1:7002/v1', models: { orchestrator: 'x' } },
  ];
  const form = endpointsForm(endpoints);
  assert.equal(form[0]?.command, 'omlx\nserve\n--model-dir\ndata/models');
  assert.deepEqual(endpointsBody(form), endpoints);
  // Blank lines and spaces around go; an empty command means "only watched".
  assert.deepEqual(endpointsBody([{ id: ' a ', url: ' u ', command: ' omlx \n\n serve ' }]), [{ id: 'a', url: 'u', command: ['omlx', 'serve'] }]);
  assert.deepEqual(endpointsBody([{ id: 'a', url: 'u', command: ' \n ' }]), [{ id: 'a', url: 'u' }]);
});

test('executors keep their usual order and only the known ones', () => {
  assert.deepEqual(executorsBody(['codex', 'claude']), ['claude', 'codex']);
  assert.deepEqual(executorsBody(['other']), []);
});

test('the card lists what changes, section by section', () => {
  const lines = changeLines({
    executors: { before: ['claude', 'codex'], after: ['claude'] },
    telegram: { before: { chats: [1] }, after: { chats: [1, 2] } },
    projects: {
      added: [{ name: 'site', path: '~/site', label: 'L1' }],
      removed: [],
      changed: [{ name: 'demo', before: { name: 'demo', path: 'repos/demo', label: 'L1' }, after: { name: 'demo', path: 'repos/demo', label: 'L0' } }],
    },
    endpoints: {
      added: [],
      removed: [],
      changed: [{ id: 'omlx', before: { id: 'omlx', url: 'u', command: ['omlx'] }, after: { id: 'omlx', url: 'u' } }],
    },
  });
  assert.deepEqual(lines, [
    { kind: 'remove', text: 'Esecutore Codex spento' },
    { kind: 'add', text: 'Chat di Telegram 2' },
    { kind: 'add', text: 'Progetto site (L1, ~/site)' },
    { kind: 'change', text: 'Progetto demo (L1, repos/demo) → L0, repos/demo' },
    { kind: 'change', text: 'Server omlx: senza comando: il nucleo lo osserva soltanto' },
  ]);
  assert.deepEqual(changeLines({ telegram: { before: null, after: { chats: [1] } } }), [{ kind: 'add', text: 'Telegram acceso (1 chat)' }]);
  assert.deepEqual(changeLines({ telegram: { before: { chats: [1] }, after: null } }), [{ kind: 'remove', text: 'Telegram spento' }]);
  assert.equal(changeLines({}).length, 1);
});

test('the card lists every exit after the change, not only the changed ones', () => {
  const lines = exitLines({
    executors: ['claude'],
    projects: [{ name: 'demo', label: 'L1' }],
    telegram: { chats: 2 },
    endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:7001/v1', command: ['omlx', 'serve'] }],
  });
  assert.deepEqual(lines, [
    'Claude Code potrà ricevere testi L0-L1 dal gateway e lavorare in: demo (L1).',
    'Telegram: 2 chat, al massimo L1.',
    'omlx (http://127.0.0.1:7001/v1) vede i dati L2 in chiaro; il nucleo esegue: omlx serve',
  ]);
  assert.deepEqual(exitLines({ executors: [], projects: [], telegram: null, endpoints: [{ id: 'x', url: 'u', command: null }] }), [
    'Nessun esecutore cloud: niente esce verso Claude Code o Codex.',
    'Telegram spento.',
    'x (u) vede i dati L2 in chiaro.',
  ]);
});

test('the countdown of a confirmation stops at zero', () => {
  const at = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(countdown('2026-10-04T12:05:00Z', at), '5:00');
  assert.equal(countdown('2026-10-04T12:00:09.2Z', at), '0:10');
  assert.equal(countdown('2026-10-04T11:59:00Z', at), '0:00');
});

test('a 409 reloads the values; an expired confirmation does not', () => {
  assert.equal(writeError(409, 'arianna.toml changed since the page read it: reload').reload, true);
  assert.equal(writeError(410, 'expired').reload, false);
  assert.match(writeError(404, 'unknown').text, /scaduta/);
  assert.match(writeError(400, 'roles: bad').text, /roles: bad/);
  assert.equal(writeError(400, 'x').reload, false);
});

test('a command shows where each argument ends', () => {
  assert.equal(commandText(['omlx', 'serve', '--port', '7001']), 'omlx serve --port 7001');
  assert.equal(commandText(['sh -c x']), '"sh -c x"');
  assert.notEqual(commandText(['sh -c x']), commandText(['sh', '-c', 'x']));
  assert.equal(commandText(['a', '', ' b']), 'a "" " b"');
});

test('servers added and removed, and the model names of a server, are listed with their values', () => {
  const lines = changeLines({
    endpoints: {
      added: [{ id: 'new', url: 'http://127.0.0.1:7002/v1', command: ['omlx', 'serve'] }],
      removed: [{ id: 'old', url: 'http://127.0.0.1:7003/v1' }],
      changed: [{ id: 'omlx', before: { id: 'omlx', url: 'u' }, after: { id: 'omlx', url: 'u', models: { orchestrator: 'big' } } }],
    },
    projects: { added: [], removed: [{ name: 'demo', path: 'repos/demo', label: 'L1' }], changed: [] },
  });
  assert.deepEqual(lines, [
    { kind: 'remove', text: 'Progetto demo (L1, repos/demo)' },
    { kind: 'add', text: 'Server new (http://127.0.0.1:7002/v1, comando: omlx serve)' },
    { kind: 'remove', text: 'Server old (http://127.0.0.1:7003/v1, solo osservato)' },
    { kind: 'change', text: 'Server omlx: nomi dei modelli: orchestrator = big' },
  ]);
});

test('a change the server sees but nothing lists still says so on the card', () => {
  assert.deepEqual(changeLines({ executors: { before: ['codex', 'claude'], after: ['claude', 'codex'] } }), [
    { kind: 'change', text: 'Cambia solo l’ordine o la forma nel file: le uscite restano le stesse.' },
  ]);
});

test('executors and chats are sets: their order alone is not a change', () => {
  assert.equal(sectionChanged('executors', ['claude', 'codex'], ['codex', 'claude']), false);
  assert.equal(sectionChanged('executors', ['claude'], ['codex', 'claude']), true);
  assert.equal(sectionChanged('telegram', { enabled: true, chats: [2, 1] }, { enabled: true, chats: [1, 2] }), false);
  assert.equal(sectionChanged('telegram', { enabled: false, chats: [1, 2] }, { enabled: true, chats: [1, 2] }), true);
  assert.equal(sectionChanged('projects', [], [{ name: 'a', path: 'p', label: 'L1' }]), true);
});

test('a command left as it was keeps its exact arguments; an edited one is read again', () => {
  const before = [{ id: 'omlx', url: 'u', command: ['omlx', ' spaced ', ''] }];
  const [form] = endpointsForm(before);
  assert.ok(form !== undefined);
  assert.deepEqual(endpointsBody([{ ...form, url: 'v' }], before), [{ id: 'omlx', url: 'v', command: ['omlx', ' spaced ', ''] }]);
  assert.deepEqual(endpointsBody([{ ...form, command: 'omlx\nserve' }], before), [{ id: 'omlx', url: 'u', command: ['omlx', 'serve'] }]);
});

test('a poll drops what is older than the page and never overwrites edits', () => {
  const base = { started: 3, generation: 3, fingerprint: 'b', seen: 'a', open: false, busy: false, dirty: false };
  assert.equal(pollAction(base), 'apply');
  assert.equal(pollAction({ ...base, dirty: true }), 'stale');
  assert.equal(pollAction({ ...base, fingerprint: 'a' }), 'ignore');
  // Started before a save or a confirmation: its fingerprint is the old file's.
  assert.equal(pollAction({ ...base, generation: 4 }), 'ignore');
  assert.equal(pollAction({ ...base, open: true }), 'ignore');
  assert.equal(pollAction({ ...base, busy: true }), 'ignore');
});

test('only the sections asked for and changed keep their edits', () => {
  const changed = (section: string): boolean => section === 'voice' || section === 'projects';
  assert.deepEqual(keptSections(['roles', 'voice', 'projects'], changed), ['voice', 'projects']);
  assert.deepEqual(keptSections([], changed), []);
});

test('the voice card is not saved with an empty number or half a push setting', () => {
  const form = voiceForm(DEFAULTS, DEFAULTS);
  assert.equal(voiceProblem(form), undefined);
  assert.equal(voiceProblem({ ...form, enabled: false, values: { ...form.values, port: '' as unknown as number } }), undefined);
  assert.match(voiceProblem({ ...form, values: { ...form.values, port: '' as unknown as number } }) ?? '', /numero/);
  assert.match(voiceProblem({ ...form, values: { ...form.values, limits: { ...form.values.limits, callMinutes: 1.5 } } }) ?? '', /numero/);
  assert.match(voiceProblem({ ...form, push: true, publicKey: 'B', subject: ' ' }) ?? '', /push/);
});

test('a 409 for a file that cannot be read says so, and still reloads', () => {
  const unreadable = writeError(409, 'voice.port: expected an integer');
  assert.equal(unreadable.reload, true);
  assert.match(unreadable.text, /non si leggono: voice.port/);
  assert.match(writeError(409, 'arianna.toml changed since the page read it: reload').text, /è cambiato/);
});
