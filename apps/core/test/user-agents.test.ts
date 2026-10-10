import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, describe, it } from 'node:test';

import { loadAgent, promptLabelOf, type LoadedAgent, type NewUserAgent, type UserPermissions } from '@arianna/agents';
import { Secret } from '@arianna/vault';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

import { createUserAgents, UserAgentError, type UserAgentEdit } from '../src/user-agents.ts';

const root = mkdtempSync(join(tmpdir(), 'arianna-user-agents-core-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const coder = loadAgent(fileURLToPath(new URL('../../../agents', import.meta.url)), 'coder');
const answer: UserPermissions = { executor: 'local', tools: [], autonomy: 'A0', maxSteps: 10, maxMinutes: 10 };
const coding: UserPermissions = { executor: 'claude', tools: ['repo.read', 'repo.write', 'repo.test'], autonomy: 'A1', maxSteps: 50, maxMinutes: 45 };
const input = { name: 'traduttore', description: 'Translates the release notes', prompt: 'You translate text into Italian.', permissions: answer };

let home: string;
let agents: Map<string, LoadedAgent>;
let service: ReturnType<typeof createUserAgents>;
let clock: number;

beforeEach(() => {
  home = mkdtempSync(join(root, 'home-'));
  mkdirSync(join(home, 'agents'));
  agents = new Map([['coder', coder]]);
  clock = 1_000_000;
  service = createUserAgents({ home, dataDir: join(home, 'data'), agents, official: new Set(['coder']), now: () => clock });
});

/** A new agent as the page makes it: prepared, shown, then created with the confirmation (tappa T3b). */
function make(agent: NewUserAgent = input) {
  return service.create({ ...agent, confirmation: service.prepareCreate(agent).confirmation });
}

/** An edit as the page sends it: prepared, then confirmed only when something of the permissions changes. */
function change(name: string, edit: UserAgentEdit) {
  const { confirmation } = service.prepareEdit(name, edit);
  return service.update(name, { ...edit, ...(confirmation === null ? {} : { confirmation }) });
}

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UserAgentError) return error.code;
    throw error;
  }
  return 'ok';
}

