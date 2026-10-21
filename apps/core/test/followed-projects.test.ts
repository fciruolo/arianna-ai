// The projects followed for ideas (D-202): the list, a check against a fake GitHub, the
// answers «Implementiamo» / «Non interessa» in RISPOSTE.md. Never the network.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import { createContext, fakePiiCheck, gatewayCheck as gatewayCheckWithPii, secretMatcher } from '@arianna/policy';

import type { Sql } from '../src/db/client.ts';
import { ANSWERS_FILE, eventKey, parseAnswers, type AnswerGate } from '../src/dev-progress.ts';
import { checkProject, createFollowedProjects, FOLLOWED_FOLDER, keyPrefix, MAX_PROJECTS, parseState, PROJECT_KEY, type FollowedDeps, type ProjectState } from '../src/followed-projects.ts';
import { CatalogError } from '../src/git-catalog.ts';
import { GithubError, type GithubGet } from '../src/github-api.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

// The second scanner (D-113) finds nothing here: these tests are about the other rules (pii.test.ts has its own).
const gatewayCheck = (
  payload: Parameters<typeof gatewayCheckWithPii>[0],
  context: Parameters<typeof gatewayCheckWithPii>[1],
  target: Parameters<typeof gatewayCheckWithPii>[2],
  secrets: Parameters<typeof gatewayCheckWithPii>[3],
) => gatewayCheckWithPii(payload, context, target, secrets, fakePiiCheck(payload));

const scratch = join(resolveHome({}), 'data', 'test-tmp', `followed-projects-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const OPENWORK = { id: 'different-ai/openwork', page: 'https://github.com/different-ai/openwork', addedAt: '' };
const sha = (n: number): string => n.toString(16).padStart(7, '0') + 'd'.repeat(33);

function releases(...tags: string[]): unknown {
  return tags.map((tag, index) => ({
    tag_name: tag,
    name: `OpenWork ${tag}`,
    draft: false,
    published_at: `2026-10-${String(13 - index).padStart(2, '0')}T10:00:00Z`,
    html_url: `https://github.com/different-ai/openwork/releases/tag/${tag}`,
    body: `Notes of ${tag}`,
  }));
}

function compare(messages: string[]): unknown {
  return { total_commits: messages.length, commits: messages.map((message, index) => ({ sha: sha(index + 1), commit: { message } })), files: [{ filename: 'apps/x.ts' }] };
}

/** A fake API: the answer of each path, or an error; every address the gateway saw. */
function fakeGithub(answers: Record<string, unknown>): { get: GithubGet; asked: string[]; gateway: (address: string) => Promise<void> } {
  const asked: string[] = [];
  return {
    asked,
    gateway: (address) => {
      asked.push(address);
      return Promise.resolve();
    },
    get: (path) => {
      const found = Object.entries(answers).find(([prefix]) => path.startsWith(prefix));
      if (found === undefined) return Promise.reject(new GithubError('not-found', 'answered 404'));
      return found[1] instanceof Error ? Promise.reject(found[1]) : Promise.resolve(found[1]);
    },
  };
}

const EMPTY: ProjectState = { version: 1, id: OPENWORK.id, seen: null, checkedAt: null, message: null, news: null };
const NOW = (): Date => new Date('2026-10-14T08:00:00Z');

