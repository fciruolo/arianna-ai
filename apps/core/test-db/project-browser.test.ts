// "Mostra nascosti" of the page "Progetti" (D-135, migration 0030): the
// consent per project, kept for its folder and decided by the core; turning
// it on and off and every "Mostra" of a secret are events without content.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';

import { startLiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const HOME = join(resolveHome({}), 'data', 'test-tmp', `browser-db-${randomUUID()}`);
const ROOT = join(HOME, 'repos', 'orto');
const MOVED = join(HOME, 'repos', 'orto-nuovo');
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});
for (const folder of [ROOT, MOVED]) {
  mkdirSync(join(folder, '.github'), { recursive: true });
  writeFileSync(join(folder, '.github', 'ci.yml'), 'name: ci\n');
  writeFileSync(join(folder, '.env'), 'TOKEN=finto-7d1e\n');
  writeFileSync(join(folder, 'README.md'), '# Orto\n');
  mkdirSync(join(folder, 'certs'), { recursive: true });
  writeFileSync(join(folder, 'certs', 'server.key'), 'chiave-finta-3b9c\n');
}
symlinkSync('.env', join(ROOT, 'note.txt'));

const ORTO: Project = { name: 'orto', path: 'repos/orto', absolute: ROOT, label: 'L1' };

async function withApi<T>(projects: () => readonly Project[], body: (base: string) => Promise<T>): Promise<T> {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, approvedProjects: projects });
  try {
    return await body(`http://127.0.0.1:${String(server.port)}/api/browse`);
  } finally {
    await server.close();
    await live.close();
  }
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const post = (url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
  json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** The last event now: each test reads only the project events after it. */
async function mark(): Promise<string> {
  const [row] = await db().sql<{ id: string }[]>`SELECT coalesce(max(id), 0)::text AS id FROM events`;
  return row?.id ?? '0';
}

async function projectEvents(since: string): Promise<{ kind: string; label: string; payload: Record<string, unknown> }[]> {
  const rows = await db().sql<{ kind: string; label: string; payload: Record<string, unknown> }[]>`
    SELECT kind, label::text AS label, payload FROM events WHERE kind LIKE 'project.%' AND id > ${since}::bigint ORDER BY id`;
  return rows.map((row) => ({ ...row }));
}

test('the consent is off at first: hidden entries shut and refused, no secret shown', async () => {
  await withApi(
    () => [ORTO],
    async (base) => {
      const since = await mark();
      const listed = await json(base);
      assert.deepEqual(listed.body.projects, [{ name: 'orto', absolute: ROOT, hidden: false, project: 'orto', part: null }]);
      const tree = await json(`${base}/orto/tree?dir=`);
      const entries = tree.body.entries as { name: string; shut?: string }[];
      assert.equal(entries.find((entry) => entry.name === '.env')?.shut, 'hidden');
      assert.equal((await json(`${base}/orto/file?path=.github/ci.yml`)).status, 403);
      assert.equal((await post(`${base}/orto/reveal`, { path: '.env' })).status, 403);
      // "Mostra" is a POST: the query of a GET reveals nothing.
      assert.equal(((await json(`${base}/orto/file?path=certs/server.key&reveal=1`)).body.file as { text: string }).text, '');
      assert.deepEqual(await projectEvents(since), []);
      // A secret that is not hidden: covered, and "Mostra" works without the consent, with its event.
      const key = (await post(`${base}/orto/reveal`, { path: 'certs/server.key' })).body.file as { text: string };
      assert.equal(key.text, 'chiave-finta-3b9c\n');
      assert.deepEqual(await projectEvents(since), [{ kind: 'project.secret_revealed', label: 'L1', payload: { project: 'orto', path: 'certs/server.key' } }]);
      // "Mostra" on a file that is no secret writes nothing; bad bodies are refused.
      assert.equal(((await post(`${base}/orto/reveal`, { path: 'README.md' })).body.file as { text: string }).text, '# Orto\n');
      assert.equal((await projectEvents(since)).length, 1);
      assert.equal((await post(`${base}/orto/reveal`, { path: 'README.md', reveal: true })).status, 400);
      assert.equal((await post(`${base}/orto/reveal`, { path: '' })).status, 400);
    },
  );
});

test('turned on: hidden files read, a secret covered until "Mostra", each step an event without content', async () => {
  await withApi(
    () => [ORTO],
    async (base) => {
      const since = await mark();
      assert.deepEqual((await post(`${base}/orto/hidden`, { on: true })).body, { hidden: true });
      assert.equal(((await json(base)).body.projects as { hidden: boolean }[])[0]?.hidden, true);
      const entries = (await json(`${base}/orto/tree?dir=`)).body.entries as { name: string; shut?: string; secret?: boolean }[];
      assert.deepEqual(entries.find((entry) => entry.name === '.env'), { name: '.env', kind: 'file', size: 17, secret: true });
      assert.equal(((await json(`${base}/orto/file?path=.github/ci.yml`)).body.file as { text: string }).text, 'name: ci\n');
      const covered = (await json(`${base}/orto/file?path=.env`)).body.file as Record<string, unknown>;
      assert.deepEqual([covered.covered, covered.text], [true, '']);
      assert.equal((await projectEvents(since)).filter((event) => event.kind === 'project.secret_revealed').length, 0);
      const shown = (await post(`${base}/orto/reveal`, { path: '.env' })).body.file as Record<string, unknown>;
      assert.equal(shown.text, 'TOKEN=finto-7d1e\n');
      const events = await projectEvents(since);
      assert.deepEqual(events, [
        { kind: 'project.hidden_shown', label: 'L1', payload: { project: 'orto' } },
        { kind: 'project.secret_revealed', label: 'L1', payload: { project: 'orto', path: '.env' } },
      ]);
      assert.ok(!JSON.stringify(events).includes('finto-7d1e'));
      // Through a link: the event says the path asked and the file really read.
      assert.equal(((await post(`${base}/orto/reveal`, { path: 'note.txt' })).body.file as { text: string }).text, 'TOKEN=finto-7d1e\n');
      assert.deepEqual((await projectEvents(since)).at(-1)?.payload, { project: 'orto', path: 'note.txt', real: '.env' });
    },
  );
});

test('the consent belongs to the folder: the same name in another folder starts with it off', async () => {
  await withApi(
    () => [{ ...ORTO, path: 'repos/orto-nuovo', absolute: MOVED }],
    async (base) => {
      assert.equal(((await json(base)).body.projects as { hidden: boolean }[])[0]?.hidden, false);
      assert.equal((await json(`${base}/orto/file?path=.github/ci.yml`)).status, 403);
    },
  );
});

test('turned off: the row stays with shown false, the event is written, hidden files refused again; bad requests refused', async () => {
  await withApi(
    () => [ORTO],
    async (base) => {
      const since = await mark();
      assert.equal((await post(`${base}/orto/hidden`, { on: 'si' })).status, 400);
      assert.equal((await post(`${base}/orto/hidden`, { on: true, path: '.env' })).status, 400);
      assert.equal((await post(`${base}/altro/hidden`, { on: true })).status, 403);
      assert.deepEqual((await post(`${base}/orto/hidden`, { on: false })).body, { hidden: false });
      assert.equal((await db().sql`SELECT project FROM project_hidden_consents WHERE shown`).length, 0);
      assert.equal((await json(`${base}/orto/file?path=.github/ci.yml`)).status, 403);
      assert.equal((await projectEvents(since)).at(-1)?.kind, 'project.hidden_closed');
    },
  );
});