describe('user agents', () => {
  it('a new agent is disabled and not running', () => {
    const created = make();
    assert.equal(created.state, 'disabled');
    // Its prompt is the user's own (L1): an answering agent of the page reads up to L1 (tappa T3).
    assert.equal(created.card.maxLabel, 'L1');
    assert.ok(existsSync(join(home, 'data', 'agents', 'disattivati', 'traduttore.yaml')));
    assert.equal(agents.has('traduttore'), false);
  });

  it('activate and deactivate change the running agents at once', () => {
    make();
    assert.equal(service.activate('traduttore').state, 'active');
    assert.ok(agents.has('traduttore'));
    assert.ok(existsSync(join(home, 'data', 'agents', 'attivi', 'traduttore.md')));
    assert.equal(service.deactivate('traduttore').state, 'disabled');
    assert.equal(agents.has('traduttore'), false);
    assert.deepEqual(
      service.list().user.map(({ name, state }) => [name, state]),
      [['traduttore', 'disabled']],
    );
  });

  it('load adds the active cards at start', () => {
    make();
    service.activate('traduttore');
    const fresh = new Map([['coder', coder]]);
    const again = createUserAgents({ home, dataDir: join(home, 'data'), agents: fresh, official: new Set(['coder']) });
    assert.deepEqual(again.load(), []);
    assert.ok(fresh.has('traduttore'));
  });

  it('refuses names already taken, unknown agents and bad input', () => {
    make();
    assert.equal(code(() => make()), 'conflict');
    assert.equal(code(() => make({ ...input, name: 'coder' })), 'conflict');
    assert.equal(code(() => service.activate('nessuno')), 'not-found');
    assert.equal(code(() => service.activate('../coder')), 'not-found');
    assert.equal(code(() => make({ ...input, name: 'altro', permissions: { ...answer, executor: 'codex' } })), 'invalid');
    assert.equal(code(() => make({ ...input, name: 'altro', permissions: { ...answer, tools: ['repo.read'] } })), 'invalid');
  });

  it('refuses a prompt with personal data or a secret, without repeating it', () => {
    let message = '';
    try {
      make({ ...input, prompt: 'Pay to IT60X0542811101000000123456 every month.' });
    } catch (error) {
      assert.ok(error instanceof UserAgentError);
      message = error.message;
    }
    assert.match(message, /^the prompt looks like personal data/);
    assert.doesNotMatch(message, /IT60/);
    assert.equal(service.list().user.length, 0);
  });

  it('promotion needs the confirmation and moves the card into agents/', () => {
    make();
    assert.equal(code(() => service.promote('traduttore', 'yes')), 'invalid');
    assert.equal(agents.has('traduttore'), false);
    const promoted = service.promote('traduttore', true);
    assert.equal(promoted.state, 'official');
    assert.ok(existsSync(join(home, 'agents', 'traduttore.yaml')));
    assert.ok(existsSync(join(home, 'agents', 'traduttore.md')));
    assert.equal(existsSync(join(home, 'data', 'agents', 'disattivati', 'traduttore.yaml')), false);
    assert.ok(agents.has('traduttore'));
    assert.deepEqual(
      service.list().official.map(({ name }) => name),
      ['coder', 'traduttore'],
    );
    // An official name is taken from now on.
    assert.equal(code(() => make()), 'conflict');
  });

  it('never promotes over a card of agents/', () => {
    make();
    writeFileSync(join(home, 'agents', 'traduttore.md'), 'x');
    assert.equal(code(() => service.promote('traduttore', true)), 'conflict');
    assert.ok(existsSync(join(home, 'data', 'agents', 'disattivati', 'traduttore.yaml')));
  });

  it('offers the starting points and the list of permissions (tappa T3b)', () => {
    const sources = service.sources();
    assert.deepEqual(
      sources.presets.map(({ id }) => id),
      ['code', 'answer'],
    );
    assert.deepEqual(sources.allowed.executors, ['local', 'claude']);
    assert.deepEqual(sources.allowed.tools, { local: [], claude: ['repo.read', 'repo.write', 'repo.test'] });
    assert.deepEqual(sources.allowed.limits, { maxSteps: 50, maxMinutes: 45 });
    assert.deepEqual(sources.claudeTools['repo.read'], ['Read', 'Glob', 'Grep']);
  });
});