describe('a check of a project', () => {
  it('compares the release before the newest at the first check, as the raw list by kind', async () => {
    const github = fakeGithub({
      '/repos/different-ai/openwork/releases': releases('v0.18.57', 'v0.18.56'),
      '/repos/different-ai/openwork/compare/v0.18.56...v0.18.57': compare(['feat(chat): voice notes', 'fix: crash on start', 'chore: bump']),
    });
    const state = await checkProject({ ...github, now: NOW }, OPENWORK, EMPTY);
    assert.equal(state.seen, 'v0.18.57');
    assert.equal(state.news?.state, 'ready');
    assert.equal(state.news.source, 'raw');
    assert.equal(state.news.from, 'v0.18.56');
    assert.deepEqual(state.news.items.map((item) => [item.group, item.title]), [['feat', 'feat(chat): voice notes'], ['fix', 'fix: crash on start'], ['other', 'chore: bump']]);
    for (const item of state.news.items) assert.match(item.key, PROJECT_KEY);
    assert.ok(state.news.items[0]?.key.startsWith('gh-different-ai__openwork-'));
    // Only the name of the repository left, through the gateway, towards the API of GitHub.
    assert.deepEqual(github.asked, ['https://api.github.com/repos/different-ai/openwork/releases?per_page=10', 'https://api.github.com/repos/different-ai/openwork/compare/v0.18.56...v0.18.57?per_page=250']);
  });

  it('groups with the local model, checked, and with the keys of the project', async () => {
    const github = fakeGithub({ '/repos/different-ai/openwork/releases': releases('v2', 'v1'), '/repos/different-ai/openwork/compare/': compare(['feat: a', 'feat: b']) });
    const state = await checkProject(
      { ...github, now: NOW, summarize: () => Promise.resolve({ value: { items: [{ title: 'Note vocali', summary: 'Si parla alla chat.', commits: [1, 2] }] }, finishReason: 'stop', model: 'm' }) },
      OPENWORK,
      EMPTY,
    );
    assert.equal(state.news?.source, 'model');
    assert.equal(state.news.items.length, 1);
    // Number 1 is the newest commit, the first of the list the model reads.
    assert.equal(state.news.items[0]?.key, `${keyPrefix(OPENWORK.id)}${sha(2).slice(0, 7)}`);
  });

  it('a malformed model answer falls back to the raw list (D-202)', async () => {
    const github = fakeGithub({ '/repos/different-ai/openwork/releases': releases('v2', 'v1'), '/repos/different-ai/openwork/compare/': compare(['feat: a', 'fix: b']) });
    const state = await checkProject({ ...github, summarize: () => Promise.resolve({ value: { items: 'Ecco le novità' }, finishReason: 'stop', model: 'm' }) }, OPENWORK, EMPTY);
    assert.equal(state.news?.source, 'raw');
    assert.match(state.news.message ?? '', /non ha passato i controlli \(not the shape asked\)/);
    assert.equal(state.news.items.length, 2);
  });

  it('a number the model invents is dropped, the rest of its grouping kept (D-202)', async () => {
    const github = fakeGithub({ '/repos/different-ai/openwork/releases': releases('v2', 'v1'), '/repos/different-ai/openwork/compare/': compare(['feat: a', 'feat: b']) });
    const state = await checkProject(
      { ...github, now: NOW, summarize: () => Promise.resolve({ value: { items: [{ title: 'Note vocali', summary: 'Si parla alla chat.', commits: [2, 17] }, { title: 'Inventata', summary: 'Niente.', commits: [5] }] }, finishReason: 'stop', model: 'm' }) },
      OPENWORK,
      EMPTY,
    );
    assert.equal(state.news?.source, 'model');
    assert.deepEqual(state.news.items.map((item) => [item.title, item.commits.map((commit) => commit.sha)]), [['Note vocali', [sha(1)]]]);
  });

  it('a model answer that fails the checks falls back to the raw list', async () => {
    const github = fakeGithub({ '/repos/different-ai/openwork/releases': releases('v2', 'v1'), '/repos/different-ai/openwork/compare/': compare(['feat: a']) });
    const state = await checkProject({ ...github, summarize: () => Promise.resolve({ value: { items: [{ title: 'x', summary: 'y', commits: [9] }] }, finishReason: 'stop', model: 'm' }) }, OPENWORK, EMPTY);
    assert.equal(state.news?.source, 'raw');
    assert.match(state.news.message ?? '', /non ha passato i controlli/);
  });

  it('nothing new: the news and the release seen stay', async () => {
    const github = fakeGithub({ '/repos/different-ai/openwork/releases': releases('v2', 'v1') });
    const first = await checkProject({ ...fakeGithub({ '/repos/different-ai/openwork/releases': releases('v2', 'v1'), '/repos/different-ai/openwork/compare/': compare(['feat: a']) }) }, OPENWORK, EMPTY);
    const again = await checkProject({ ...github, now: NOW }, OPENWORK, first);
    assert.equal(again.seen, 'v2');
    assert.deepEqual(again.news, first.news);
    assert.match(again.message ?? '', /Nessuna release nuova dopo v2/);
    assert.equal(github.asked.length, 1);
  });

  it('a network error never throws and keeps the release seen', async () => {
    const github = fakeGithub({ '/repos/different-ai/openwork/releases': new GithubError('upstream', 'api.github.com cannot be reached') });
    const before: ProjectState = { ...EMPTY, seen: 'v1' };
    const state = await checkProject({ ...github, now: NOW }, OPENWORK, before);
    assert.equal(state.seen, 'v1');
    assert.equal(state.checkedAt, NOW().toISOString());
    assert.match(state.message ?? '', /GitHub non è raggiungibile/);
  });

  it('a refusal of the gateway asks nothing of GitHub', async () => {
    let fetched = false;
    const state = await checkProject(
      {
        gateway: () => Promise.reject(new Error('blocked by the gateway')),
        get: () => {
          fetched = true;
          return Promise.resolve([]);
        },
      },
      OPENWORK,
      EMPTY,
    );
    assert.equal(fetched, false);
    assert.match(state.message ?? '', /gateway/);
  });

  it('a tag that could change the path is never used', async () => {
    const github = fakeGithub({ '/repos/different-ai/openwork/releases': releases('../../x', 'v1') });
    const state = await checkProject(github, OPENWORK, EMPTY);
    assert.equal(state.seen, 'v1');
    assert.equal(github.asked.some((address) => address.includes('..')), false);
  });

  it('no releases: no news', async () => {
    const state = await checkProject(fakeGithub({ '/repos/different-ai/openwork/releases': [] }), OPENWORK, EMPTY);
    assert.equal(state.news, null);
    assert.match(state.message ?? '', /non ha release/);
  });
});

