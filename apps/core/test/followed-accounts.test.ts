// The accounts followed for ideas (D-271): the address, the first check, the new
// repositories against a fake GitHub, the cap, the list file of D-202. Never the network.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import { checkAccount, emptyAccountState, FIRST_PAGES, LATER_PAGES, MAX_ACCOUNTS, MAX_FRESH, parseAccountState, parseAccountUrl, type AccountState } from '../src/followed-accounts.ts';
import { createFollowedProjects, FOLLOWED_FOLDER, type FollowedDeps } from '../src/followed-projects.ts';
import { CatalogError } from '../src/git-catalog.ts';
import { GithubError, type GithubGet } from '../src/github-api.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', `followed-accounts-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const ACCOUNT = { id: 'copilotkit', page: 'https://github.com/copilotkit', addedAt: '' };
const NOW = (): Date => new Date('2026-10-21T08:00:00Z');

interface FakeRepo {
  name: string;
  fork?: boolean;
  archived?: boolean;
  private?: boolean;
  disabled?: boolean;
  license?: string | null;
  owner?: string;
}

function repo({ name, fork = false, archived = false, private: hidden = false, disabled = false, license = 'MIT', owner = 'CopilotKit' }: FakeRepo, index: number): unknown {
  return {
    full_name: `${owner}/${name}`,
    private: hidden,
    fork,
    archived,
    disabled,
    description: `Descrizione di ${name}`,
    created_at: `2026-10-${String(20 - (index % 20)).padStart(2, '0')}T10:00:00Z`,
    license: license === null ? null : { spdx_id: license },
  };
}

/** A fake API with the repositories of the account, newest first, split in pages of 100. */
function fakeGithub(repos: () => FakeRepo[], failure?: Error): { get: GithubGet; asked: string[]; gateway: (address: string) => Promise<void> } {
  const asked: string[] = [];
  return {
    asked,
    gateway: (address) => {
      asked.push(address);
      return Promise.resolve();
    },
    get: (path) => {
      if (failure !== undefined) return Promise.reject(failure);
      const match = /^\/users\/copilotkit\/repos\?type=owner&sort=created&direction=desc&per_page=100&page=(\d+)$/.exec(path);
      if (match === null) return Promise.reject(new GithubError('not-found', 'answered 404'));
      const page = Number(match[1]);
      return Promise.resolve(repos().slice((page - 1) * 100, page * 100).map(repo));
    },
  };
}

const names = (count: number, prefix = 'repo'): FakeRepo[] => Array.from({ length: count }, (_, index) => ({ name: `${prefix}-${String(index)}` }));

describe('the address of an account', () => {
  it('is https://github.com/<owner>, nothing else', () => {
    assert.deepEqual(parseAccountUrl('https://github.com/CopilotKit/'), ACCOUNT);
    for (const bad of ['https://github.com/copilotkit/copilotkit', 'https://gitlab.com/copilotkit', 'http://github.com/copilotkit', 'https://github.com/-x', 'https://github.com/a--b', 'https://github.com/', 42]) {
      assert.equal(parseAccountUrl(bad), undefined, String(bad));
    }
  });
});

describe('a check of an account', () => {
  it('the first check records what is there as seen, with no news, and says how many', async () => {
    const github = fakeGithub(() => [{ name: 'CopilotKit' }, { name: 'old-fork', fork: true }, { name: 'archived', archived: true }, { name: 'open-ag-ui' }]);
    const state = await checkAccount({ ...github, now: NOW }, ACCOUNT, emptyAccountState(ACCOUNT.id));
    assert.deepEqual(state.fresh, []);
    assert.equal(state.firstCount, 2);
    assert.deepEqual(state.known, ['copilotkit', 'old-fork', 'archived', 'open-ag-ui']);
    assert.match(state.message ?? '', /Primo controllo: 2 repository/);
    // Only the name of the account left, through the gateway; one page, shorter than 100.
    assert.deepEqual(github.asked, ['https://api.github.com/users/copilotkit/repos?type=owner&sort=created&direction=desc&per_page=100&page=1']);
  });

  it('a new repository appears at the next check; a new fork or archived one does not', async () => {
    let repos: FakeRepo[] = [{ name: 'copilotkit' }, { name: 'open-ag-ui' }];
    const github = fakeGithub(() => repos);
    const first = await checkAccount(github, ACCOUNT, emptyAccountState(ACCOUNT.id));
    repos = [{ name: 'New-Agent', license: null }, { name: 'a-fork', fork: true }, { name: 'gone', archived: true }, ...repos];
    const next = await checkAccount({ ...github, now: NOW }, ACCOUNT, first);
    assert.deepEqual(
      next.fresh.map((item) => [item.id, item.name, item.page, item.license]),
      [['copilotkit/new-agent', 'New-Agent', 'https://github.com/copilotkit/new-agent', null]],
    );
    assert.equal(next.fresh[0]?.description, 'Descrizione di New-Agent');
    assert.equal(next.freshAt, NOW().toISOString());
    assert.match(next.message ?? '', /^1 repository nuovo\./);
    assert.ok(next.known?.includes('a-fork'));
    // Nothing new at the check after: the list of the last news stays, with its date.
    const again = await checkAccount(github, ACCOUNT, next);
    assert.deepEqual(again.fresh, next.fresh);
    assert.equal(again.freshAt, next.freshAt);
    assert.equal(again.message, 'Nessun repository nuovo.');
  });

  it('reads more pages at the first check, and at the later ones stops at a page with a repository seen', async () => {
    let repos = names(150);
    const github = fakeGithub(() => repos);
    const first = await checkAccount(github, ACCOUNT, emptyAccountState(ACCOUNT.id));
    assert.equal(first.firstCount, 150);
    assert.equal(github.asked.length, 2);
    repos = [...names(3, 'nuovo'), ...repos];
    const next = await checkAccount(github, ACCOUNT, first);
    assert.equal(next.fresh.length, 3);
    assert.equal(github.asked.length, 3);
  });

  it('a later check reads at most 3 pages and says when older ones may be missing', async () => {
    let repos = names(10);
    const github = fakeGithub(() => repos);
    const first = await checkAccount(github, ACCOUNT, emptyAccountState(ACCOUNT.id));
    repos = [...names(400, 'nuovo'), ...repos];
    const next = await checkAccount(github, ACCOUNT, first);
    assert.equal(github.asked.length, 1 + LATER_PAGES);
    assert.equal(next.fresh.length, MAX_FRESH);
    assert.equal(next.fresh[0]?.name, 'nuovo-0');
    assert.match(next.message ?? '', /^300 repository nuovi\. Mostro i 30 più recenti\. Potrebbero essercene altri più vecchi/);
  });

  it('the first check of a large account reads at most 5 pages and says so', async () => {
    const github = fakeGithub(() => [...names(20, 'fork').map((item) => ({ ...item, fork: true })), ...names(600)]);
    const state = await checkAccount(github, ACCOUNT, emptyAccountState(ACCOUNT.id));
    assert.equal(github.asked.length, FIRST_PAGES);
    assert.equal(state.firstCount, 480);
    assert.equal(state.known?.length, 500);
    assert.match(state.message ?? '', /480 repository pubblici già presenti fra i 500 più recenti \(fork compresi/);
  });

  it('a private or disabled repository is never news; NOASSERTION is no license', async () => {
    let repos: FakeRepo[] = [{ name: 'a' }];
    const github = fakeGithub(() => repos);
    const first = await checkAccount(github, ACCOUNT, emptyAccountState(ACCOUNT.id));
    repos = [{ name: 'hidden', private: true }, { name: 'off', disabled: true }, { name: 'odd', license: 'NOASSERTION' }, ...repos];
    const next = await checkAccount(github, ACCOUNT, first);
    assert.deepEqual(
      next.fresh.map((item) => [item.name, item.license]),
      [['odd', null]],
    );
  });

  it('ignores a repository of another owner', async () => {
    const github = fakeGithub(() => [{ name: 'x', owner: 'someone-else' }, { name: 'y' }]);
    const state = await checkAccount(github, ACCOUNT, emptyAccountState(ACCOUNT.id));
    assert.deepEqual(state.known, ['y']);
  });

  it('an account GitHub does not find, or no network: a message, nothing seen changes', async () => {
    const before: AccountState = { ...emptyAccountState(ACCOUNT.id), known: ['a'], firstCount: 1 };
    const missing = await checkAccount({ ...fakeGithub(() => [], new GithubError('not-found', 'answered 404')), now: NOW }, ACCOUNT, before);
    assert.match(missing.message ?? '', /non trova l’account/);
    assert.deepEqual(missing.known, ['a']);
    assert.equal(missing.checkedAt, NOW().toISOString());
    const limited = await checkAccount(fakeGithub(() => [], new GithubError('limited', 'limited')), ACCOUNT, emptyAccountState(ACCOUNT.id));
    assert.equal(limited.known, null);
    assert.match(limited.message ?? '', /limita le richieste/);
  });

  it('a refusal of the gateway asks nothing of GitHub', async () => {
    let fetched = false;
    const state = await checkAccount(
      {
        gateway: () => Promise.reject(new Error('blocked by the gateway')),
        get: () => {
          fetched = true;
          return Promise.resolve([]);
        },
      },
      ACCOUNT,
      emptyAccountState(ACCOUNT.id),
    );
    assert.equal(fetched, false);
    assert.match(state.message ?? '', /gateway/);
  });

  it('the state file is refused when a repository could lead elsewhere', async () => {
    let repos: FakeRepo[] = [{ name: 'a' }];
    const github = fakeGithub(() => repos);
    const first = await checkAccount(github, ACCOUNT, emptyAccountState(ACCOUNT.id));
    repos = [{ name: 'b' }, ...repos];
    const next = await checkAccount(github, ACCOUNT, first);
    const stored = JSON.parse(JSON.stringify(next)) as AccountState;
    assert.deepEqual(parseAccountState(stored, ACCOUNT.id), next);
    assert.equal(parseAccountState(stored, 'other'), undefined);
    const fresh = stored.fresh[0];
    assert.ok(fresh !== undefined);
    assert.equal(parseAccountState({ ...stored, fresh: [{ ...fresh, page: 'https://evil.example/copilotkit/b' }] }, ACCOUNT.id), undefined);
    assert.equal(parseAccountState({ ...stored, fresh: [{ ...fresh, id: 'other/b' }] }, ACCOUNT.id), undefined);
    assert.equal(parseAccountState({ ...stored, known: ['../x', 'a b'] }, ACCOUNT.id), undefined);
    assert.equal(parseAccountState({ ...stored, firstCount: -1 }, ACCOUNT.id), undefined);
  });
});

function deps(dir: string, repos: () => FakeRepo[] = () => []): FollowedDeps {
  return { dir, ...fakeGithub(repos) };
}

describe('the accounts in the list of the projects', () => {
  it('add tells an account from a repository, and refuses anything else', () => {
    const projects = createFollowedProjects(deps(join(scratch, randomUUID())));
    const account = projects.add('https://github.com/CopilotKit');
    assert.equal(account.id, 'copilotkit');
    projects.add('https://github.com/copilotkit/copilotkit');
    assert.deepEqual(
      projects.accounts().map((item) => item.id),
      ['copilotkit'],
    );
    assert.ok(projects.list().some((item) => item.id === 'copilotkit/copilotkit'));
    for (const bad of ['https://gitlab.com/copilotkit', 'https://github.com/a/b/c', 'github.com/copilotkit', 42]) {
      assert.throws(() => projects.add(bad), (error: unknown) => error instanceof CatalogError && error.code === 'invalid', String(bad));
    }
    assert.throws(() => projects.add('https://github.com/copilotkit/'), (error: unknown) => error instanceof CatalogError && error.code === 'conflict');
  });

  it(`follows at most ${String(MAX_ACCOUNTS)} accounts`, () => {
    const projects = createFollowedProjects(deps(join(scratch, randomUUID())));
    for (let index = 0; index < MAX_ACCOUNTS; index += 1) projects.add(`https://github.com/owner-${String(index)}`);
    assert.throws(() => projects.add('https://github.com/one-more'), (error: unknown) => error instanceof CatalogError && error.code === 'invalid');
    // The cap of the accounts is not the one of the projects.
    projects.add('https://github.com/owner/repo');
  });

  it('reads a list file written before the accounts, and keeps its projects when one is added', () => {
    const dir = join(scratch, randomUUID());
    mkdirSync(join(dir, FOLLOWED_FOLDER), { recursive: true });
    const file = join(dir, FOLLOWED_FOLDER, 'projects.json');
    writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: 'c/d', page: 'https://github.com/c/d', addedAt: 'x' }] }));
    const projects = createFollowedProjects(deps(dir));
    assert.deepEqual(projects.accounts(), []);
    projects.add('https://github.com/copilotkit');
    projects.add('https://github.com/e/f');
    const written = JSON.parse(readFileSync(file, 'utf8')) as { projects: { id: string }[]; accounts: { id: string }[] };
    assert.deepEqual(
      written.projects.map((item) => item.id),
      ['c/d', 'e/f'],
    );
    assert.deepEqual(
      written.accounts.map((item) => item.id),
      ['copilotkit'],
    );
    projects.remove('copilotkit');
    assert.deepEqual(projects.accounts(), []);
    assert.equal(projects.list().length, 3);
    assert.throws(() => projects.remove('copilotkit'), (error: unknown) => error instanceof CatalogError && error.code === 'not-found');
  });

  it('a description written by hand is cleaned and cut, one that is not text is dropped (D-272)', () => {
    const dir = join(scratch, randomUUID());
    mkdirSync(join(dir, FOLLOWED_FOLDER), { recursive: true });
    const projects = [
      { id: 'a/long', page: 'https://github.com/a/long', addedAt: 'x', description: `riga\u0007 nuova\n${'x'.repeat(400)}` },
      { id: 'a/number', page: 'https://github.com/a/number', addedAt: 'x', description: 42 },
      { id: 'a/blank', page: 'https://github.com/a/blank', addedAt: 'x', description: '   ' },
    ];
    writeFileSync(join(dir, FOLLOWED_FOLDER, 'projects.json'), JSON.stringify({ version: 1, projects }));
    const listed = createFollowedProjects(deps(dir)).list();
    const long = listed.find((item) => item.id === 'a/long')?.description ?? '';
    assert.ok(long.length <= 300 && long.startsWith('riga') && !long.includes('\u0007') && !long.includes('\n'), long.slice(0, 40));
    assert.equal(listed.find((item) => item.id === 'a/number')?.description, undefined);
    assert.equal(listed.find((item) => item.id === 'a/blank')?.description, undefined);
  });

  it('drops an account written by hand that does not match its address, or twice', () => {
    const dir = join(scratch, randomUUID());
    mkdirSync(join(dir, FOLLOWED_FOLDER), { recursive: true });
    const accounts = [
      { id: 'copilotkit', page: 'https://github.com/other', addedAt: 'x' },
      { id: 'nodate', page: 'https://github.com/nodate' },
      { id: 'evil', page: 'https://evil.example/evil', addedAt: 'x' },
      { id: 'good', page: 'https://github.com/good', addedAt: 'x' },
      { id: 'good', page: 'https://github.com/good', addedAt: 'y' },
    ];
    writeFileSync(join(dir, FOLLOWED_FOLDER, 'projects.json'), JSON.stringify({ version: 1, projects: [], accounts }));
    assert.deepEqual(
      createFollowedProjects(deps(dir)).accounts().map((item) => [item.id, item.addedAt]),
      [['good', 'x']],
    );
  });

  it('checks an account in the background; «Segui» on a new repository makes it a project', async () => {
    const dir = join(scratch, randomUUID());
    let repos: FakeRepo[] = [{ name: 'copilotkit' }];
    const events: string[] = [];
    const projects = createFollowedProjects({ ...deps(dir, () => repos), onEvent: (kind, payload) => events.push(`${kind}:${String(payload.fresh ?? '')}`) });
    projects.add('https://github.com/copilotkit');
    projects.check('copilotkit');
    assert.equal(projects.accounts()[0]?.checking, true);
    assert.throws(
      () => {
        projects.check('https://github.com/copilotkit');
      },
      (error: unknown) => error instanceof CatalogError && error.code === 'conflict',
    );
    assert.throws(
      () => projects.remove('copilotkit'),
      (error: unknown) => error instanceof CatalogError && error.code === 'conflict',
    );
    await projects.idle();
    assert.equal(projects.accounts()[0]?.firstCount, 1);
    repos = [{ name: 'new-agent' }, ...repos];
    projects.check('copilotkit');
    await projects.idle();
    const view = projects.accounts()[0];
    assert.deepEqual(
      view?.fresh.map((item) => [item.id, item.followed]),
      [['copilotkit/new-agent', false]],
    );
    projects.add(view.fresh[0]?.page);
    assert.equal(projects.accounts()[0]?.fresh[0]?.followed, true);
    // The description of the check comes with it (D-272), and stays after a reload of the list.
    assert.equal(projects.list().find((item) => item.id === 'copilotkit/new-agent')?.description, 'Descrizione di new-agent');
    assert.equal(createFollowedProjects(deps(dir)).list().find((item) => item.id === 'copilotkit/new-agent')?.description, 'Descrizione di new-agent');
    projects.add('https://github.com/other/plain');
    assert.equal(projects.list().find((item) => item.id === 'other/plain')?.description, undefined);
    assert.deepEqual(events, ['followed.account_added:', 'followed.account_checked:0', 'followed.account_checked:1', 'followed.added:', 'followed.added:']);
  });
});

