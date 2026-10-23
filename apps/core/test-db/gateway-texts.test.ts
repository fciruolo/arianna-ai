// «Cosa è uscito» (D-297) on a real database: the exact text of an exit
// allowed to the cloud up to L1, written with its row of gateway_log, in the
// order it left; never for a block, a local target or an incognito
// conversation; gone with the conversation (purge and erase) and after 30
// days; read through the API of the Mac, never in the list.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { resolveHome } from '@arianna/config';
import { createContext, sha256Hex, type Labeled, type Target } from '@arianna/policy';

import { archiveConversation, createConversation, purgeConversation } from '../src/conversations.ts';
import { eraseConversation } from '../src/erase.ts';
import { KEPT_PART_BYTES, passGateway } from '../src/gateway.ts';
import { loadGatewayText, pruneGatewayTexts } from '../src/gateway-log.ts';
import { closeIncognito } from '../src/incognito.ts';
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
const MARK = 'testouscitofinto';

const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
const LOCAL_MODEL: Target = { kind: 'executor', id: 'omlx', locality: 'local' };

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

function parts(...texts: string[]): Labeled<string>[] {
  return texts.map((value) => ({ value, label: 'L1', source: 'test' }));
}

async function lastRow(): Promise<{ id: string; sha: string | null; decision: string }> {
  const [row] = await db().sql<{ id: string; sha: string | null; decision: string }[]>`
    SELECT g.id::text AS id, g.payload_sha256 AS sha, g.decision FROM gateway_log g ORDER BY g.id DESC LIMIT 1`;
  if (row === undefined) throw new Error('gateway_log is empty');
  return row;
}

async function textsOf(id: string): Promise<{ seq: number; text: string; bytes: number }[]> {
  const rows = await db().sql<{ seq: number; body: Buffer; bytes: number }[]>`SELECT seq, body, bytes FROM gateway_texts WHERE log_id = ${id}::bigint ORDER BY seq`;
  return rows.map((row) => ({ seq: row.seq, text: row.body.toString('utf8'), bytes: row.bytes }));
}

async function workTask(incognito = false): Promise<{ conversationId: string; taskId: string }> {
  const conversation = await createConversation(db().sql, { mode: 'work', incognito });
  const task = await createTask(db().sql, { title: incognito ? 'Incognito' : 'Domanda', conversationId: conversation.id, label: 'L1', clearance: 'L1' });
  return { conversationId: conversation.id, taskId: task.id };
}

test('an allowed exit to the cloud keeps its exact text, part by part, with the sha256 of its row', async () => {
  const { taskId } = await workTask();
  const decision = await passGateway(db().sql, parts(`Istruzioni dell'agente ${MARK}`, 'Estratto della KB: àèìòù €', 'NUL\u0000dentro'), createContext('L1'), CLAUDE, { taskId });
  assert.equal(decision.decision, 'allow');
  const row = await lastRow();
  const kept = await textsOf(row.id);
  assert.deepEqual(kept.map((part) => part.text), [...decision.texts]);
  assert.deepEqual(kept.map((part) => part.seq), [1, 2, 3]);
  // The same bytes the row measured: its sha256 is the sha256 of the kept parts.
  assert.equal(sha256Hex(JSON.stringify(kept.map((part) => part.text))), row.sha);
  const text = await loadGatewayText(db().sql, row.id);
  assert.equal(text?.state, 'text');
  assert.equal(text.verified, true);
  assert.equal(text.label, 'L1');
  assert.equal(text.parts?.[1]?.text, 'Estratto della KB: àèìòù €');
  assert.equal(text.bytes, kept.reduce((sum, part) => sum + part.bytes, 0));
});

test('a blocked exit keeps no text: the detail says only its label', async () => {
  const { taskId } = await workTask();
  const decision = await passGateway(db().sql, [{ value: `nota privata ${MARK}`, label: 'L2', source: 'kb/private/a.md' }], createContext('L1'), CLAUDE, { taskId });
  assert.equal(decision.decision, 'block');
  const row = await lastRow();
  assert.deepEqual(await textsOf(row.id), []);
  assert.deepEqual(await loadGatewayText(db().sql, row.id), { id: row.id, label: 'L2', state: 'blocked', subject: null });
  const answer = await get(`/api/gateway/log/${row.id}/text`);
  assert.equal(answer.status, 200);
  assert.equal(answer.text.includes(MARK), false);
});

test('an exit to a target on the Mac keeps no text', async () => {
  await passGateway(db().sql, parts(`domanda locale ${MARK}`), createContext('L1'), LOCAL_MODEL);
  const row = await lastRow();
  assert.equal(row.decision, 'allow');
  assert.deepEqual(await textsOf(row.id), []);
  assert.equal((await loadGatewayText(db().sql, row.id))?.state, 'local');
});

