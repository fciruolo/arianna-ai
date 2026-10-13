// The Archivist A1 (D-195) with the database: the proposal follows the
// organizing on the same queue, passes the gateway towards the local model
// only, and is written in the note; the routes list, approve (with the
// version the page saw), discard and propose again; the events carry no path,
// title or folder. The model is a fake: no oMLX.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { ARCHIVE_SCHEMA_NAME, enqueueArchive, notesToPropose, proposeArchive, readProposal, recordRelocated, relocateArchived } from '../src/archivist.ts';
import { captureNote } from '../src/capture.ts';
import { verifyEventChain } from '../src/events.ts';
import type { LiveFeed } from '../src/live.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createNoteOrganizer, enqueueOrganize, ORGANIZE_QUEUE } from '../src/organize.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
const scratch = join(resolveHome({}), 'data', 'test-tmp', `archivist-db-${randomUUID()}`);
const RULES = parseLabelRules('[[folder]]\npath = "kb/public"\nlabel = "L0"\n\n[[folder]]\npath = "kb/private"\nlabel = "L2"\n');

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function setup(): string {
  const home = join(scratch, randomUUID());
  write(home, {
    'kb/private/casa/balcone.md': '---\ntitle: Balcone finto\n---\n\nIl balcone finto va sistemato, serve un ombrellone.\n',
    'kb/public/ricette/torta.md': '# Torta finta\n',
  });
  return home;
}

const ORGANIZED = { title: 'Ombrellone', summary: 'Comprare un ombrellone per il balcone.', context: '', tags: ['casa'], kind: 'idea' };
const PROPOSED = { folder: 'private/casa', title: 'Ombrellone per il balcone', links: ['private/casa/balcone'], reason: 'Un acquisto per la casa.' };