describe('the state file of a project', () => {
  it('refuses a release or a repository that could not be written in a line of the code', async () => {
    const good = await checkProject(fakeGithub({ '/repos/different-ai/openwork/releases': releases('v2', 'v1'), '/repos/different-ai/openwork/compare/': compare(['feat: a']) }), OPENWORK, EMPTY);
    assert.ok(good.news !== null);
    assert.deepEqual(parseState(JSON.parse(JSON.stringify(good)) as unknown, OPENWORK.id), good);
    assert.equal(parseState({ ...good, news: { ...good.news, to: 'v2\n## 2026 · x · nuova' } }, OPENWORK.id), undefined);
    assert.equal(parseState({ ...good, news: { ...good.news, from: '../x' } }, OPENWORK.id), undefined);
    assert.equal(parseState({ ...good, news: { ...good.news, repository: 'other/repo' } }, OPENWORK.id), undefined);
    assert.equal(parseState(good, 'other/repo'), undefined);
  });

  it('says when releases exist but none has a tag it can use', async () => {
    const state = await checkProject(fakeGithub({ '/repos/different-ai/openwork/releases': releases('release/1.0', '@scope/pkg@1') }), OPENWORK, EMPTY);
    assert.match(state.message ?? '', /nomi che non so usare/);
  });
});

function deps(dir: string, answers: Record<string, unknown> = {}): FollowedDeps {
  return { dir, ...fakeGithub(answers) };
}

