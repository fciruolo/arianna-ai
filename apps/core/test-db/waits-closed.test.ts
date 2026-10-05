// D-109 against PostgreSQL: a new user message closes the waits of its
// conversation that have no pending approval (cause `superseded`, one system
// line); "Chiudi" (POST /api/tasks/:id/dismiss) closes a waiting task by hand
// and lets its pending approvals expire.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';

import { archiveConversation, createConversation, postUserMessage, purgeConversation } from '../src/conversations.ts';
import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { conversationView } from '../src/orchestrator/summaries.ts';
import { createTask, loadTask, moveTask } from '../src/tasks.ts';
import { SUPERSEDED_TEXT } from '../src/waiting.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
let live: LiveFeed;
let server: ApiServer;
let origin: string;

before(async () => {
  database = await createTestDatabase();
  live = await startLiveFeed(db().sql);
  server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0 });
  origin = `http://127.0.0.1:${String(server.port)}`;
});

after(async () => {
  await server.close();
  await live.close();
  await database?.close();
});

function post(path: string, body = '{}'): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      { method: 'POST', agent: false, headers: { 'content-type': 'application/json', origin } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          } catch {
            // Not JSON.
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

/** A conversation whose first task now waits for the user; with `approval`, behind a pending approval. */
async function waitingChat(text: string, reason: string, approval = false): Promise<{ conversationId: string; taskId: string; approvalId: string | null }> {
  const { sql, owner } = db();
  const chat = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, chat.id, text);
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  let approvalId: string | null = null;
  if (approval) {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'budget', 'budget', ${owner.json({ model: 'opus' })}, 'L1') RETURNING id::text`;
    approvalId = row?.id ?? null;
  }
  await moveTask(sql, task.id, 'waiting_user', { reason, cause: 'executor', ...(approvalId === null ? {} : { approvalId }) });
  return { conversationId: chat.id, taskId: task.id, approvalId };
}

async function statusOf(taskId: string): Promise<string | undefined> {
  return (await loadTask(db().sql, taskId))?.status;
}

async function causes(taskId: string): Promise<string[]> {
  const rows = await db().sql<{ cause: string }[]>`
    SELECT payload ->> 'cause' AS cause FROM events WHERE task_id = ${taskId} AND kind = 'task.status' ORDER BY id`;
  return rows.map((row) => row.cause);
}

async function systemLines(conversationId: string): Promise<{ body: string; label: string }[]> {
  const rows = await db().sql<{ body: string; label: string }[]>`
    SELECT body, label FROM messages WHERE conversation_id = ${conversationId} AND role = 'system' ORDER BY id`;
  return [...rows];
}

test('a new message closes the waits without approval of its conversation, and only those', async () => {
  const { sql, owner } = db();
  // Positive: the old placeholder wait of "Saluti di prova".
  const stale = await waitingChat('Ciao, saluti di prova', 'the orchestrator is not available yet (task 1.10)');
  // Negative: a wait behind a pending approval in the same conversation.
  const { task: second } = await postUserMessage(sql, stale.conversationId, 'Usa Opus per questo');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${second.id}`}`;
  const [approval] = await owner<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${second.id}, 'budget', 'budget', ${owner.json({ model: 'opus' })}, 'L1') RETURNING id::text`;
  await moveTask(sql, second.id, 'waiting_user', { reason: 'approval needed: budget', cause: 'approval', approvalId: approval?.id ?? '' });
  // Negative: a wait in another conversation, and a card without conversation (D-101).
  const other = await waitingChat('Altra conversazione', 'limit reached: 5 of 5 steps');
  const card = await createTask(sql, { title: 'Carta finta' });
  await moveTask(sql, card.id, 'waiting_user', { reason: 'finished without evidence', cause: 'agent' });

  const { message, task } = await postUserMessage(sql, stale.conversationId, 'Andiamo avanti');

  assert.equal(await statusOf(stale.taskId), 'done');
  assert.equal((await causes(stale.taskId)).at(-1), 'superseded');
  const closed = await loadTask(sql, stale.taskId);
  assert.deepEqual((closed?.evidence.at(-1) as { kind?: string } | undefined)?.kind, 'superseded');
  assert.equal(await statusOf(second.id), 'waiting_user');
  assert.equal(await statusOf(other.taskId), 'waiting_user');
  assert.equal(await statusOf(card.id), 'waiting_user');
  assert.equal(task.status, 'ready');
  // One system line, L0, just before the new message.
  assert.deepEqual(await systemLines(stale.conversationId), [{ body: SUPERSEDED_TEXT, label: 'L0' }]);
  const [line] = await sql<{ id: string }[]>`SELECT id::text FROM messages WHERE conversation_id = ${stale.conversationId} AND role = 'system'`;
  assert.ok(line !== undefined && BigInt(line.id) < BigInt(message.id));
  assert.deepEqual(await systemLines(other.conversationId), []);
  // The line is for the user: the model of the new task does not read it.
  const view = await conversationView(sql, stale.conversationId, task.id, 10_000);
  assert.ok(view.messages.some((row) => row.body === 'Andiamo avanti'));
  assert.equal(view.messages.some((row) => row.body === SUPERSEDED_TEXT), false);
  // task.status carries the id, never the reason: only from, to and cause.
  const [payload] = await sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE task_id = ${stale.taskId} AND kind = 'task.status' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(payload?.payload, { from: 'waiting_user', to: 'done', cause: 'superseded' });

  // Nothing to close: no further line.
  await postUserMessage(sql, other.conversationId, 'Ancora');
  assert.equal(await statusOf(other.taskId), 'done');
  // The task of "Ancora" is still at work: not a wait, untouched.
  await owner`UPDATE jobs SET status = 'done' WHERE key IN (SELECT 'task:' || id FROM tasks WHERE conversation_id = ${other.conversationId} AND status = 'ready')`;
  await postUserMessage(sql, other.conversationId, 'E ancora');
  assert.equal((await systemLines(other.conversationId)).length, 1);
});