test('incognito: the text is never written, by task or by run, and the row is not readable', async () => {
  const { taskId } = await workTask(true);
  assert.equal((await passGateway(db().sql, parts(`brief incognito ${MARK}`), createContext('L1'), CLAUDE, { taskId })).decision, 'allow');
  const byTask = await lastRow();
  assert.deepEqual(await textsOf(byTask.id), []);
  const [run] = await db().owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label)
    VALUES (${taskId}, 1, 'coder', 'claude', 'sonnet', 'cloud', 'L1') RETURNING id::text`;
  await passGateway(db().sql, parts(`brief incognito ${MARK}`), createContext('L1'), CLAUDE, { runId: run?.id ?? '' });
  const byRun = await lastRow();
  assert.deepEqual(await textsOf(byRun.id), []);
  assert.equal(await loadGatewayText(db().sql, byTask.id), undefined);
  assert.equal((await get(`/api/gateway/log/${byRun.id}/text`)).status, 404);
  const total = await db().owner<{ n: number }[]>`SELECT count(*)::int AS n FROM gateway_texts WHERE position(convert_to('brief incognito', 'UTF8') IN body) > 0`;
  assert.equal(total[0]?.n, 0);
});

test('an exit tied to no task or run keeps no text: neither the incognito nor «Elimina» could reach it', async () => {
  const { sql, owner } = db();
  // As the advisor before D-297 or the browser driven by the user: no task, no run.
  await passGateway(sql, parts(`brief senza task ${MARK}`), createContext('L1'), CLAUDE, { summary: 'router-advice:test' });
  const row = await lastRow();
  assert.equal(row.decision, 'allow');
  assert.deepEqual(await textsOf(row.id), []);
  assert.equal((await loadGatewayText(sql, row.id))?.state, 'none');
  await assert.rejects(owner`INSERT INTO gateway_texts (log_id, seq, body, bytes) VALUES (${row.id}::bigint, 1, '\\x41', 1)`, /of a task or a run/);
});

test('the guard refuses a text the gateway would not keep, even written by hand', async () => {
  const { sql, owner } = db();
  const { taskId } = await workTask();
  await passGateway(sql, [{ value: 'privato', label: 'L2', source: 'kb/private/b.md' }], createContext('L1'), CLAUDE, { taskId });
  const blocked = await lastRow();
  await assert.rejects(sql`INSERT INTO gateway_texts (log_id, seq, body, bytes) VALUES (${blocked.id}::bigint, 1, '\\x41', 1)`, /only the text of an exit allowed/);
  const incognito = await workTask(true);
  await passGateway(sql, parts('ciao'), createContext('L1'), CLAUDE, { taskId: incognito.taskId });
  const hidden = await lastRow();
  await assert.rejects(owner`INSERT INTO gateway_texts (log_id, seq, body, bytes) VALUES (${hidden.id}::bigint, 1, '\\x41', 1)`, /never the text of an incognito/);
  // The core neither changes nor deletes a text by itself.
  await passGateway(sql, parts('testo'), createContext('L1'), CLAUDE, { taskId });
  const allowed = await lastRow();
  await assert.rejects(sql`UPDATE gateway_texts SET body = '\\x42' WHERE log_id = ${allowed.id}::bigint`, /permission denied/);
  await assert.rejects(sql`DELETE FROM gateway_texts WHERE log_id = ${allowed.id}::bigint`, /permission denied/);
});

test('a purge (the close of a nested chat, the old route /purge) takes the texts of its exits, by task and by run', async () => {
  const { sql, owner } = db();
  const { conversationId, taskId } = await workTask();
  const [run] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label)
    VALUES (${taskId}, 1, 'coder', 'claude', 'sonnet', 'cloud', 'L1') RETURNING id::text`;
  await passGateway(sql, parts(`uno ${MARK}`), createContext('L1'), CLAUDE, { taskId });
  const byTask = await lastRow();
  await passGateway(sql, parts(`due ${MARK}`), createContext('L1'), CLAUDE, { runId: run?.id ?? '' });
  const byRun = await lastRow();
  const other = await workTask();
  await passGateway(sql, parts('altra conversazione'), createContext('L1'), CLAUDE, { taskId: other.taskId });
  const kept = await lastRow();
  assert.equal((await textsOf(byTask.id)).length, 1);
  assert.equal((await textsOf(byRun.id)).length, 1);
  await archiveConversation(sql, conversationId, true);
  await purgeConversation(sql, conversationId);
  assert.deepEqual(await textsOf(byTask.id), []);
  assert.deepEqual(await textsOf(byRun.id), []);
  assert.equal((await loadGatewayText(sql, byTask.id))?.state, 'gone');
  // The row of the log stays (append-only), another conversation keeps its text.
  assert.equal((await lastRowById(byTask.id)).decision, 'allow');
  assert.equal((await textsOf(kept.id)).length, 1);
});