describe('the list of the projects', () => {
  it('follows OpenWork by default, Open Design always through its catalog', () => {
    const projects = createFollowedProjects(deps(join(scratch, randomUUID())));
    assert.deepEqual(
      projects.list().map((project) => [project.id, project.catalog]),
      [
        ['nexu-io/open-design', true],
        ['different-ai/openwork', false],
      ],
    );
  });

  it('adds and removes a GitHub repository, refuses anything else', () => {
    const dir = join(scratch, randomUUID());
    const projects = createFollowedProjects(deps(dir));
    projects.add('https://github.com/Example/Tool.git');
    assert.ok(projects.list().some((project) => project.id === 'example/tool'));
    for (const bad of ['https://gitlab.com/a/b', 'http://github.com/a/b', 'https://github.com/a/b/c', 'file:///tmp/a/b', 42]) {
      assert.throws(() => projects.add(bad), (error: unknown) => error instanceof CatalogError && error.code === 'invalid', String(bad));
    }
    assert.throws(() => projects.add('https://github.com/example/tool'), (error: unknown) => error instanceof CatalogError && error.code === 'conflict');
    assert.throws(() => projects.add('https://github.com/nexu-io/open-design'), (error: unknown) => error instanceof CatalogError && error.code === 'conflict');
    assert.throws(() => projects.remove('nexu-io/open-design'), (error: unknown) => error instanceof CatalogError && error.code === 'conflict');
    projects.remove('https://github.com/different-ai/openwork');
    assert.deepEqual(
      projects.list().map((project) => project.id),
      ['nexu-io/open-design', 'example/tool'],
    );
    // Removed by the user, the default is not added back.
    assert.equal(createFollowedProjects(deps(dir)).list().length, 2);
    assert.throws(() => projects.remove('different-ai/openwork'), (error: unknown) => error instanceof CatalogError && error.code === 'not-found');
  });

  it(`follows at most ${String(MAX_PROJECTS)} projects`, () => {
    const projects = createFollowedProjects(deps(join(scratch, randomUUID())));
    for (let index = 1; index < MAX_PROJECTS; index += 1) projects.add(`https://github.com/owner/repo-${String(index)}`);
    assert.throws(() => projects.add('https://github.com/owner/one-more'), (error: unknown) => error instanceof CatalogError && error.code === 'invalid');
  });

  it('ignores a list file written by hand with a foreign address', () => {
    const dir = join(scratch, randomUUID());
    mkdirSync(join(dir, FOLLOWED_FOLDER), { recursive: true });
    writeFileSync(
      join(dir, FOLLOWED_FOLDER, 'projects.json'),
      JSON.stringify({ version: 1, projects: [{ id: 'a/b', page: 'https://evil.example/a/b', addedAt: 'x' }, { id: 'c/d', page: 'https://github.com/c/d', addedAt: 'x' }] }),
    );
    assert.deepEqual(
      createFollowedProjects(deps(dir)).list().map((project) => project.id),
      ['nexu-io/open-design', 'c/d'],
    );
  });

  it('checks in the background and keeps the news for the page', async () => {
    const dir = join(scratch, randomUUID());
    const events: string[] = [];
    const projects = createFollowedProjects({
      ...deps(dir, { '/repos/different-ai/openwork/releases': releases('v2', 'v1'), '/repos/different-ai/openwork/compare/': compare(['feat: a']) }),
      onEvent: (kind) => events.push(kind),
    });
    projects.check('different-ai/openwork');
    assert.equal(projects.list()[1]?.checking, true);
    assert.throws(
      () => {
        projects.check('different-ai/openwork');
      },
      (error: unknown) => error instanceof CatalogError && error.code === 'conflict');
    await projects.idle();
    const view = projects.list()[1];
    assert.equal(view?.checking, false);
    assert.equal(view.seen, 'v2');
    assert.ok(view.news !== null);
    assert.equal(view.news.items.length, 1);
    assert.deepEqual(events, ['followed.checked']);
    const key = view.news.items[0]?.key ?? '';
    assert.equal(projects.findItem(key)?.item.title, 'feat: a');
    assert.equal(projects.findItem('gh-different-ai__openwork-0000000'), undefined);
    assert.equal(existsSync(join(dir, FOLLOWED_FOLDER, 'different-ai__openwork.busy')), false);
  });
});