function fakeModel(requests: ChatRequest[]): LocalModel {
  return {
    chat(request) {
      requests.push(request);
      const value = request.schema?.name === ARCHIVE_SCHEMA_NAME ? PROPOSED : ORGANIZED;
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

function env(home: string, model: LocalModel) {
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
const reproposed: string[] = [];
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
      archive: (path) => {
        reproposed.push(path);
        return enqueueArchive(db().sql, path, true);
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

test('after the organizing, the Archivist proposes on the same queue, through the gateway to the local model only', async () => {
  const { sql } = db();
  const home = setup();
  const requests: ChatRequest[] = [];
  const note = captureNote({ home, rules: RULES, text: 'Idea: un ombrellone per il balcone di casa', kind: 'thought', source: { channel: 'hud', id: 'test' }, now: new Date(2026, 9, 13, 8, 0) });
  const before = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM gateway_log`)[0]?.n ?? 0;
  const model = fakeModel(requests);
  const archiveEnv = env(home, model);
  const organizer = createNoteOrganizer({
    ...archiveEnv,
    busy: () => Promise.resolve(false),
    pollMs: 20,
    archive: {
      propose: (path, signal, force) => proposeArchive(archiveEnv, path, signal, force),
      enqueue: (tx, path) => enqueueArchive(tx, path),
      waiting: () => notesToPropose(home, RULES, 20),
    },
  });
  try {
    await organizer.start();
    await waitFor(async () => (await sql`SELECT 1 FROM events WHERE kind = 'note.archive_proposed'`).length === 1);
  } finally {
    await organizer.stop();
  }
  assert.deepEqual(
    requests.map((request) => request.schema?.name),
    ['organized_note', ARCHIVE_SCHEMA_NAME],
  );
  // The folders are offered as an enum: the model cannot name another.
  const schema = requests[1]?.schema?.schema as { properties: { folder: { enum: string[] } } };
  assert.deepEqual(schema.properties.folder.enum, ['private', 'private/casa', 'public', 'public/ricette']);
  const raw = readFileSync(join(home, note.path), 'utf8');
  const proposal = readProposal(raw);
  assert.equal(proposal?.state, 'proposed');
  assert.equal(proposal.folder, 'kb/private/casa');
  assert.deepEqual(proposal.links, ['kb/private/casa/balcone.md']);
  // Only towards the local executor.
  const rows = await sql<{ locality: string; decision: string }[]>`SELECT locality, decision FROM gateway_log ORDER BY id OFFSET ${before}`;
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.locality === 'local' && row.decision === 'allow'));
  const [event] = await sql<{ label: string; payload: Record<string, unknown> }[]>`SELECT label, payload FROM events WHERE kind = 'note.archive_proposed'`;
  assert.equal(event?.label, 'L0');
  assert.deepEqual(Object.keys(event.payload).sort(), ['jobId', 'links']);
  assert.equal((await sql`SELECT 1 FROM events WHERE payload::text LIKE '%ombrellone%' OR payload::text LIKE '%casa%'`).length, 0);
});

test('a model that fails leaves the note in the inbox with an event that names only the reason', async () => {
  const { sql } = db();
  const home = setup();
  const note = captureNote({ home, rules: RULES, text: 'Un pensiero finto', kind: 'thought', source: { channel: 'hud', id: 'test' }, now: new Date(2026, 9, 13, 9, 0) });
  const raw = readFileSync(join(home, note.path), 'utf8').replace('status: new', 'status: organized');
  writeFileSync(join(home, note.path), raw);
  const bad: LocalModel = { chat: () => Promise.resolve({ text: '{}', value: { folder: 'altrove', title: 'x', links: [], reason: '' }, finishReason: 'stop', endpoint: 'stub', model: 'stub', durationMs: 1 }) };
  const outcome = await proposeArchive(env(home, bad), note.path, new AbortController().signal);
  assert.deepEqual(outcome, { ok: false, reason: 'bad-response' });
  assert.equal(readFileSync(join(home, note.path), 'utf8'), raw);
  assert.equal((await sql`SELECT 1 FROM jobs WHERE queue = ${ORGANIZE_QUEUE} AND payload ->> 'path' = ${note.path}`).length, 0);
});

test('the routes: list, approve with the version seen, discard, propose again; events without names', async () => {
  const { sql } = db();
  const requests: ChatRequest[] = [];
  const make = async (text: string, minute: number): Promise<string> => {
    const note = captureNote({ home: serverHome, rules: RULES, text, kind: 'thought', source: { channel: 'hud', id: 'test' }, now: new Date(2026, 9, 13, 10, minute) });
    const file = join(serverHome, note.path);
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: new', 'status: organized'));
    assert.deepEqual(await proposeArchive(env(serverHome, fakeModel(requests)), note.path, new AbortController().signal), { ok: true, links: 1 });
    return note.path.split('/').at(-1) ?? '';
  };
  const first = await make('Ombrellone per il balcone, finto', 1);
  const second = await make('Ombrellone da spiaggia, finto', 2);

  const listed = await send('GET', '/api/archive');
  assert.equal(listed.status, 200);
  const proposals = listed.body.proposals as { name: string; version: string; folder: string; state: string }[];
  assert.deepEqual(proposals.map((item) => item.name).sort(), [first, second].sort());
  assert.ok((listed.body.folders as { path: string }[]).some((folder) => folder.path === 'kb/public/ricette'));
  const one = proposals.find((item) => item.name === first);
  const two = proposals.find((item) => item.name === second);
  assert.ok(one !== undefined && two !== undefined);

  // Unknown fields and a stale version are refused; the second note is corrected to another folder.
  assert.equal((await send('POST', '/api/archive/approve', { items: [{ name: first, version: one.version, label: 'L0' }] })).status, 400);
  const stale = await send('POST', '/api/archive/approve', { items: [{ name: first, version: 'c'.repeat(64) }] });
  assert.deepEqual((stale.body.results as { code: string }[]).map((result) => result.code), ['changed']);
  const outside = await send('POST', '/api/archive/approve', { items: [{ name: first, version: one.version, folder: 'kb/../data' }] });
  assert.deepEqual((outside.body.results as { code: string }[]).map((result) => result.code), ['folder']);

  const approved = await send('POST', '/api/archive/approve', {
    items: [
      { name: first, version: one.version },
      { name: second, version: two.version, folder: 'kb/public/ricette', title: 'Ombrellone da spiaggia', links: [] },
    ],
  });
  assert.equal(approved.status, 200);
  const results = approved.body.results as { name: string; ok: boolean; path: string }[];
  assert.deepEqual(
    results.map((result) => [result.ok, result.path]),
    [
      [true, `kb/archivio/private/casa/${first}`],
      [true, `kb/archivio/public/ricette/${second}`],
    ],
  );
  assert.equal(existsSync(join(serverHome, 'kb', 'inbox', first)), false);
  // In a folder labeled L0 the note is still L2.
  assert.match(readFileSync(join(serverHome, 'kb', 'archivio', 'public', 'ricette', second), 'utf8'), /^---\nlabel: L2\n/);
  const events = await sql<{ label: string; payload: Record<string, unknown> }[]>`SELECT label, payload FROM events WHERE kind = 'note.archived' ORDER BY id`;
  assert.deepEqual(
    events.map((event) => [event.label, event.payload.corrected]),
    [
      ['L0', false],
      ['L0', true],
    ],
  );

  // Discard, then "Proponi di nuovo".
  const third = await make('Ombrellone rotto, finto', 3);
  const [item] = ((await send('GET', '/api/archive')).body.proposals as { name: string; version: string }[]).filter((proposal) => proposal.name === third);
  assert.ok(item !== undefined);
  assert.equal((await send('POST', '/api/archive/discard', { name: third, version: item.version })).status, 200);
  assert.equal(((await send('GET', '/api/archive')).body.proposals as unknown[]).length, 0);
  assert.equal((await send('POST', `/api/notes/${third}/archive`, {})).status, 202);
  assert.deepEqual(reproposed, [`kb/inbox/${third}`]);
  const [job] = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM jobs WHERE queue = ${ORGANIZE_QUEUE} AND key = ${`note-archive-again:kb/inbox/${third}`}`;
  assert.deepEqual(job?.payload, { path: `kb/inbox/${third}`, archive: true, force: true });
  await sql`UPDATE jobs SET status = 'done' WHERE queue = ${ORGANIZE_QUEUE} AND status = 'queued'`;

  assert.equal((await sql`SELECT 1 FROM events WHERE kind LIKE 'note.archive%' AND (payload::text LIKE '%ombrellone%' OR payload::text LIKE '%kb/%')`).length, 0);
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
});

test('a new note is not proposed through the route, and an organize job queued earlier is untouched', async () => {
  const note = captureNote({ home: serverHome, rules: RULES, text: 'Pensiero finto nuovo', kind: 'thought', source: { channel: 'hud', id: 'test' }, now: new Date(2026, 9, 13, 11, 0) });
  await enqueueOrganize(db().sql, note.path);
  assert.equal((await send('POST', `/api/notes/${note.path.split('/').at(-1) ?? ''}/archive`, {})).status, 409);
  await db().sql`UPDATE jobs SET status = 'done' WHERE queue = ${ORGANIZE_QUEUE} AND status = 'queued'`;
});

test('at start a note approved before D-198 moves to kb/archivio, with an L0 event of counts only', async () => {
  const home = setup();
  const name = '2026-10-13-120000-ombrellone-vecchio.md';
  write(home, { [`kb/private/finanze/${name}`]: '---\nlabel: L2\ncaptured_at: 2026-10-13T12:00:00+02:00\ntitle: "Ombrellone vecchio"\narchived_at: 2026-10-13T12:05:00+02:00\n---\n\nPensiero finto già archiviato.\n' });
  const relocated = relocateArchived(home, RULES);
  assert.deepEqual(relocated, { moved: 1, left: 0 });
  await recordRelocated(db().sql, relocated);
  assert.equal(existsSync(join(home, 'kb', 'archivio', 'private', 'finanze', name)), true);
  assert.equal(existsSync(join(home, 'kb', 'private', 'casa', 'balcone.md')), true);
  const events = await db().sql<{ label: string; payload: Record<string, unknown> }[]>`SELECT label, payload FROM events WHERE kind = 'note.archive_relocated'`;
  assert.deepEqual(
    events.map((event) => [event.label, event.payload]),
    [['L0', { moved: 1, left: 0 }]],
  );
});
