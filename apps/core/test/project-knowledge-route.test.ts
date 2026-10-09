// The routes of the page Progetti for containers (I-11, D-145): the parts and
// the containers listed, a part read by its name, the tab "Conoscenza" read
// and written; the labels of the folders never through these routes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, workParts, type Project } from '@arianna/config';
import { createLabelRules } from '@arianna/policy';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `knowledge-route-${randomUUID()}`);
const BOX = join(HOME, 'repos', 'progetto-test');
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});
for (const [path, content] of Object.entries({
  'Workplan/piano.md': '# Piano finto\n',
  'documenti/contratto.md': '# Contratto finto\n',
  'progetto-test-admin/.git/HEAD': 'ref: refs/heads/main\n',
  'progetto-test-admin/README.md': '# Admin finto\n',
})) {
  mkdirSync(dirname(join(BOX, path)), { recursive: true });
  writeFileSync(join(BOX, path), content);
}
const CONTAINERS: Project[] = [{ name: 'progetto-test', path: 'repos/progetto-test', absolute: BOX, label: 'L1' }];

function send(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text || '{}') as Record<string, unknown> });
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('parts and containers, the tab Conoscenza, a note written; the labels of the folders are not written here', async (t) => {
  const sql = { unsafe: () => Promise.resolve([]) } as unknown as Sql;
  const server = await startApiServer({ sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, approvedProjects: () => workParts(CONTAINERS), projectContainers: () => CONTAINERS, knowledge: { home: join(HOME, 'arianna'), rules: createLabelRules({ folders: [], sources: [] }) } });
  t.after(async () => {
    await server.close();
  });

  const listed = await send(server.port, 'GET', '/api/browse');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.projects, [{ name: 'progetto-test:progetto-test-admin', absolute: join(BOX, 'progetto-test-admin'), hidden: false, project: 'progetto-test', part: 'progetto-test-admin' }]);
  assert.deepEqual(listed.body.containers, [{ name: 'progetto-test', absolute: BOX, label: 'L1', single: false, parts: ['progetto-test:progetto-test-admin'] }]);

  // A part is read by its name; the container is no part, its tree is not served.
  const tree = await send(server.port, 'GET', '/api/browse/progetto-test:progetto-test-admin/tree?dir=');
  assert.equal(tree.status, 200);
  assert.deepEqual((tree.body.entries as { name: string }[]).map(({ name }) => name), ['.git', 'README.md']);
  assert.equal((await send(server.port, 'GET', '/api/browse/progetto-test/tree?dir=')).status, 403);

  const knowledge = await send(server.port, 'GET', '/api/browse/progetto-test/knowledge');
  assert.equal(knowledge.status, 200);
  const read = knowledge.body.knowledge as { folders: { path: string; label: string }[]; notes: { path: string; label: string }[] };
  assert.deepEqual(read.folders.map(({ path, label }) => [path, label]), [['documenti', 'L2'], ['Workplan', 'L1']]);
  assert.equal((await send(server.port, 'GET', '/api/browse/progetto-test:progetto-test-admin/knowledge')).status, 404);
  assert.equal((await send(server.port, 'GET', '/api/browse/altro/knowledge')).status, 404);

  const note = { folder: 'Workplan', title: 'Milestone', label: 'L1', text: 'Consegna finta.' };
  // A field that would change a folder, a label below the folder, a folder that is a part: refused.
  assert.equal((await send(server.port, 'POST', '/api/browse/progetto-test/knowledge', { ...note, folders: [{ path: 'documenti', label: 'L0' }] })).status, 400);
  assert.equal((await send(server.port, 'POST', '/api/browse/progetto-test/knowledge', { ...note, folder: 'documenti' })).status, 400);
  assert.equal((await send(server.port, 'POST', '/api/browse/progetto-test/knowledge', { ...note, folder: 'progetto-test-admin' })).status, 400);
  assert.equal((await send(server.port, 'POST', '/api/browse/progetto-test/knowledge', { ...note, label: 'L7' })).status, 400);
  const written = await send(server.port, 'POST', '/api/browse/progetto-test/knowledge', note);
  assert.equal(written.status, 201);
  const saved = written.body.note as { path: string; label: string };
  assert.equal(saved.label, 'L1');
  assert.match(readFileSync(join(BOX, saved.path), 'utf8'), /^---\nlabel: L1\n/);
  // Still Privata: nothing here wrote a label of a folder.
  const again = (await send(server.port, 'GET', '/api/browse/progetto-test/knowledge')).body.knowledge as { folders: { path: string; label: string }[] };
  assert.equal(again.folders.find(({ path }) => path === 'documenti')?.label, 'L2');
});