const GATE: AnswerGate = (answer) => {
  const decision = gatewayCheck([{ value: answer, label: 'L1', source: 'dev:answer' }], createContext('L1'), { kind: 'executor', id: 'claude', locality: 'cloud' }, secretMatcher([]));
  if (decision.decision !== 'allow') return Promise.resolve({ allow: false, reason: decision.rule });
  return Promise.resolve({ allow: true, text: decision.texts[0] ?? '' });
};

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function send(port: number, method: string, path: string, body?: unknown): Promise<Reply> {
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

describe('the routes of the projects', () => {
  it('lists, checks, and writes a choice once in RISPOSTE.md', async (t) => {
    const home = join(scratch, randomUUID());
    mkdirSync(join(home, 'docs'), { recursive: true });
    const projects = createFollowedProjects(deps(join(home, 'data', 'catalogs'), { '/repos/different-ai/openwork/releases': releases('v2', 'v1'), '/repos/different-ai/openwork/compare/': compare(['feat: voice notes', 'fix: crash']) }));
    const recorded: string[] = [];
    const server = await startApiServer({
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      devProgress: {
        home,
        gate: GATE,
        projects,
        projectRecorded: (key, choice) => {
          recorded.push(`${key}:${choice}`);
          return Promise.resolve();
        },
      },
    });
    t.after(() => server.close());

    assert.equal((await send(server.port, 'POST', '/api/dev/projects/check', { id: 'different-ai/openwork' })).status, 202);
    await projects.idle();
    const listed = (await send(server.port, 'GET', '/api/dev/projects')).body as { projects: { id: string; news: { items: { key: string; answer: unknown }[] } | null }[]; max: number };
    assert.equal(listed.max, MAX_PROJECTS);
    const items = listed.projects[1]?.news?.items ?? [];
    assert.equal(items.length, 2);
    assert.equal(items[0]?.answer, null);

    const [first, second] = items.map((item) => item.key);
    assert.equal((await send(server.port, 'POST', '/api/dev/projects/choice', { key: first, choice: 'implement' })).status, 201);
    assert.equal((await send(server.port, 'POST', '/api/dev/projects/choice', { key: second, choice: 'skip' })).status, 201);
    assert.equal((await send(server.port, 'POST', '/api/dev/projects/choice', { key: first, choice: 'skip' })).status, 200);
    assert.deepEqual(recorded, [`${first ?? ''}:implement`, `${second ?? ''}:skip`]);
    const file = readFileSync(join(home, ANSWERS_FILE), 'utf8');
    assert.deepEqual(
      parseAnswers(file).map((entry) => [entry.key, entry.state]),
      [
        [first, 'new'],
        [second, 'new'],
      ],
    );
    assert.match(file, /different-ai\/openwork, release v1 → v2/);
    assert.match(file, /\*\*Richiesta\*\*: implementiamo/);
    assert.match(file, /\*\*Richiesta\*\*: non interessa/);
    assert.match(file, /> feat: voice notes/);
    const after = (await send(server.port, 'GET', '/api/dev/projects')).body as { projects: { news: { items: { answer: { state: string } | null }[] } | null }[] };
    assert.equal(after.projects[1]?.news?.items[0]?.answer?.state, 'new');

    assert.equal((await send(server.port, 'POST', '/api/dev/projects/choice', { key: first, choice: 'maybe' })).status, 400);
    assert.equal((await send(server.port, 'POST', '/api/dev/projects/choice', { key: 'od-abc1234', choice: 'skip' })).status, 400);
    assert.equal((await send(server.port, 'POST', '/api/dev/projects/choice', { key: 'gh-different-ai__openwork-fffffff', choice: 'skip' })).status, 404);
    assert.equal((await send(server.port, 'POST', '/api/dev/projects', { url: 'https://gitlab.com/a/b' })).status, 400);
    assert.equal((await send(server.port, 'POST', '/api/dev/projects', { url: 'https://github.com/a/b' })).status, 201);
    assert.equal((await send(server.port, 'DELETE', '/api/dev/projects', { id: 'a/b' })).status, 200);
    assert.equal((await send(server.port, 'POST', '/api/dev/projects/check', { id: 'nexu-io/open-design' })).status, 409);
  });

  it('a refusal of the gateway writes nothing and records no event; two choices at once write one entry', async (t) => {
    const home = join(scratch, randomUUID());
    mkdirSync(join(home, 'docs'), { recursive: true });
    // A news whose commit carries an IBAN: the gateway towards Claude Code refuses it.
    const projects = createFollowedProjects(deps(join(home, 'data', 'catalogs'), { '/repos/different-ai/openwork/releases': releases('v2', 'v1'), '/repos/different-ai/openwork/compare/': compare(['feat: pay IT60X0542811101000000123456', 'feat: b']) }));
    projects.check('different-ai/openwork');
    await projects.idle();
    const recorded: string[] = [];
    const server = await startApiServer({
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      devProgress: {
        home,
        gate: GATE,
        projects,
        projectRecorded: (key) => {
          recorded.push(key);
          return Promise.resolve();
        },
      },
    });
    t.after(() => server.close());
    const items = projects.list()[1]?.news?.items ?? [];
    const blocked = items.find((item) => item.title.includes('IBAN') || item.title.includes('IT60'));
    const clean = items.find((item) => item !== blocked);
    assert.ok(blocked !== undefined && clean !== undefined);
    assert.equal((await send(server.port, 'POST', '/api/dev/projects/choice', { key: blocked.key, choice: 'implement' })).status, 422);
    assert.equal(existsSync(join(home, ANSWERS_FILE)), false);
    assert.deepEqual(recorded, []);

    const replies = await Promise.all([send(server.port, 'POST', '/api/dev/projects/choice', { key: clean.key, choice: 'implement' }), send(server.port, 'POST', '/api/dev/projects/choice', { key: clean.key, choice: 'skip' })]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 201]);
    assert.equal(parseAnswers(readFileSync(join(home, ANSWERS_FILE), 'utf8')).length, 1);
    assert.deepEqual(recorded, [clean.key]);
  });

  it('keeps the key of a project news in the event', () => {
    assert.equal(eventKey('gh-different-ai__openwork-abc1234'), 'gh-different-ai__openwork-abc1234');
    assert.match(eventKey('gh-x'), /^sha256:/);
  });
});
