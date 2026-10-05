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
    assert.equal(created.card.maxLabel, 'L0');
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