test('a wait whose approval was already decided is closed too: no pending approval holds it', async () => {
  const { sql, owner } = db();
  const chat = await waitingChat('Archivia la ricevuta finta', 'approval needed: budget', true);
  await owner`UPDATE approvals SET state = 'rejected', decided_at = now(), decided_via = 'web' WHERE id = ${chat.approvalId ?? ''}`;
  await postUserMessage(sql, chat.conversationId, 'Lascia stare');
  assert.equal(await statusOf(chat.taskId), 'done');
});

test('a pending approval of the task other than the one it waits for keeps the wait open', async () => {
  const { sql, owner } = db();
  const chat = await waitingChat('Archivia la ricevuta finta', 'approval needed: budget', true);
  await owner`UPDATE approvals SET state = 'rejected', decided_at = now(), decided_via = 'web' WHERE id = ${chat.approvalId ?? ''}`;
  await owner`
    INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${chat.taskId}, 'action', 'delete', ${owner.json({})}, 'L1')`;
  await postUserMessage(sql, chat.conversationId, 'Vai avanti');
  assert.equal(await statusOf(chat.taskId), 'waiting_user');
  assert.deepEqual(await systemLines(chat.conversationId), []);
});

test('a message refused by the scanner closes nothing', async () => {
  const { sql } = db();
  const chat = await createConversation(sql, { mode: 'work' });
  const { task } = await postUserMessage(sql, chat.id, 'Prima domanda');
  await db().owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  await moveTask(sql, task.id, 'waiting_user', { reason: 'finished without evidence', cause: 'executor' });
  await assert.rejects(postUserMessage(sql, chat.id, 'IBAN IT60X0542811101000000123456'));
  assert.equal(await statusOf(task.id), 'waiting_user');
});

test('Chiudi: a plain wait closes as done, cause user', async () => {
  const chat = await waitingChat('Riassumi le note finte', 'limit reached: 5 of 5 steps');
  const reply = await post(`/api/tasks/${chat.taskId}/dismiss`);
  assert.equal(reply.status, 200);
  assert.equal((reply.body.task as { status: string }).status, 'done');
  assert.equal((await causes(chat.taskId)).at(-1), 'user');
  // Already closed: refused.
  assert.equal((await post(`/api/tasks/${chat.taskId}/dismiss`)).status, 409);
});

test('Chiudi: a wait behind an approval closes and the approval expires, with its event', async () => {
  const { sql } = db();
  const chat = await waitingChat('Usa Opus', 'approval needed: budget', true);
  const reply = await post(`/api/tasks/${chat.taskId}/dismiss`);
  assert.equal(reply.status, 200);
  const [approval] = await sql<{ state: string }[]>`SELECT state FROM approvals WHERE id = ${chat.approvalId ?? ''}`;
  assert.equal(approval?.state, 'expired');
  const [event] = await sql<{ state: string }[]>`
    SELECT payload ->> 'state' AS state FROM events WHERE kind = 'approval.decided' AND payload ->> 'approvalId' = ${chat.approvalId ?? ''}`;
  assert.equal(event?.state, 'expired');
  // A decision arriving afterwards is refused: the task stays closed and nothing is scheduled.
  const late = await post(`/api/approvals/${chat.approvalId ?? ''}/decision`, '{"state":"approved"}');
  assert.equal(late.status, 409);
  assert.equal(await statusOf(chat.taskId), 'done');
  const jobs = await sql`SELECT 1 FROM jobs WHERE key = ${`task:${chat.taskId}`} AND status <> 'done'`;
  assert.equal(jobs.length, 0);
  const [payload] = await sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE task_id = ${chat.taskId} AND kind = 'task.status' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(payload?.payload, { from: 'waiting_user', to: 'done', cause: 'user' });
});

test('Chiudi: an archived conversation is fine; refused for a task not waiting, of a deleted conversation, unknown, or with fields', async () => {
  const { sql, owner } = db();
  const archived = await waitingChat('Archiviata', 'finished without evidence');
  await archiveConversation(sql, archived.conversationId, true);
  assert.equal((await post(`/api/tasks/${archived.taskId}/dismiss`)).status, 200);

  const running = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, running.id, 'In coda');
  assert.equal((await post(`/api/tasks/${task.id}/dismiss`)).status, 409);
  assert.equal(await statusOf(task.id), 'ready');

  const purged = await waitingChat('Da eliminare', 'finished without evidence');
  await archiveConversation(sql, purged.conversationId, true);
  await purgeConversation(sql, purged.conversationId);
  assert.equal((await post(`/api/tasks/${purged.taskId}/dismiss`)).status, 409);
  // Even if the purge had left it waiting, a deleted conversation refuses.
  await owner`UPDATE tasks SET status = 'waiting_user', waiting_reason = 'x' WHERE id = ${purged.taskId}`;
  assert.equal((await post(`/api/tasks/${purged.taskId}/dismiss`)).status, 409);
  assert.equal(await statusOf(purged.taskId), 'waiting_user');

  assert.equal((await post('/api/tasks/00000000-0000-4000-8000-000000000000/dismiss')).status, 404);
  const extra = await waitingChat('Campi in più', 'finished without evidence');
  assert.equal((await post(`/api/tasks/${extra.taskId}/dismiss`, '{"force":true}')).status, 400);
  assert.equal(await statusOf(extra.taskId), 'waiting_user');
});
