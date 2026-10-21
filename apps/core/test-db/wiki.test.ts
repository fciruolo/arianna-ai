// The Wiki (D-280) with the database: a proposal from a note runs on the
// queue of the organizer, passes the gateway towards the local model only,
// cites only the notes given and is stored as a proposal, never as a page;
// the routes list, approve (an index «In breve» queued), discard, propose
// again, move and restore; after a note filed by the Archivist a proposal is
// queued, never for a video; the events carry codes and counts only. The
// model is a fake: no oMLX.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { withProposal } from '../src/archivist.ts';
import type { LiveFeed } from '../src/live.ts';
import { sha256 } from '../src/notes.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createNoteOrganizer, ORGANIZE_QUEUE } from '../src/organize.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { allProposals, composeWikiPage, enqueueWikiIndex, enqueueWikiNote, proposeFromNote, runWikiJob, type WikiEnv } from '../src/wiki.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
const scratch = join(resolveHome({}), 'data', 'test-tmp', `wiki-db-${randomUUID()}`);
const RULES = parseLabelRules('[[folder]]\npath = "kb/public"\nlabel = "L0"\n\n[[folder]]\npath = "kb/private"\nlabel = "L2"\n');
const NAME = '2026-10-21-100000-octane.md';

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function note(title: string, text: string, extra: string[] = []): string {
  return ['---', 'label: L2', 'source: capture:hud:test', 'captured_at: 2026-10-21T10:00:00+02:00', 'kind: appunto', 'status: organized', `title: ${JSON.stringify(title)}`, 'tags: ["laravel"]', 'organized_at: 2026-10-21T10:01:00+02:00', 'model: local-large', ...extra, '---', '', '## Riassunto', '', text, '', '## Contesto', '', 'Nessun collegamento.', '', '## Testo originale', '', text, ''].join('\n');
}

function setup(): string {
  const home = join(scratch, randomUUID());
  write(home, {
    [`kb/inbox/${NAME}`]: note('Octane e Swoole', 'Octane con Swoole tiene viva l\'applicazione; dopo il deploy i worker di Swoole vanno riavviati. Nota inventata.'),
    'kb/private/laravel/deploy.md': '---\ntitle: Deploy finto di Laravel\n---\n\nDopo il deploy di Laravel con Octane si riavviano i worker.\n',
    'kb/public/ricette/torta.md': '# Torta finta\n',
  });
  return home;
}

const CREATE = {
  action: 'create',
  page: '',
  path: 'Laravel/Octane/Swoole',
  title: 'Swoole con Octane',
  summary: 'Octane tiene viva l\'applicazione Laravel fra le richieste, anche con Swoole.',
  points: [
    { text: 'Dopo un deploy i worker di Swoole vanno riavviati.', sources: ['nota-1', 'nota-2'], replaces: 0 },
    { text: 'Una citazione che non esiste: <img src=x> ![a](https://esempio.invalid/a.png) [[private/segreta]]', sources: ['nota-1'], replaces: 0 },
  ],
  questions: ['Serve anche RoadRunner?'],
  related: [],
  reason: 'Un fatto tecnico da tenere.',
};