describe('user agents, more cases', () => {
  const disabled = (name: string): string => join(home, 'data', 'agents', 'disattivati', name);
  const active = (name: string): string => join(home, 'data', 'agents', 'attivi', name);

  it('refuses a vault value and personal data in the description or the name', () => {
    new Secret('vault://test/user-agent', 'segreto-del-vault-1234');
    assert.equal(code(() => make({ ...input, prompt: 'Use segreto-del-vault-1234 to log in.' })), 'invalid');
    assert.equal(code(() => make({ ...input, description: 'Mario, IBAN IT60X0542811101000000123456' })), 'invalid');
    assert.equal(code(() => make({ ...input, name: 'rssmra80a01h501u' })), 'invalid');
    assert.equal(service.list().user.length, 0);
  });

  it('a card edited by hand beyond the list is refused, also at start', () => {
    make();
    service.activate('traduttore');
    const yaml = readFileSync(active('traduttore.yaml'), 'utf8').replace('tools: []', 'tools: [kb.search]');
    writeFileSync(active('traduttore.yaml'), yaml);
    const fresh = new Map([['coder', coder]]);
    const again = createUserAgents({ home, dataDir: join(home, 'data'), agents: fresh, official: new Set(['coder']) });
    assert.deepEqual(again.load().map(({ name }) => name), ['traduttore']);
    assert.equal(fresh.has('traduttore'), false);
    assert.match(again.list().refused[0]?.reason ?? '', /kb\.search not allowed/);
  });

  it('a prompt that is a symbolic link is refused', () => {
    make();
    rmSync(disabled('traduttore.md'));
    writeFileSync(join(home, 'fuori.md'), 'x');
    symlinkSync(join(home, 'fuori.md'), disabled('traduttore.md'));
    assert.equal(code(() => service.activate('traduttore')), 'not-found');
    assert.match(service.list().refused[0]?.reason ?? '', /not a regular file/);
  });

  it('marks the prompt of a user agent as the user\'s', () => {
    make();
    service.activate('traduttore');
    assert.equal(agents.get('traduttore')?.origin, 'user');
    service.promote('traduttore', true);
    assert.equal(agents.get('traduttore')?.origin, undefined);
  });

  it('repeated and unknown actions', () => {
    assert.equal(code(() => service.deactivate('nessuno')), 'not-found');
    make();
    service.activate('traduttore');
    assert.equal(service.activate('traduttore').state, 'active');
    assert.equal(service.promote('traduttore', true).state, 'official');
    assert.equal(code(() => service.deactivate('traduttore')), 'not-found');
  });

  it('the same name in both folders shows once, the copy as refused', () => {
    make();
    service.activate('traduttore');
    mkdirSync(join(home, 'data', 'agents', 'disattivati'), { recursive: true });
    writeFileSync(disabled('traduttore.yaml'), readFileSync(active('traduttore.yaml')));
    writeFileSync(disabled('traduttore.md'), 'x');
    const listing = service.list();
    assert.deepEqual(listing.user.map(({ state }) => state), ['active']);
    assert.deepEqual(listing.refused.map(({ state }) => state), ['disabled']);
  });

  it('a promotion that cannot move the card leaves no prompt alone in agents/', () => {
    make();
    // The card cannot move: a folder takes its place in agents/.
    mkdirSync(join(home, 'agents', 'traduttore.yaml'));
    assert.throws(() => service.promote('traduttore', true));
    assert.equal(existsSync(join(home, 'agents', 'traduttore.md')), false);
    assert.ok(existsSync(disabled('traduttore.md')));
  });
});

