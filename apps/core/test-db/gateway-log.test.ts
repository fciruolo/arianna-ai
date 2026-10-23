// «Registro del gateway» (D-296) on a real database, read as arianna_app and
// through the API: one row per decision, newest first, filters and cursor,
// only metadata (never summary, reason or hash), no incognito conversation.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { createConversation, INCOGNITO_TITLE } from '../src/conversations.ts';
import { loadGatewayLog, parseGatewayLogQuery } from '../src/gateway-log.ts';
import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { createTask } from '../src/tasks.ts';
import { createTestDatabase, SETUP_TIMEOUT_MS, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
let live: LiveFeed;
let server: ApiServer;
const HOME = resolveHome({});
// Every text that may sit in a row carries this word: the answer must never hold it.
const MARK = 'testouscitofinto';
const HASH = 'ab'.repeat(32);

const ids: Record<string, string> = {};

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
      dirs: { original: join(HOME, 'apps', 'hud', 'characters', 'originali'), data: join(HOME, 'data', 'test-tmp', 'no-characters') },
      choices: () => ({}),
    },
  });

  const { sql, owner } = db();
  const work = await createConversation(sql, { mode: 'work' });
  await owner`UPDATE conversations SET title = 'Riordino del codice' WHERE id = ${work.id}`;
  const chat = await createTask(sql, { title: `Domanda ${MARK}`, goal: `Obiettivo ${MARK}`, conversationId: work.id, label: 'L1', clearance: 'L1' });
  const card = await createTask(sql, { title: 'Scheda del preventivo', assignee: 'coder' });
  const incognito = await createConversation(sql, { mode: 'private', incognito: true });
  const hidden = await createTask(sql, { title: INCOGNITO_TITLE, conversationId: incognito.id, label: 'L2', clearance: 'L2' });
  const [run] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label)
    VALUES (${chat.id}, 1, 'coder', 'claude', 'sonnet', 'cloud', 'L1') RETURNING id::text`;
  const [hiddenRun] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label)
    VALUES (${hidden.id}, 1, 'arianna', 'local', 'local-large', 'local', 'L2') RETURNING id::text`;
  ids.work = work.id;
  ids.chat = chat.id;
  ids.card = card.id;
  ids.run = run?.id ?? '';

  // In the order of their ids: 1 an allowed exit of the chat to Claude, 2 a blocked one, 3 a card to Codex,
  // 4 a channel two days ago, 5 and 6 of the incognito conversation (by task, by run only), 7 a check of the core.
  await owner`
    INSERT INTO gateway_log (ts, task_id, run_id, target_kind, target, locality, label, decision, rule, reason, bytes_out, payload_sha256, summary) VALUES
      (now() - interval '1 hour', ${chat.id}, ${run?.id ?? null}, 'executor', 'claude', 'cloud', 'L1', 'allow', 'cloud', ${`L1 to a cloud target ${MARK}`}, 640, ${HASH}, ${`Riassunto ${MARK}`}),
      (now() - interval '50 minutes', ${chat.id}, ${run?.id ?? null}, 'executor', 'claude', 'cloud', 'L2', 'block', 'pii', ${`person found ${MARK}`}, NULL, NULL, NULL),
      (now() - interval '40 minutes', ${card.id}, NULL, 'executor', 'codex', 'cloud', 'L0', 'allow', 'cloud', 'L0 to a cloud target', 120, ${HASH}, NULL),
      (now() - interval '2 days', NULL, NULL, 'channel', 'push', 'cloud', 'L0', 'allow', 'cloud', 'L0 notice', 80, ${HASH}, NULL),
      (now() - interval '30 minutes', ${hidden.id}, NULL, 'executor', 'claude', 'cloud', 'L2', 'block', 'cloud-label', ${`above L1 ${MARK}`}, 10, ${HASH}, NULL),
      (now() - interval '20 minutes', NULL, ${hiddenRun?.id ?? null}, 'executor', 'local', 'local', 'L2', 'allow', 'local', ${`L2 local ${MARK}`}, 10, ${HASH}, NULL),
      (now() - interval '10 minutes', NULL, NULL, 'web', 'web-page-public', 'cloud', 'L0', 'allow', 'page', ${`page of ${MARK}.example`}, 50, ${HASH}, NULL)`;
}, { timeout: SETUP_TIMEOUT_MS });

after(async () => {
  await server.close();
  await live.close();
  await database?.close();
});

