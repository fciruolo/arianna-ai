// GET /api/tasks/waiting (D-091) against PostgreSQL: the tasks waiting for the
// user, oldest first, with the question of Arianna or the pending approval;
// L3 only counted, deleted conversations left out, Host and Origin checked.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';

import { archiveConversation, createConversation, postUserMessage } from '../src/conversations.ts';
import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { moveTask } from '../src/tasks.ts';
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

interface Reply {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

function call(method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, { method, agent: false, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // Not JSON.
        }
        resolve({ status: response.statusCode ?? 0, body, text });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

interface Row {
  id: string;
  conversationId: string | null;
  conversationTitle: string | null;
  mode: string | null;
  archived: boolean;
  title: string;
  since: string;
  reason: string;
  question: string | null;
  approvalId: string | null;
  messageId: string | null;
  waitingReason: string;
  label: string;
}

async function waiting(): Promise<{ tasks: Row[]; hidden: number }> {
  const reply = await call('GET', '/api/tasks/waiting');
  assert.equal(reply.status, 200, reply.text);
  return reply.body as unknown as { tasks: Row[]; hidden: number };
}

/** A user message whose task now waits for the user; `minutesAgo` dates its wait. */
async function waitingTask(text: string, reason: string, minutesAgo: number, approvalId?: string): Promise<{ conversationId: string; taskId: string; messageId: string }> {
  const { sql, owner } = db();
  const chat = await createConversation(sql, { mode: 'private' });
  const { message, task } = await postUserMessage(sql, chat.id, text);
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  await moveTask(sql, task.id, 'waiting_user', { reason, cause: 'executor', ...(approvalId === undefined ? {} : { approvalId }) });
  // The wait starts with the task.status event: the append-only log is moved back as the owner, guards off.
  await owner.unsafe('ALTER TABLE events DISABLE TRIGGER USER');
  try {
    await owner`UPDATE events SET ts = now() - make_interval(mins => ${minutesAgo}) WHERE task_id = ${task.id} AND kind = 'task.status'`;
  } finally {
    await owner.unsafe('ALTER TABLE events ENABLE TRIGGER USER');
  }
  return { conversationId: chat.id, taskId: task.id, messageId: message.id };
}

test('waiting tasks: question, approval and other, oldest first; L3 counted; deleted left out; archived marked', async () => {
  const { sql, owner } = db();
  // Positive cases.
  const question = await waitingTask('Prenota il dentista', 'finished without evidence', 30);
  const long = `Quale giorno preferisci per il dentista? ${'Martedì o giovedì. '.repeat(20)}`;
  const [asked] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id)
    VALUES (${question.conversationId}, 'assistant', 'L2', ${long}, ${question.taskId}) RETURNING id::text`;
  const other = await waitingTask('Riassumi le note', 'limit reached: 5 of 5 steps', 20);
  const plain = await waitingTask('Archivia la ricevuta finta', 'approval needed: budget', 10);
  const [approval] = await owner<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${plain.taskId}, 'budget', 'budget', ${owner.json({ model: 'opus' })}, 'L1') RETURNING id::text`;
  await owner`UPDATE tasks SET waiting_approval_id = ${approval?.id ?? ''} WHERE id = ${plain.taskId}`;
  await archiveConversation(sql, other.conversationId, true);
  // Negative cases: a task above L2, a task of a deleted conversation, a task not waiting.
  const secret = await waitingTask('Segreto finto', 'finished without evidence', 40);
  await owner`UPDATE tasks SET label = 'L3' WHERE id = ${secret.taskId}`;
  await owner`
    INSERT INTO messages (conversation_id, role, label, body, task_id)
    VALUES (${secret.conversationId}, 'assistant', 'L2', 'DOMANDA-NASCOSTA', ${secret.taskId})`;
  const purged = await waitingTask('Conversazione eliminata', 'finished without evidence', 50);
  await owner.unsafe('ALTER TABLE conversations DISABLE TRIGGER USER');
  try {
    await owner`UPDATE conversations SET archived_at = now(), purged_at = now(), title = NULL WHERE id = ${purged.conversationId}`;
  } finally {
    await owner.unsafe('ALTER TABLE conversations ENABLE TRIGGER USER');
  }
  const running = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, running.id, 'Ancora in coda');

  const listing = await waiting();
  assert.equal(listing.hidden, 1);
  assert.deepEqual(
    listing.tasks.map((row) => row.id),
    [question.taskId, other.taskId, plain.taskId],
  );
  const [first, second, third] = listing.tasks as [Row, Row, Row];
  assert.equal(first.reason, 'question');
  assert.equal(first.messageId, asked?.id);
  assert.equal(first.conversationId, question.conversationId);
  assert.equal(first.conversationTitle, 'Prenota il dentista');
  assert.equal(first.mode, 'private');
  assert.equal(first.title, 'Prenota il dentista');
  assert.equal(first.approvalId, null);
  assert.ok(first.question !== null && first.question.length <= 200 && first.question.endsWith('…'));
  assert.ok(first.question.startsWith('Quale giorno preferisci per il dentista? Martedì'));
  assert.equal(first.label, 'L2');
  assert.ok(Date.parse(first.since) < Date.parse(second.since));

  assert.equal(second.reason, 'other');
  assert.equal(second.question, null);
  assert.equal(second.archived, true);
  assert.equal(second.messageId, other.messageId);
  assert.equal(second.waitingReason, 'limit reached: 5 of 5 steps');

  assert.equal(third.reason, 'approval');
  assert.equal(third.approvalId, approval?.id);
  assert.equal(third.question, null);
  assert.equal(third.archived, false);

  assert.equal(/DOMANDA-NASCOSTA|Segreto finto|Conversazione eliminata|Ancora in coda/.test(JSON.stringify(listing)), false);

  // A decided approval no longer counts as one: the task is shown as waiting for another reason.
  await owner`UPDATE approvals SET state = 'rejected', decided_at = now(), decided_via = 'web' WHERE id = ${approval?.id ?? ''}`;
  const decided = (await waiting()).tasks.find((row) => row.id === plain.taskId);
  assert.ok(decided !== undefined);
  assert.equal(decided.reason, 'other');
  assert.equal(decided.approvalId, null);
});

test('waiting tasks: same protections as the other routes', async () => {
  const forged = await call('GET', '/api/tasks/waiting', { host: `evil.example:${String(server.port)}` });
  assert.equal(forged.status, 403);
  const cross = await call('GET', '/api/tasks/waiting', { origin: 'http://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal((await call('POST', '/api/tasks/waiting', { 'content-type': 'application/json', origin })).status, 405);
  // The route does not hide a task id route.
  assert.equal((await call('GET', '/api/tasks/00000000-0000-4000-8000-000000000000')).status, 404);
});
