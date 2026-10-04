import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { loadStatus } from '../src/status.ts';
import { createTask, moveTask } from '../src/tasks.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
let live: LiveFeed;
let server: ApiServer;
const HOME = resolveHome({});

before(async () => {
  database = await createTestDatabase();
  live = await startLiveFeed(db().sql);
  server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    agents: () => ['arianna', 'coder'],
    characters: {
      // No data/characters here: the originals only.
      dirs: { original: join(HOME, 'apps', 'hud', 'characters', 'originali'), data: join(HOME, 'data', 'test-tmp', 'no-characters') },
      choices: () => ({ coder: 'gone/robot' }),
    },
  });
});

after(async () => {
  await server.close();
  await live.close();
  await database?.close();
});

function get(path: string): Promise<{ status: number; type: string | undefined; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${String(server.port)}${path}`, { agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, type: response.headers['content-type'], body: Buffer.concat(chunks) });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('an empty installation: everyone idle, no router decision, nothing through the gateway', async () => {
  const status = await loadStatus(db().sql, ['arianna', 'coder']);
  assert.deepEqual(status.agents, [
    { id: 'arianna', state: 'idle', run: null },
    { id: 'coder', state: 'idle', run: null },
  ]);
  assert.equal(status.router, null);
  assert.deepEqual([status.gateway.allowedOut, status.gateway.blocked, status.gateway.privateOut, status.waiting], [0, 0, 0, 0]);
  assert.equal(status.gateway.hours.length, 12);
  assert.ok(status.gateway.hours.every((count) => count === 0));
});

test('runs, a waiting task, the last router decision and the gateway today are counted, with no content', async () => {
  const { sql } = db();
  const task = await createTask(sql, { title: 'Testo privato del task', assignee: 'arianna', status: 'ready' });
  await sql`INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label)
    VALUES (${task.id}, 1, 'coder', 'claude', 'sonnet', 'cloud', 'L1')`;
  const waiting = await createTask(sql, { title: 'Un altro testo privato', assignee: 'arianna', status: 'ready' });
  await moveTask(sql, waiting.id, 'running');
  await moveTask(sql, waiting.id, 'waiting_user', { reason: 'question' });
  for (const [model, reason] of [['opus', 'older'], ['sonnet', 'L1 within cloud; first candidate sonnet']] as const) {
    await sql`INSERT INTO router_decisions (task_id, step, label, difficulty, decision, executor, model, locality, candidates, reason)
      VALUES (${task.id}, 1, 'L1', 'normal', 'route', 'claude', ${model}, 'cloud', '[]'::jsonb, ${reason})`;
  }
  const row = (decision: 'allow' | 'block', label: string, locality: string) =>
    sql`INSERT INTO gateway_log (target_kind, target, locality, label, decision, rule, reason)
      VALUES ('executor', 'claude', ${locality}, ${label}::privacy_label, ${decision}, 'test', 'test')`;
  await row('allow', 'L1', 'cloud');
  await row('allow', 'L0', 'cloud');
  await row('allow', 'L2', 'local');
  await row('block', 'L2', 'cloud');

  const status = await loadStatus(sql, ['arianna', 'coder']);
  assert.deepEqual(
    status.agents.map(({ id, state, run }) => [id, state, run?.executor, run?.model]),
    [
      ['arianna', 'waiting', undefined, undefined],
      ['coder', 'working', 'claude', 'sonnet'],
    ],
  );
  assert.deepEqual(
    status.router === null ? null : [status.router.model, status.router.label, status.router.reason],
    ['sonnet', 'L1', 'L1 within cloud; first candidate sonnet'],
  );
  assert.deepEqual([status.gateway.allowedOut, status.gateway.blocked, status.gateway.privateOut, status.waiting], [2, 1, 0, 1]);
  assert.equal(status.gateway.hours.at(-1), 4);
  // Titles are L2: the panel never carries them.
  assert.doesNotMatch(JSON.stringify(status), /privato/);

  const reply = await get('/api/status');
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body.toString('utf8')), JSON.parse(JSON.stringify(status)));
});

test('GET /api/characters lists the originals and falls back when a pack is gone; sheets are served as PNG', async () => {
  const listing = await get('/api/characters');
  assert.equal(listing.status, 200);
  const body = JSON.parse(listing.body.toString('utf8')) as { packs: { id: string }[]; agents: Record<string, { pack: string; character: string }> };
  assert.deepEqual(body.packs.map(({ id }) => id), ['originali']);
  assert.deepEqual(body.agents, {
    arianna: { pack: 'originali', character: 'arianna', rows: 4 },
    coder: { pack: 'originali', character: 'coder', rows: 4 },
  });

  const sheet = await get('/api/characters/originali/arianna');
  assert.equal(sheet.status, 200);
  assert.equal(sheet.type, 'image/png');
  assert.equal(sheet.body.readUInt32BE(16), 112);
  for (const path of ['/api/characters/originali/nobody', '/api/characters/gone/robot', '/api/characters/originali/..%2Fpack.json']) {
    assert.equal((await get(path)).status, 404, path);
  }
});