describe('/api/agents', () => {
  it('lists, creates, activates, deactivates and promotes only with confirm', async () => {
    const server = await startApiServer({
      // Unused by these routes.
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      userAgents: service,
    });
    try {
      const origin = `http://127.0.0.1:${String(server.port)}`;
      const post = (path: string, body: unknown = {}) =>
        fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
      // Never written without the confirmation that /prepare returns.
      assert.equal((await post('/api/agents', input)).status, 400);
      const prepared = await post('/api/agents/prepare', input);
      assert.equal(prepared.status, 200);
      const { proposal } = (await prepared.json()) as { proposal: { confirmation: string; cloud: unknown } };
      assert.equal(proposal.cloud, null);
      assert.equal((await post('/api/agents', { ...input, confirmation: proposal.confirmation })).status, 201);
      assert.equal((await post('/api/agents', { ...input, confirmation: proposal.confirmation })).status, 409);
      assert.equal((await post('/api/agents/prepare', input)).status, 409);
      assert.equal((await post('/api/agents', { ...input, name: 'altro', extra: 1 })).status, 400);
      assert.equal((await post('/api/agents/prepare', { ...input, name: 'altro', template: 'answer' })).status, 400);
      assert.equal((await post('/api/agents/traduttore/activate')).status, 200);
      assert.ok(agents.has('traduttore'));
      assert.equal((await post('/api/agents/traduttore/deactivate')).status, 200);
      assert.equal((await post('/api/agents/nessuno/activate')).status, 404);
      assert.equal((await post('/api/agents/traduttore/promote')).status, 400);
      assert.equal((await post('/api/agents/traduttore/promote', { confirm: 'true' })).status, 400);
      assert.equal(existsSync(join(home, 'agents', 'traduttore.yaml')), false);
      const listed = (await (await fetch(`${origin}/api/agents`)).json()) as { user: { name: string; state: string }[] };
      assert.deepEqual(
        listed.user.map(({ name, state }) => [name, state]),
        [['traduttore', 'disabled']],
      );
      const sources = (await (await fetch(`${origin}/api/agents/sources`)).json()) as { presets: { id: string }[] };
      assert.equal(sources.presets.length, 2);
      assert.equal((await post('/api/agents/traduttore/promote', { confirm: true })).status, 200);
      assert.ok(existsSync(join(home, 'agents', 'traduttore.yaml')));
    } finally {
      await server.close();
    }
  });

  it('answers 404 without the service', async () => {
    const server = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${String(server.port)}/api/agents`)).status, 404);
    } finally {
      await server.close();
    }
  });
});

describe('user agents, tappa T3 (D-119)', () => {
  it('says where a delegated step of each agent runs', () => {
    make();
    make({ ...input, name: 'programmatore', permissions: coding });
    const works = Object.fromEntries(service.list().user.map(({ name, works }) => [name, works]));
    assert.deepEqual(works, { programmatore: 'claude', traduttore: 'local' });
    assert.equal(service.list().official[0]?.works, 'claude');
  });

  it('says which agent asks where each card runs (executor_choice: ask, D-159)', () => {
    const designer = loadAgent(fileURLToPath(new URL('../../../agents', import.meta.url)), 'designer');
    agents.set('designer', designer);
    const listed = createUserAgents({ home, dataDir: join(home, 'data'), agents, official: new Set(['coder', 'designer']), now: () => clock }).list().official;
    assert.deepEqual(
      listed.map(({ name, card }) => [name, card.executorChoice]),
      [
        ['coder', undefined],
        ['designer', 'ask'],
      ],
    );
  });

  it('changes description and prompt, also of an active agent, at once', () => {
    make();
    service.activate('traduttore');
    // Only the texts: no confirmation needed.
    assert.equal(service.prepareEdit('traduttore', { description: 'Translates everything', prompt: 'You translate into French.' }).confirmation, null);
    const edited = service.update('traduttore', { description: 'Translates everything', prompt: 'You translate into French.' });
    assert.equal(edited.description, 'Translates everything');
    assert.equal(edited.state, 'active');
    assert.equal(agents.get('traduttore')?.prompt.trim(), 'You translate into French.');
    assert.equal(agents.get('traduttore')?.origin, 'user');
    // Only one of the two: the other stays.
    service.update('traduttore', { prompt: 'Short.' });
    assert.equal(service.permissions('traduttore').description, 'Translates everything');
    // The permissions stay as they were: nothing else changed.
    assert.equal(service.permissions('traduttore').card.maxLabel, 'L1');
    assert.deepEqual(service.permissions('traduttore').permissions, answer);
    const card = readFileSync(join(home, 'data', 'agents', 'attivi', 'traduttore.yaml'), 'utf8');
    assert.match(card, /^# Created from the Agents page \(D-119\), permissions chosen within the ceiling/);
  });

  it('refuses an edit with personal data, a bad text or an unknown agent, and keeps the old texts', () => {
    make();
    assert.equal(code(() => service.update('traduttore', { prompt: 'Pay to IT60X0542811101000000123456.' })), 'invalid');
    assert.equal(code(() => service.update('traduttore', { description: 'two\nlines' })), 'invalid');
    assert.equal(code(() => service.update('traduttore', { prompt: 42 })), 'invalid');
    assert.equal(code(() => service.update('nessuno', { prompt: 'x' })), 'not-found');
    assert.equal(code(() => service.update('coder', { prompt: 'x' })), 'not-found');
    assert.equal(readFileSync(join(home, 'data', 'agents', 'disattivati', 'traduttore.md'), 'utf8'), `${input.prompt}\n`);
  });

  it('deletes only a disabled agent, with its name, into eliminati', () => {
    make();
    service.activate('traduttore');
    assert.equal(code(() => service.remove('traduttore', 'traduttore')), 'conflict');
    service.deactivate('traduttore');
    assert.equal(code(() => service.remove('traduttore', true)), 'invalid');
    assert.equal(code(() => service.remove('traduttore', 'altro')), 'invalid');
    const deleted = service.remove('traduttore', 'traduttore');
    assert.match(deleted.folder, /^data\/agents\/eliminati\/.+-traduttore$/);
    assert.ok(existsSync(join(home, deleted.folder, 'traduttore.yaml')));
    assert.ok(existsSync(join(home, deleted.folder, 'traduttore.md')));
    assert.equal(service.list().user.length, 0);
    // The name is free again, and a second deletion goes into a folder of its own.
    make();
    assert.notEqual(service.remove('traduttore', 'traduttore').folder, deleted.folder);
  });

  it('deletes a card shown as refused, never outside its folder', () => {
    mkdirSync(join(home, 'data', 'agents', 'disattivati'), { recursive: true });
    writeFileSync(join(home, 'data', 'agents', 'disattivati', 'rotto.yaml'), 'name: [');
    assert.equal(service.list().refused.length, 1);
    service.remove('rotto', 'rotto');
    assert.equal(service.list().refused.length, 0);
    const outside = ['..', 'coder'].join('/');
    assert.equal(code(() => service.remove(outside, outside)), 'not-found');
    assert.equal(code(() => service.remove('coder', 'coder')), 'not-found');
  });

  it('takes back a promotion: the card goes back disabled, under the ceiling', () => {
    make();
    service.promote('traduttore', true);
    assert.equal(service.list().official.find(({ name }) => name === 'traduttore')?.fromPage, true);
    assert.equal(code(() => service.demote('traduttore', 'yes')), 'invalid');
    const back = service.demote('traduttore', true);
    assert.equal(back.state, 'disabled');
    assert.equal(agents.has('traduttore'), false);
    assert.equal(existsSync(join(home, 'agents', 'traduttore.yaml')), false);
    assert.equal(existsSync(join(home, 'agents', 'traduttore.md')), false);
    assert.deepEqual(
      service.list().user.map(({ name, state }) => [name, state]),
      [['traduttore', 'disabled']],
    );
    assert.equal(code(() => service.demote('traduttore', true)), 'not-found');
  });

  it('never takes back a card the page did not write, nor one changed beyond the ceiling', () => {
    // The Coder of this test home: written by hand, no mark.
    writeFileSync(join(home, 'agents', 'coder.yaml'), readFileSync(fileURLToPath(new URL('../../../agents/coder.yaml', import.meta.url))));
    assert.equal(code(() => service.demote('coder', true)), 'invalid');
    assert.equal(service.list().official.find(({ name }) => name === 'coder')?.fromPage, undefined);
    make();
    service.promote('traduttore', true);
    const card = join(home, 'agents', 'traduttore.yaml');
    writeFileSync(card, readFileSync(card, 'utf8').replace('max_label: L1', 'max_label: L2'));
    assert.equal(code(() => service.demote('traduttore', true)), 'invalid');
    assert.ok(existsSync(card));
  });

  it('never takes back over a card of data/agents', () => {
    make();
    service.promote('traduttore', true);
    writeFileSync(join(home, 'data', 'agents', 'disattivati', 'traduttore.md'), 'x');
    assert.equal(code(() => service.demote('traduttore', true)), 'conflict');
    assert.ok(existsSync(join(home, 'agents', 'traduttore.yaml')));
  });

  it('/api/agents: edit, delete and demote, with their confirmations', async () => {
    const server = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, userAgents: service });
    try {
      const origin = `http://127.0.0.1:${String(server.port)}`;
      const post = (path: string, body: unknown = {}) =>
        fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
      const { proposal } = (await (await post('/api/agents/prepare', input)).json()) as { proposal: { confirmation: string } };
      assert.equal((await post('/api/agents', { ...input, confirmation: proposal.confirmation })).status, 201);
      assert.equal((await post('/api/agents/traduttore/edit', { prompt: 'Nuovo.' })).status, 200);
      // Permissions: prepared and confirmed.
      assert.equal((await post('/api/agents/traduttore/edit', { permissions: { ...answer, maxSteps: 5 } })).status, 400);
      const edit = (await (await post('/api/agents/traduttore/prepare', { permissions: { ...answer, maxSteps: 5 } })).json()) as { proposal: { confirmation: string } };
      assert.equal((await post('/api/agents/traduttore/edit', { permissions: { ...answer, maxSteps: 5 }, confirmation: edit.proposal.confirmation })).status, 200);
      assert.equal((await post('/api/agents/traduttore/prepare', { name: 'x' })).status, 400);
      assert.equal((await post('/api/agents/traduttore/edit', { name: 'altro' })).status, 400);
      assert.equal((await post('/api/agents/traduttore/promote', { confirm: true })).status, 200);
      assert.equal((await post('/api/agents/traduttore/demote')).status, 400);
      assert.equal((await post('/api/agents/traduttore/demote', { confirm: true })).status, 200);
      assert.equal((await post('/api/agents/traduttore/delete', { confirm: 'sì' })).status, 400);
      const deleted = await post('/api/agents/traduttore/delete', { confirm: 'traduttore' });
      assert.equal(deleted.status, 200);
      assert.match(((await deleted.json()) as { deleted: { folder: string } }).deleted.folder, /eliminati/);
      assert.equal((await post('/api/agents/traduttore/delete', { confirm: 'traduttore' })).status, 404);
    } finally {
      await server.close();
    }
  });
});


