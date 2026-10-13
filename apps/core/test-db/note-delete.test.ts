// "Elimina" of a note through the API (D-157): the file goes, its organizing
// job forgets it, one event without its path, and the search and the graph
// no longer find it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { parseLabelRules, resolveHome, type Project } from '@arianna/config';

import { verifyEventChain } from '../src/events.ts';
import type { LiveFeed } from '../src/live.ts';
import { enqueueOrganize, ORGANIZE_QUEUE } from '../src/organize.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
const HOME = join(resolveHome({}), 'data', 'test-tmp', `note-delete-db-${randomUUID()}`);
const BOX = join(HOME, 'repos', 'progetto-test');
const NOTE = '2026-10-05-0812-pane-integrale.md';

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

write(HOME, {
  [`kb/inbox/${NOTE}`]: '---\nlabel: L2\nstatus: new\n---\n\nComprare il pane integrale finto.\n',
  'kb/altro/ricetta.md': '---\ntitle: Ricetta finta\n---\n\nPane integrale fatto in casa, finto.\n',
  'docs/SPEC.md': '# Documento di sviluppo finto, pane integrale\n',
});
write(BOX, { 'Workplan/piano.md': '# Piano finto\n', 'progetto-test-admin/.git/HEAD': 'ref: refs/heads/main\n' });
const CONTAINERS: Project[] = [{ name: 'progetto-test', path: 'repos/progetto-test', absolute: BOX, label: 'L1' }];

let server: ApiServer;
before(async () => {
  database = await createTestDatabase();
  const rules = parseLabelRules('');
  server = await startApiServer({
    sql: db().sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    capture: { home: HOME, rules },
    projectContainers: () => CONTAINERS,
    knowledge: { home: HOME, rules },
  });
});
after(async () => {
  await server.close();
  await database?.close();
  rmSync(HOME, { recursive: true, force: true });
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

async function found(): Promise<{ notes: string[]; pages: string[]; graph: string[] }> {
  const search = await send('GET', '/api/search?q=integrale');
  const graph = await send('GET', '/api/knowledge/graph');
  return {
    notes: (search.body.notes as { name: string }[]).map((hit) => hit.name),
    pages: (search.body.pages as { id: string }[]).map((hit) => hit.id),
    graph: (graph.body.nodes as { id: string }[]).map((node) => node.id),
  };
}

test('a thought is deleted for good: the file, its organizing, the search and the graph; the event has no path', async () => {
  const { sql, owner } = db();
  await enqueueOrganize(sql, `kb/inbox/${NOTE}`);
  const before = await found();
  assert.ok(before.notes.includes(NOTE));
  assert.ok(before.graph.includes(`inbox/${NOTE}`));

  assert.equal((await send('POST', `/api/notes/${NOTE}/delete`, { force: true })).status, 400);
  const deleted = await send('POST', `/api/notes/${NOTE}/delete`, {});
  assert.equal(deleted.status, 200);
  assert.equal(existsSync(join(HOME, 'kb', 'inbox', NOTE)), false);
  const after = await found();
  assert.ok(!after.notes.includes(NOTE));
  assert.ok(!after.graph.includes(`inbox/${NOTE}`));
  // The other page is still found.
  assert.ok(after.pages.includes('altro/ricetta.md'));

  const jobs = await owner<{ status: string; payload: unknown; key: string | null }[]>`SELECT status, payload, key FROM jobs WHERE queue = ${ORGANIZE_QUEUE}`;
  assert.deepEqual([...jobs], [{ status: 'failed', payload: {}, key: null }]);
  const [event] = await owner<{ label: string; payload: unknown }[]>`SELECT label, payload FROM events WHERE kind = 'note.deleted' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(event, { label: 'L0', payload: { where: 'inbox' } });
  assert.equal((await owner`SELECT 1 FROM events WHERE payload::text LIKE '%pane%'`).length, 0);
  assert.deepEqual(await verifyEventChain(sql), { ok: true });

  assert.equal((await send('POST', `/api/notes/${NOTE}/delete`, {})).status, 404);
  assert.equal((await send('POST', '/api/notes/..%2F..%2Fdocs%2FSPEC.md/delete', {})).status, 404);
});

test('a page of the Conoscenza and a note of a project are deleted; the documents of development never', async () => {
  const { owner } = db();
  assert.equal((await send('POST', '/api/knowledge/page/delete', { path: 'altro/ricetta.md', extra: 1 })).status, 400);
  assert.equal((await send('POST', '/api/knowledge/page/delete', { path: 'altro/ricetta.md' })).status, 200);
  assert.equal(existsSync(join(HOME, 'kb', 'altro', 'ricetta.md')), false);
  for (const path of ['../docs/SPEC.md', 'altro/../../docs/SPEC.md', 'altro/ricetta.md']) {
    assert.equal((await send('POST', '/api/knowledge/page/delete', { path })).status, 404, path);
  }
  assert.ok(existsSync(join(HOME, 'docs', 'SPEC.md')));

  assert.equal((await send('POST', '/api/browse/progetto-test/knowledge/delete', { path: 'progetto-test-admin/.git/HEAD' })).status, 404);
  assert.equal((await send('POST', '/api/browse/progetto-test/knowledge/delete', { path: '../../docs/SPEC.md' })).status, 404);
  assert.equal((await send('POST', '/api/browse/altro/knowledge/delete', { path: 'Workplan/piano.md' })).status, 404);
  assert.equal((await send('POST', '/api/browse/progetto-test/knowledge/delete', { path: 'Workplan/piano.md' })).status, 200);
  assert.equal(existsSync(join(BOX, 'Workplan', 'piano.md')), false);
  const wheres = await owner<{ where: string }[]>`SELECT payload ->> 'where' AS where FROM events WHERE kind = 'note.deleted' ORDER BY id`;
  assert.deepEqual(wheres.map((row) => row.where), ['inbox', 'kb', 'project']);
});
