import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, describe, it } from 'node:test';

import { loadAgent, type LoadedAgent } from '@arianna/agents';
import { Secret } from '@arianna/vault';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

import { createUserAgents, UserAgentError } from '../src/user-agents.ts';

const root = mkdtempSync(join(tmpdir(), 'arianna-user-agents-core-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const coder = loadAgent(fileURLToPath(new URL('../../../agents', import.meta.url)), 'coder');
const input = { name: 'traduttore', description: 'Translates the release notes', template: 'answer', prompt: 'You translate text into Italian.' };

let home: string;
let agents: Map<string, LoadedAgent>;
let service: ReturnType<typeof createUserAgents>;

beforeEach(() => {
  home = mkdtempSync(join(root, 'home-'));
  mkdirSync(join(home, 'agents'));
  agents = new Map([['coder', coder]]);
  service = createUserAgents({ home, dataDir: join(home, 'data'), agents, official: new Set(['coder']) });
});

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
    const created = service.create(input);
    assert.equal(created.state, 'disabled');
    // Its prompt is the user's own (L1): an answering agent of the page reads up to L1 (tappa T3).
    assert.equal(created.card.maxLabel, 'L1');
    assert.ok(existsSync(join(home, 'data', 'agents', 'disattivati', 'traduttore.yaml')));
    assert.equal(agents.has('traduttore'), false);
  });

  it('activate and deactivate change the running agents at once', () => {
    service.create(input);
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
    service.create(input);
    service.activate('traduttore');
    const fresh = new Map([['coder', coder]]);
    const again = createUserAgents({ home, dataDir: join(home, 'data'), agents: fresh, official: new Set(['coder']) });
    assert.deepEqual(again.load(), []);
    assert.ok(fresh.has('traduttore'));
  });

  it('refuses names already taken, unknown agents and bad input', () => {
    service.create(input);
    assert.equal(code(() => service.create(input)), 'conflict');
    assert.equal(code(() => service.create({ ...input, name: 'coder' })), 'conflict');
    assert.equal(code(() => service.activate('nessuno')), 'not-found');
    assert.equal(code(() => service.activate('../coder')), 'not-found');
    assert.equal(code(() => service.create({ ...input, name: 'altro', template: 'admin' })), 'invalid');
  });

  it('refuses a prompt with personal data or a secret, without repeating it', () => {
    let message = '';
    try {
      service.create({ ...input, prompt: 'Pay to IT60X0542811101000000123456 every month.' });
    } catch (error) {
      assert.ok(error instanceof UserAgentError);
      message = error.message;
    }
    assert.match(message, /^the prompt looks like personal data/);
    assert.doesNotMatch(message, /IT60/);
    assert.equal(service.list().user.length, 0);
  });

  it('promotion needs the confirmation and moves the card into agents/', () => {
    service.create(input);
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
    assert.equal(code(() => service.create(input)), 'conflict');
  });

  it('never promotes over a card of agents/', () => {
    service.create(input);
    writeFileSync(join(home, 'agents', 'traduttore.md'), 'x');
    assert.equal(code(() => service.promote('traduttore', true)), 'conflict');
    assert.ok(existsSync(join(home, 'data', 'agents', 'disattivati', 'traduttore.yaml')));
  });

  it('lists the templates as sources', () => {
    assert.deepEqual(
      service.sources().templates.map(({ id }) => id),
      ['code', 'web', 'answer'],
    );
  });
});