function send(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

describe('the routes of the accounts', () => {
  it('adds, lists, checks and removes an account', async (t) => {
    const home = join(scratch, randomUUID());
    mkdirSync(join(home, 'docs'), { recursive: true });
    const projects = createFollowedProjects(deps(join(home, 'data', 'catalogs'), () => [{ name: 'copilotkit' }]));
    const server = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, devProgress: { home, projects } });
    t.after(() => server.close());
    const added = await send(server.port, 'POST', '/api/dev/projects', { url: 'https://github.com/copilotkit' });
    assert.equal(added.status, 201);
    assert.equal((added.body.account as { id: string }).id, 'copilotkit');
    assert.equal((await send(server.port, 'POST', '/api/dev/projects', { url: 'https://example.com/copilotkit' })).status, 400);
    assert.equal((await send(server.port, 'POST', '/api/dev/projects/check', { id: 'copilotkit' })).status, 202);
    await projects.idle();
    const listed = (await send(server.port, 'GET', '/api/dev/projects')).body as { accounts: { id: string; firstCount: number }[]; maxAccounts: number };
    assert.equal(listed.maxAccounts, MAX_ACCOUNTS);
    assert.deepEqual(
      listed.accounts.map((item) => [item.id, item.firstCount]),
      [['copilotkit', 1]],
    );
    assert.equal((await send(server.port, 'POST', '/api/dev/projects/check', { id: 'nobody' })).status, 404);
    const removed = await send(server.port, 'DELETE', '/api/dev/projects', { id: 'copilotkit' });
    assert.equal(removed.status, 200);
    assert.equal((removed.body.account as { id: string }).id, 'copilotkit');
  });
});