describe('user agents, tappa T3b (D-119): permissions chosen within the list', () => {
  const disabled = (name: string): string => join(home, 'data', 'agents', 'disattivati', name);

  it('prepare shows every field of a new card, the trifecta and what leaves for the cloud', () => {
    const local = service.prepareCreate(input);
    assert.match(local.confirmation ?? '', /^[0-9a-f]{32}$/);
    assert.equal(local.before, null);
    assert.deepEqual(
      local.changes.map(({ field }) => field),
      ['executor', 'tools', 'autonomy', 'maxSteps', 'maxMinutes', 'maxLabel', 'promptLabel'],
    );
    assert.deepEqual(local.trifecta, { private_data: false, untrusted_content: true, external_comms: false });
    assert.equal(local.cloud, null);
    const cloud = service.prepareCreate({ ...input, name: 'programmatore', permissions: coding });
    assert.deepEqual(cloud.cloud, { executor: 'claude', briefMax: 'L1', promptLabel: 'L1', claudeTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] });
    // Preparing writes nothing.
    assert.equal(existsSync(disabled('traduttore.yaml')), false);
  });

  it('creates only with the confirmation of those exact files, once, before it expires', () => {
    assert.equal(code(() => service.create(input)), 'invalid');
    assert.equal(code(() => service.create({ ...input, confirmation: 'abc' })), 'conflict');
    const { confirmation } = service.prepareCreate(input);
    // Other permissions than the ones shown.
    assert.equal(code(() => service.create({ ...input, permissions: { ...answer, maxSteps: 9 }, confirmation })), 'conflict');
    // A refused confirmation is spent: the page prepares again.
    assert.equal(code(() => service.create({ ...input, confirmation })), 'conflict');
    const again = service.prepareCreate(input).confirmation;
    assert.equal(code(() => service.create({ ...input, prompt: 'Something else.', confirmation: again })), 'conflict');
    const late = service.prepareCreate(input).confirmation;
    clock += 10 * 60_000;
    assert.equal(code(() => service.create({ ...input, confirmation: late })), 'conflict');
    assert.equal(service.list().user.length, 0);
    const fresh = service.prepareCreate(input).confirmation;
    assert.equal(service.create({ ...input, confirmation: fresh }).state, 'disabled');
  });

  it('a change of permissions needs its confirmation and shows only what changes', () => {
    make();
    service.activate('traduttore');
    const wider: UserPermissions = { ...answer, executor: 'claude', tools: ['repo.read'] };
    assert.equal(code(() => service.update('traduttore', { permissions: wider })), 'invalid');
    const proposal = service.prepareEdit('traduttore', { permissions: wider });
    assert.deepEqual(proposal.changes, [
      { field: 'executor', before: 'local', after: 'claude' },
      { field: 'tools', before: [], after: ['repo.read'] },
    ]);
    assert.equal(proposal.before?.executors[0], 'local');
    const edited = service.update('traduttore', { permissions: wider, confirmation: proposal.confirmation });
    assert.deepEqual(edited.permissions, wider);
    assert.equal(edited.works, 'claude');
    // The running agent changes at once.
    assert.deepEqual(agents.get('traduttore')?.card.executors, ['claude']);
    // The same choice again changes nothing: no confirmation.
    assert.equal(service.prepareEdit('traduttore', { permissions: { ...wider } }).confirmation, null);
  });

  it('refuses a confirmation when the card changed on disk after it was shown', () => {
    make();
    const { confirmation } = service.prepareEdit('traduttore', { permissions: { ...answer, maxMinutes: 5 } });
    change('traduttore', { permissions: { ...answer, maxSteps: 3 } });
    assert.equal(code(() => service.update('traduttore', { permissions: { ...answer, maxSteps: 3, maxMinutes: 5 }, confirmation })), 'conflict');
    assert.equal(service.permissions('traduttore').permissions?.maxMinutes, 10);
  });

  it('refuses permissions beyond the list in an edit, and keeps the old card', () => {
    make();
    assert.equal(code(() => service.prepareEdit('traduttore', { permissions: { ...coding, autonomy: 'A0' } })), 'invalid');
    assert.equal(code(() => service.prepareEdit('traduttore', { permissions: { ...answer, maxSteps: 51 } })), 'invalid');
    assert.equal(code(() => service.prepareEdit('traduttore', { permissions: { ...answer, executor: 'codex' } })), 'invalid');
    assert.deepEqual(service.permissions('traduttore').permissions, answer);
  });

  it('a card of tappa T2 at L0: an edit of the texts rises to L1, so it asks first', () => {
    make();
    const yaml = disabled('traduttore.yaml');
    writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('max_label: L1', 'max_label: L0').replace('prompt_label: L1\n', ''));
    assert.equal(service.permissions('traduttore').card.maxLabel, 'L0');
    const proposal = service.prepareEdit('traduttore', { prompt: 'New.' });
    assert.deepEqual(
      proposal.changes.map(({ field }) => field),
      ['maxLabel'],
    );
    assert.equal(code(() => service.update('traduttore', { prompt: 'New.' })), 'invalid');
    assert.equal(service.update('traduttore', { prompt: 'New.', confirmation: proposal.confirmation }).card.maxLabel, 'L1');
  });

  it('a promoted card keeps its prompt at L1, also a card written before tappa T3b', () => {
    make();
    service.promote('traduttore', true);
    const promoted = agents.get('traduttore');
    assert.ok(promoted !== undefined);
    assert.equal(promoted.origin, undefined);
    assert.equal(promptLabelOf(promoted), 'L1');
    assert.equal(service.list().official.find(({ name }) => name === 'traduttore')?.card.promptLabel, 'L1');

    make({ ...input, name: 'vecchio' });
    const yaml = disabled('vecchio.yaml');
    writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('prompt_label: L1\n', ''));
    assert.equal(service.permissions('vecchio').card.promptLabel, 'L1');
    service.promote('vecchio', true);
    assert.match(readFileSync(join(home, 'agents', 'vecchio.yaml'), 'utf8'), /prompt_label: L1/);
    const old = agents.get('vecchio');
    assert.ok(old !== undefined);
    assert.equal(promptLabelOf(old), 'L1');
  });

  it('takes back a promoted card with chosen permissions', () => {
    make({ ...input, permissions: { ...coding, tools: ['repo.read'], autonomy: 'A0', maxSteps: 7 } });
    service.promote('traduttore', true);
    const back = service.demote('traduttore', true);
    assert.deepEqual(back.permissions, { executor: 'claude', tools: ['repo.read'], autonomy: 'A0', maxSteps: 7, maxMinutes: 45 });
  });

  it('a confirmation is for one agent and one save only', () => {
    make();
    make({ ...input, name: 'altro' });
    const edit = { permissions: { ...answer, maxSteps: 4 } };
    const forA = service.prepareEdit('traduttore', edit).confirmation;
    assert.equal(code(() => service.update('altro', { ...edit, confirmation: forA })), 'conflict');
    const again = service.prepareEdit('traduttore', edit).confirmation;
    service.update('traduttore', { ...edit, confirmation: again });
    assert.equal(code(() => service.update('traduttore', { permissions: { ...answer, maxSteps: 4 }, confirmation: again })), 'ok');
    // Spent: the same change again needs a new one.
    assert.equal(code(() => service.update('traduttore', { permissions: { ...answer, maxSteps: 5 }, confirmation: again })), 'conflict');
  });

  it('an agency card keeps L0, its prompt at L0 and its provenance when edited from the page', () => {
    mkdirSync(join(home, 'data', 'agents', 'disattivati'), { recursive: true });
    const yaml = [
      '# Proposed by pnpm agency:import (D-079): not active until the user approves it.',
      '# Source: https://github.com/msitarzewski/agency-agents, commit abc, file x.md',
      'name: terzi',
      'description: A third-party role',
      'max_label: L0',
      'executors: [local]',
      'tools: []',
      'trifecta: { private_data: false, untrusted_content: true, external_comms: false }',
      'autonomy: A0',
      'difficulty: normal',
      'limits: { max_steps: 10, max_minutes: 10, max_cost: 0 }',
      'approvals: []',
      'prompt: terzi.md',
      'prompt_label: L0',
    ].join('\n');
    writeFileSync(disabled('terzi.yaml'), `${yaml}\n`);
    writeFileSync(disabled('terzi.md'), 'A role.\n');
    assert.equal(service.permissions('terzi').origin, 'agency');
    const edit = { permissions: { ...coding, tools: ['repo.read' as const], autonomy: 'A0' as const } };
    const proposal = service.prepareEdit('terzi', edit);
    assert.equal(proposal.after.maxLabel, 'L0');
    assert.equal(proposal.after.promptLabel, 'L0');
    service.update('terzi', { ...edit, confirmation: proposal.confirmation });
    const written = readFileSync(disabled('terzi.yaml'), 'utf8');
    assert.match(written, /^# Proposed by pnpm agency:import \(D-079\)/);
    assert.match(written, /# Source: https:\/\/github\.com\/msitarzewski\/agency-agents/);
    assert.match(written, /max_label: L0/);
    assert.match(written, /prompt_label: L0/);
    // Promoted, its prompt stays L0.
    service.promote('terzi', true);
    const promoted = agents.get('terzi');
    assert.ok(promoted !== undefined);
    assert.equal(promptLabelOf(promoted), 'L0');
  });

  it('a card of tappa T2 at L0 is not promoted until its rise to L1 is confirmed from the page', () => {
    make();
    const yaml = disabled('traduttore.yaml');
    writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('max_label: L1', 'max_label: L0').replace('prompt_label: L1\n', ''));
    assert.equal(code(() => service.promote('traduttore', true)), 'conflict');
    assert.ok(existsSync(yaml));
    assert.equal(existsSync(join(home, 'agents', 'traduttore.yaml')), false);
    change('traduttore', { prompt: 'Same.' });
    assert.equal(service.promote('traduttore', true).card.maxLabel, 'L1');
  });
});