describe('user agents, more cases', () => {
  const disabled = (name: string): string => join(home, 'data', 'agents', 'disattivati', name);
  const active = (name: string): string => join(home, 'data', 'agents', 'attivi', name);

  it('refuses a vault value and personal data in the description or the name', () => {
    new Secret('vault://test/user-agent', 'segreto-del-vault-1234');
    assert.equal(code(() => service.create({ ...input, prompt: 'Use segreto-del-vault-1234 to log in.' })), 'invalid');
    assert.equal(code(() => service.create({ ...input, description: 'Mario, IBAN IT60X0542811101000000123456' })), 'invalid');
    assert.equal(code(() => service.create({ ...input, name: 'rssmra80a01h501u' })), 'invalid');
    assert.equal(service.list().user.length, 0);
  });

  it('a card edited by hand beyond its template is refused, also at start', () => {
    service.create(input);
    service.activate('traduttore');
    const yaml = readFileSync(active('traduttore.yaml'), 'utf8').replace('tools: []', 'tools: [kb.search]');
    writeFileSync(active('traduttore.yaml'), yaml);
    const fresh = new Map([['coder', coder]]);
    const again = createUserAgents({ home, dataDir: join(home, 'data'), agents: fresh, official: new Set(['coder']) });
    assert.deepEqual(again.load().map(({ name }) => name), ['traduttore']);
    assert.equal(fresh.has('traduttore'), false);
    assert.match(again.list().refused[0]?.reason ?? '', /does not match any template/);
  });

  it('a prompt that is a symbolic link is refused', () => {
    service.create(input);
    rmSync(disabled('traduttore.md'));
    writeFileSync(join(home, 'fuori.md'), 'x');
    symlinkSync(join(home, 'fuori.md'), disabled('traduttore.md'));
    assert.equal(code(() => service.activate('traduttore')), 'not-found');
    assert.match(service.list().refused[0]?.reason ?? '', /not a regular file/);
  });

  it('marks the prompt of a user agent as the user\'s', () => {
    service.create(input);
    service.activate('traduttore');
    assert.equal(agents.get('traduttore')?.origin, 'user');
    service.promote('traduttore', true);
    assert.equal(agents.get('traduttore')?.origin, undefined);
  });

  it('repeated and unknown actions', () => {
    assert.equal(code(() => service.deactivate('nessuno')), 'not-found');
    service.create(input);
    service.activate('traduttore');
    assert.equal(service.activate('traduttore').state, 'active');
    assert.equal(service.promote('traduttore', true).state, 'official');
    assert.equal(code(() => service.deactivate('traduttore')), 'not-found');
  });

  it('the same name in both folders shows once, the copy as refused', () => {
    service.create(input);
    service.activate('traduttore');
    mkdirSync(join(home, 'data', 'agents', 'disattivati'), { recursive: true });
    writeFileSync(disabled('traduttore.yaml'), readFileSync(active('traduttore.yaml')));
    writeFileSync(disabled('traduttore.md'), 'x');
    const listing = service.list();
    assert.deepEqual(listing.user.map(({ state }) => state), ['active']);
    assert.deepEqual(listing.refused.map(({ state }) => state), ['disabled']);
  });

  it('a promotion that cannot move the card leaves no prompt alone in agents/', () => {
    service.create(input);
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
      assert.equal((await post('/api/agents', input)).status, 201);
      assert.equal((await post('/api/agents', input)).status, 409);
      assert.equal((await post('/api/agents', { ...input, name: 'altro', extra: 1 })).status, 400);
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
      const templates = (await (await fetch(`${origin}/api/agents/sources`)).json()) as { templates: { id: string }[] };
      assert.equal(templates.templates.length, 3);
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
    service.create(input);
    service.create({ ...input, name: 'programmatore', template: 'code' });
    service.create({ ...input, name: 'cercatore', template: 'web' });
    const works = Object.fromEntries(service.list().user.map(({ name, works }) => [name, works]));
    assert.deepEqual(works, { cercatore: null, programmatore: 'claude', traduttore: 'local' });
    assert.equal(service.list().official[0]?.works, 'claude');
  });

  it('changes description and prompt, also of an active agent, at once', () => {
    service.create(input);
    service.activate('traduttore');
    const edited = service.update('traduttore', { description: 'Translates everything', prompt: 'You translate into French.' });
    assert.equal(edited.description, 'Translates everything');
    assert.equal(edited.state, 'active');
    assert.equal(agents.get('traduttore')?.prompt.trim(), 'You translate into French.');
    assert.equal(agents.get('traduttore')?.origin, 'user');
    // Only one of the two: the other stays.
    service.update('traduttore', { prompt: 'Short.' });
    assert.equal(service.permissions('traduttore').description, 'Translates everything');
    // The card is still the template's: nothing else changed.
    assert.equal(service.permissions('traduttore').card.maxLabel, 'L1');
    const card = readFileSync(join(home, 'data', 'agents', 'attivi', 'traduttore.yaml'), 'utf8');
    assert.match(card, /^# Created from the Agents page \(D-119\), template answer\./);
  });

  it('refuses an edit with personal data, a bad text or an unknown agent, and keeps the old texts', () => {
    service.create(input);
    assert.equal(code(() => service.update('traduttore', { prompt: 'Pay to IT60X0542811101000000123456.' })), 'invalid');
    assert.equal(code(() => service.update('traduttore', { description: 'two\nlines' })), 'invalid');
    assert.equal(code(() => service.update('traduttore', { prompt: 42 })), 'invalid');
    assert.equal(code(() => service.update('nessuno', { prompt: 'x' })), 'not-found');
    assert.equal(code(() => service.update('coder', { prompt: 'x' })), 'not-found');
    assert.equal(readFileSync(join(home, 'data', 'agents', 'disattivati', 'traduttore.md'), 'utf8'), `${input.prompt}\n`);
  });

  it('deletes only a disabled agent, with its name, into eliminati', () => {
    service.create(input);
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
    service.create(input);
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
    service.create(input);
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
    service.create(input);
    service.promote('traduttore', true);
    const card = join(home, 'agents', 'traduttore.yaml');
    writeFileSync(card, readFileSync(card, 'utf8').replace('max_label: L1', 'max_label: L2'));
    assert.equal(code(() => service.demote('traduttore', true)), 'invalid');
    assert.ok(existsSync(card));
  });

  it('never takes back over a card of data/agents', () => {
    service.create(input);
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
      assert.equal((await post('/api/agents', input)).status, 201);
      assert.equal((await post('/api/agents/traduttore/edit', { prompt: 'Nuovo.' })).status, 200);
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