function fakeModel(requests: ChatRequest[], answer: (request: ChatRequest) => unknown): LocalModel {
  return {
    chat(request) {
      requests.push(request);
      const value = answer(request);
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

function env(home: string, model: LocalModel): WikiEnv {
  return { sql: db().sql, home, rules: RULES, kb: createKb({ home, rules: RULES }), model: () => model };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let server: ApiServer;
let serverHome: string;
const proposed: { page: string; force: boolean }[] = [];
const indexed: string[] = [];
before(async () => {
  database = await createTestDatabase();
  serverHome = setup();
  server = await startApiServer({
    sql: db().sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    capture: {
      home: serverHome,
      rules: RULES,
      wiki: {
        propose: (page, force) => {
          proposed.push({ page, force });
          return Promise.resolve(true);
        },
        index: (folder) => {
          indexed.push(folder);
          return Promise.resolve(true);
        },
      },
    },
  });
});
after(async () => {
  await server.close();
  await database?.close();
  rmSync(scratch, { recursive: true, force: true });
});

function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const origin = `http://127.0.0.1:${String(server.port)}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      { method, agent: false, headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { origin }) } },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text || '{}') as Record<string, unknown> });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

test('a proposal from a note runs on the queue of the organizer, through the gateway to the local model only', async () => {
  const { sql } = db();
  const home = setup();
  const requests: ChatRequest[] = [];
  const model = fakeModel(requests, (request) => (request.schema?.name === 'wiki_index' ? { summary: 'Appunti finti su Laravel.' } : CREATE));
  const wikiEnv = env(home, model);
  const before = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM gateway_log`)[0]?.n ?? 0;
  const organizer = createNoteOrganizer({ ...wikiEnv, busy: () => Promise.resolve(false), pollMs: 20, wiki: { run: (payload, signal) => runWikiJob(wikiEnv, payload, signal) } });
  try {
    assert.equal(await enqueueWikiNote(sql, `inbox/${NAME}`), true);
    await organizer.start();
    await waitFor(async () => (await sql`SELECT 1 FROM events WHERE kind = 'wiki.proposed'`).length === 1);
  } finally {
    await organizer.stop();
  }
  assert.deepEqual(requests.map((request) => request.schema?.name), ['wiki_proposal']);
  // The notes are offered as an enum of ids: the model cannot cite another.
  const schema = requests[0]?.schema?.schema as { properties: { points: { items: { properties: { sources: { items: { enum: string[] } } } } } } };
  assert.deepEqual(schema.properties.points.items.properties.sources.items.enum, ['nota-1', 'nota-2']);
  // Never a page yet: a proposal.
  assert.equal(existsSync(join(home, 'kb/wiki/laravel/octane/swoole.md')), false);
  const [stored] = allProposals(home);
  assert.equal(stored?.kind, 'create');
  assert.equal(stored.path, 'laravel/octane/swoole');
  assert.equal(stored.source, `inbox/${NAME}`);
  assert.match(stored.content, /- Dopo un deploy i worker di Swoole vanno riavviati\. \[\[inbox\/2026-10-21-100000-octane\]\] \[\[private\/laravel\/deploy\]\]/);
  // The text of the model is inert: no image, HTML or wikilink of its own.
  assert.doesNotMatch(stored.content, /<img|!\[a\]|\[\[private\/segreta/);
  const rows = await sql<{ locality: string; decision: string }[]>`SELECT locality, decision FROM gateway_log ORDER BY id OFFSET ${before}`;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row.locality === 'local' && row.decision === 'allow'));
  const [event] = await sql<{ label: string; payload: Record<string, unknown> }[]>`SELECT label, payload FROM events WHERE kind = 'wiki.proposed'`;
  assert.equal(event?.label, 'L0');
  assert.deepEqual(event.payload, { jobId: event.payload.jobId, action: 'create', points: 2, citations: 3 });
  assert.equal((await sql`SELECT 1 FROM events WHERE payload::text LIKE '%octane%' OR payload::text LIKE '%laravel%'`).length, 0);
  // A second proposal from the same note waits for the first: skipped, unless asked again.
  assert.deepEqual(await proposeFromNote(wikiEnv, `inbox/${NAME}`, new AbortController().signal), { ok: false, reason: 'skip' });
});

test('an existing page is updated, never a point removed; "none" stores nothing; a bad answer fails with its code', async () => {
  const home = setup();
  write(home, {
    'kb/wiki/laravel/octane/swoole.md': composeWikiPage(
      { title: 'Swoole con Octane', summary: 'Octane su Swoole.', points: [{ text: 'Octane usa Swoole o RoadRunner.', sources: ['private/laravel/deploy'] }], questions: [], sources: ['private/laravel/deploy'], related: [] },
      new Date(),
    ),
  });
  const requests: ChatRequest[] = [];
  const update = { ...CREATE, action: 'update', page: 'laravel/octane/swoole', path: '', summary: '', points: [{ text: 'Octane usa Swoole, RoadRunner o FrankenPHP.', sources: ['nota-1'], replaces: 1 }] };
  const outcome = await proposeFromNote(env(home, fakeModel(requests, () => update)), `inbox/${NAME}`, new AbortController().signal);
  assert.deepEqual(outcome, { ok: true, action: 'update', points: 1, citations: 1 });
  // The page was offered with its points numbered.
  assert.match(requests[0]?.messages[1]?.content ?? '', /"1\. Octane usa Swoole o RoadRunner\."/);
  const [stored] = allProposals(home);
  assert.equal(stored?.kind, 'update');
  assert.equal(stored.base, sha256(readFileSync(join(home, 'kb/wiki/laravel/octane/swoole.md'), 'utf8')));
  assert.match(stored.content, /- Octane usa Swoole, RoadRunner o FrankenPHP\. \[\[private\/laravel\/deploy\]\] \[\[inbox\/2026-10-21-100000-octane\]\]/);

  const other = setup();
  assert.deepEqual(await proposeFromNote(env(other, fakeModel([], () => ({ ...CREATE, action: 'none' }))), `inbox/${NAME}`, new AbortController().signal), { ok: true, action: 'none', points: 0, citations: 0 });
  assert.deepEqual(allProposals(other), []);
  assert.deepEqual(await proposeFromNote(env(other, fakeModel([], () => ({ ...CREATE, action: 'update', page: 'inventata' }))), `inbox/${NAME}`, new AbortController().signal), { ok: false, reason: 'bad-response' });
  assert.deepEqual(await proposeFromNote(env(other, fakeModel([], () => CREATE)), 'wiki/laravel/x.md', new AbortController().signal), { ok: false, reason: 'not-found' });
});

test('the «In breve» of an index is written by the local model', async () => {
  const home = setup();
  write(home, { 'kb/wiki/laravel/swoole.md': composeWikiPage({ title: 'Swoole', summary: 'Octane su Swoole.', points: [{ text: 'Un fatto.', sources: ['private/laravel/deploy'] }], questions: [], sources: ['private/laravel/deploy'], related: [] }, new Date()) });
  const outcome = await runWikiJob(env(home, fakeModel([], () => ({ summary: 'Appunti finti su Laravel e Octane.' }))), { wiki: 'index', folder: 'laravel' }, new AbortController().signal);
  assert.deepEqual(outcome, { ok: true, event: { kind: 'wiki.index_written', payload: {} } });
  assert.match(readFileSync(join(home, 'kb/wiki/laravel/_indice.md'), 'utf8'), /## In breve\n\nAppunti finti su Laravel e Octane\.\n/);
  assert.equal(await enqueueWikiIndex(db().sql, '../x'), false);
});

test('the routes: tree, proposals with diff, approve with a path, discard, again, propose, move, restore; events without names', async () => {
  const { sql } = db();
  const make = async (): Promise<string> => {
    const outcome = await proposeFromNote(env(serverHome, fakeModel([], () => CREATE)), `inbox/${NAME}`, new AbortController().signal, true);
    assert.equal(outcome.ok, true);
    const latest = allProposals(serverHome).at(-1);
    assert.ok(latest !== undefined);
    return latest.id;
  };
  const first = await make();
  const listed = await send('GET', '/api/wiki/proposals');
  const proposals = listed.body.proposals as { id: string; state: string; diff: { added: number }; source: { title: string } | null }[];
  const [shown] = proposals;
  assert.ok(proposals.length === 1 && shown !== undefined);
  assert.equal(shown.state, 'fresh');
  assert.ok(shown.diff.added > 5);
  assert.equal(shown.source?.title, 'Octane e Swoole');
  assert.equal((await send('POST', `/api/wiki/proposals/${first}/approve`, { path: 'laravel/swoole', label: 'L0' })).status, 400);
  assert.equal((await send('POST', `/api/wiki/proposals/${first}/approve`, { path: '../../data/x' })).status, 400);
  const approved = await send('POST', `/api/wiki/proposals/${first}/approve`, { path: 'laravel/swoole' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.path, 'laravel/swoole');
  assert.deepEqual(indexed.sort(), ['', 'laravel']);
  const tree = await send('GET', '/api/wiki');
  assert.deepEqual(tree.body.folders, ['laravel']);
  assert.deepEqual((tree.body.pages as { path: string }[]).map((page) => page.path), ['laravel/swoole']);
  assert.equal(tree.body.proposals, 0);
  const page = await send('GET', '/api/wiki/page?path=laravel/swoole');
  assert.equal((page.body.page as { title: string }).title, 'Swoole con Octane');
  assert.equal((await send('GET', '/api/wiki/page?path=../inbox/x')).status, 404);
  assert.equal((await send('GET', '/api/wiki/page?path=laravel/_indice')).status, 200);

  // A second proposal (the model would create the same page again: an update of it) is discarded; another one asked again.
  const second = await make();
  assert.equal((await send('POST', `/api/wiki/proposals/${second}/discard`, {})).status, 200);
  assert.equal((await send('POST', `/api/wiki/proposals/${second}/discard`, {})).status, 404);
  const third = await make();
  proposed.length = 0;
  assert.equal((await send('POST', `/api/wiki/proposals/${third}/again`, {})).status, 202);
  assert.deepEqual(proposed, [{ page: `inbox/${NAME}`, force: true }]);
  assert.equal((await send('POST', '/api/wiki/propose', { page: 'private/laravel/deploy.md' })).status, 202);
  assert.equal((await send('POST', '/api/wiki/propose', { page: 'wiki/laravel/swoole.md' })).status, 400);
  assert.equal((await send('POST', '/api/wiki/propose', { page: 'private/nessuna.md' })).status, 404);

  // Move: a proposal, then approved.
  const move = await send('POST', '/api/wiki/move', { from: 'laravel', to: 'php' });
  assert.equal(move.status, 201);
  assert.equal((await send('POST', '/api/wiki/move', { from: 'laravel', to: 'php/a/b' })).status, 400);
  assert.equal((await send('POST', `/api/wiki/proposals/${String(move.body.id)}/approve`, {})).status, 200);
  assert.equal(existsSync(join(serverHome, 'kb/wiki/php/swoole.md')), true);

  // Restore: only a version that exists (the restore itself is tested without the database).
  const restoreOf = await send('GET', '/api/wiki/page?path=php/swoole');
  const view = restoreOf.body.page as { version: string; versions: { id: string }[] };
  assert.equal((await send('POST', '/api/wiki/restore', { path: 'php/swoole', version: '20261021-100000-000', base: view.version })).status, 404);

  const events = await sql<{ kind: string; payload: Record<string, unknown> }[]>`SELECT kind, payload FROM events WHERE kind LIKE 'wiki.%' ORDER BY id`;
  assert.ok(events.some((event) => event.kind === 'wiki.approved' && event.payload.corrected === true));
  assert.ok(events.some((event) => event.kind === 'wiki.discarded'));
  assert.ok(events.some((event) => event.kind === 'wiki.move_proposed'));
  assert.equal((await sql`SELECT 1 FROM events WHERE kind LIKE 'wiki.%' AND (payload::text LIKE '%swoole%' OR payload::text LIKE '%laravel%' OR payload::text LIKE '%php%')`).length, 0);
});

test('after a note filed by the Archivist a proposal is queued, never for a video', async () => {
  const home = serverHome;
  const plain = '2026-10-21-110000-coda.md';
  const video = '2026-10-21-120000-video.md';
  const proposal = { folder: 'kb/private/laravel', title: 'Coda finta', links: [], reason: 'Laravel.' };
  write(home, {
    [`kb/inbox/${plain}`]: withProposal(note('Coda finta', 'Le code di Laravel, nota inventata.'), proposal, 'local-large', new Date()),
    [`kb/inbox/${video}`]: withProposal(note('Video finto', 'Un video inventato su Laravel.', ['media: youtube', 'video_id: abcdefghijk']), proposal, 'local-large', new Date()),
  });
  const version = (name: string): string => sha256(readFileSync(join(home, 'kb/inbox', name), 'utf8'));
  proposed.length = 0;
  const approved = await send('POST', '/api/archive/approve', { items: [{ name: plain, version: version(plain) }, { name: video, version: version(video) }] });
  assert.equal(approved.status, 200);
  assert.deepEqual((approved.body.results as { ok: boolean }[]).map((result) => result.ok), [true, true]);
  assert.deepEqual(proposed, [{ page: `archivio/private/laravel/${plain}`, force: false }]);
  assert.equal((await db().sql`SELECT 1 FROM jobs WHERE queue = ${ORGANIZE_QUEUE} AND payload ->> 'wiki' IS NOT NULL AND payload ->> 'page' LIKE '%video%'`).length, 0);
});