function get(path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${String(server.port)}${path}`, { agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

interface Page {
  entries: { id: string; target: string; decision: string; label: string; rule: string; agent: string | null; model: string | null; bytes: number | null; conversation: { id: string; title: string | null; open: boolean } | null; card: { id: string; title: string } | null }[];
  next: string | null;
  targets?: { kind: string; target: string }[];
}

async function page(query: string): Promise<Page> {
  const answer = await get(`/api/gateway/log${query}`);
  assert.equal(answer.status, 200, answer.text);
  return JSON.parse(answer.text) as Page;
}

test('newest first, who asked, and never the text: no summary, reason or hash', async () => {
  const answer = await get('/api/gateway/log');
  assert.equal(answer.status, 200);
  assert.equal(answer.text.includes(MARK), false, 'no summary, reason or title of a chat task');
  assert.equal(answer.text.includes(HASH), false, 'no sha256 of the payload');
  for (const field of ['summary', 'reason', 'payload', 'sha256']) assert.equal(answer.text.includes(`"${field}`), false, field);
  const body = JSON.parse(answer.text) as Page;
  assert.deepEqual(body.entries.map((entry) => [entry.target, entry.decision]), [
    ['web-page-public', 'allow'],
    ['push', 'allow'],
    ['codex', 'allow'],
    ['claude', 'block'],
    ['claude', 'allow'],
  ]);
  const allowed = body.entries[4];
  assert.equal(allowed?.agent, 'coder');
  assert.equal(allowed.model, 'sonnet');
  assert.equal(allowed.bytes, 640);
  assert.deepEqual(allowed.conversation, { id: ids.work, title: 'Riordino del codice', open: true });
  assert.equal(allowed.card, null);
  const card = body.entries[2];
  assert.deepEqual(card?.card, { id: ids.card, title: 'Scheda del preventivo' });
  assert.equal(card.agent, 'coder');
  assert.equal(body.entries[3]?.rule, 'pii');
  assert.equal(body.entries[1]?.agent, null);
  assert.equal(body.next, null);
  // executor/local is only in the incognito conversation: not offered.
  assert.deepEqual(body.targets?.map((item) => `${item.kind}/${item.target}`), ['channel/push', 'executor/claude', 'executor/codex', 'web/web-page-public']);
});

test('an incognito conversation is never shown, found by task or by run', async () => {
  const body = await page('?limit=100');
  assert.equal(body.entries.length, 5);
  assert.equal(body.entries.some((entry) => entry.label === 'L2' && entry.decision === 'allow'), false);
  assert.equal((await page('?target=local')).entries.length, 0);
  assert.equal((await page('?decision=block')).entries.length, 1);
});

test('the filters: outcome, kind, target, label and period', async () => {
  assert.deepEqual((await page('?decision=block')).entries.map((entry) => entry.rule), ['pii']);
  assert.deepEqual((await page('?kind=channel')).entries.map((entry) => entry.target), ['push']);
  assert.deepEqual((await page('?target=claude')).entries.map((entry) => entry.decision), ['block', 'allow']);
  assert.deepEqual((await page('?label=L1')).entries.map((entry) => entry.target), ['claude']);
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal((await page(`?from=${encodeURIComponent(from)}`)).entries.length, 4);
  const to = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual((await page(`?to=${encodeURIComponent(to)}`)).entries.map((entry) => entry.target), ['push']);
  // Empty parameters are no filter.
  assert.equal((await page('?decision=&label=&target=')).entries.length, 5);
});

test('the cursor goes on below the last row, without repeating one, and stops at the end', async () => {
  const first = await page('?limit=2');
  assert.equal(first.entries.length, 2);
  assert.ok(first.targets !== undefined);
  assert.ok(first.next !== null);
  const second = await page(`?limit=2&before=${first.next}`);
  assert.equal(second.targets, undefined);
  assert.ok(second.next !== null);
  const third = await page(`?limit=2&before=${second.next}`);
  assert.equal(third.next, null);
  const all = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.id);
  assert.equal(all.length, 5);
  assert.equal(new Set(all).size, 5);
  assert.deepEqual(all, [...all].sort((a, b) => Number(b) - Number(a)));
});

test('wrong parameters are refused with 400', async () => {
  for (const query of ['?decision=maybe', '?kind=email', '?label=L4', '?target=Claude%20Opus', '?before=abc', '?before=0', '?before=9999999999999999999', '?limit=0', '?limit=101', '?from=ieri', '?text=x', '?from=2026-10-20&to=2026-10-19']) {
    const answer = await get(`/api/gateway/log${query}`);
    assert.equal(answer.status, 400, query);
  }
});

test('a code that is not a code is shown as other, never as written', async () => {
  const { sql, owner } = db();
  await owner`
    INSERT INTO gateway_log (target_kind, target, locality, label, decision, rule, reason)
    VALUES ('executor', ${`Claude ${MARK}`}, 'cloud', 'L0', 'block', ${`Regola ${MARK}`}, 'x')`;
  const result = await loadGatewayLog(sql, parseGatewayLogQuery(new URLSearchParams('limit=1')));
  assert.equal(result.entries[0]?.target, 'other');
  assert.equal(result.entries[0].rule, 'other');
  assert.equal(JSON.stringify(result).includes(MARK), false);
});

test('a purged conversation keeps its row, without title and without «Apri»', async () => {
  const { sql, owner } = db();
  const gone = await createConversation(sql, { mode: 'work' });
  await owner`UPDATE conversations SET title = ${`Titolo ${MARK}`} WHERE id = ${gone.id}`;
  const task = await createTask(sql, { title: 'Domanda', conversationId: gone.id, label: 'L1', clearance: 'L1' });
  await owner`
    INSERT INTO gateway_log (task_id, target_kind, target, locality, label, decision, rule, reason)
    VALUES (${task.id}, 'executor', 'claude', 'cloud', 'L1', 'allow', 'cloud', 'x')`;
  await owner`UPDATE conversations SET archived_at = now() WHERE id = ${gone.id}`;
  await owner`SELECT purge_conversation(${gone.id}::uuid)`;
  const result = await loadGatewayLog(sql, parseGatewayLogQuery(new URLSearchParams('limit=1')));
  assert.deepEqual(result.entries[0]?.conversation, { id: gone.id, title: null, open: false });
  assert.equal(JSON.stringify(result).includes(MARK), false);
});