async function lastRowById(id: string): Promise<{ decision: string }> {
  const [row] = await db().sql<{ decision: string }[]>`SELECT decision FROM gateway_log WHERE id = ${id}::bigint`;
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
}

test('«Elimina» (erase_conversation, D-157) takes the texts with the rows', async () => {
  const { sql } = db();
  const { conversationId, taskId } = await workTask();
  await passGateway(sql, parts(`tre ${MARK}`), createContext('L1'), CLAUDE, { taskId });
  const row = await lastRow();
  assert.equal((await textsOf(row.id)).length, 1);
  await archiveConversation(sql, conversationId, true);
  await eraseConversation(sql, conversationId);
  assert.deepEqual(await textsOf(row.id), []);
});

test('closing an incognito conversation is safe with no texts to take', async () => {
  const { sql } = db();
  const { conversationId, taskId } = await workTask(true);
  await passGateway(sql, parts('ciao'), createContext('L1'), CLAUDE, { taskId });
  await closeIncognito(sql, conversationId, 'user');
});

test('after 30 days a text goes by itself, and past 30 days it is never read', async () => {
  const { sql, owner } = db();
  const { taskId } = await workTask();
  await passGateway(sql, parts(`vecchio ${MARK}`), createContext('L1'), CLAUDE, { taskId });
  const old = await lastRow();
  await passGateway(sql, parts(`nuovo ${MARK}`), createContext('L1'), CLAUDE, { taskId });
  const fresh = await lastRow();
  await owner`UPDATE gateway_texts SET created_at = now() - interval '31 days' WHERE log_id = ${old.id}::bigint`;
  // Not pruned yet: still never read.
  assert.equal((await loadGatewayText(sql, old.id))?.state, 'none');
  assert.ok((await pruneGatewayTexts(sql)) >= 1);
  assert.deepEqual(await textsOf(old.id), []);
  assert.equal((await textsOf(fresh.id)).length, 1);
  // A day short of 30 stays.
  await owner`UPDATE gateway_texts SET created_at = now() - interval '29 days' WHERE log_id = ${fresh.id}::bigint`;
  await pruneGatewayTexts(sql);
  assert.equal((await textsOf(fresh.id)).length, 1);
  // Past 30 days it goes too (the row of the log, written now, cannot be made older: append-only).
  await owner`UPDATE gateway_texts SET created_at = now() - interval '31 days' WHERE log_id = ${fresh.id}::bigint`;
  await pruneGatewayTexts(sql);
  assert.deepEqual(await textsOf(fresh.id), []);
});

test('a part over 1 MiB keeps its first MiB on a character boundary; the exit is not stopped', async () => {
  const { taskId } = await workTask();
  const big = `${'a'.repeat(KEPT_PART_BYTES - 1)}€ e oltre`;
  const decision = await passGateway(db().sql, parts('breve', big), createContext('L1'), CLAUDE, { taskId });
  assert.equal(decision.decision, 'allow');
  const row = await lastRow();
  const text = await loadGatewayText(db().sql, row.id);
  assert.equal(text?.state, 'text');
  const kept = text.parts ?? [];
  assert.deepEqual(kept.map((part) => part.truncated), [false, true]);
  const second = kept[1];
  assert.ok(second !== undefined);
  assert.equal(second.text, 'a'.repeat(KEPT_PART_BYTES - 1));
  assert.equal(second.bytes, Buffer.byteLength(big, 'utf8'));
  assert.equal(text.verified, null);
});

test('API: the text only on its own route; the list stays without it', async () => {
  const { taskId } = await workTask();
  await passGateway(db().sql, parts(`brief per Claude ${MARK}`), createContext('L1'), CLAUDE, { taskId });
  const row = await lastRow();
  const answer = await get(`/api/gateway/log/${row.id}/text`);
  assert.equal(answer.status, 200);
  const body = JSON.parse(answer.text) as { state: string; parts: { text: string }[]; verified: boolean };
  assert.deepEqual([body.state, body.parts[0]?.text, body.verified], ['text', `brief per Claude ${MARK}`, true]);
  assert.equal(answer.text.includes(row.sha ?? '-'), false, 'never the hash');
  const list = await get('/api/gateway/log');
  assert.equal(list.status, 200);
  assert.equal(list.text.includes(MARK), false);
  assert.equal((await get('/api/gateway/log/abc/text')).status, 400);
  assert.equal((await get('/api/gateway/log/999999999/text')).status, 404);
});
