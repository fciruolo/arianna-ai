import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalModelError } from '@arianna/executors';

import {
  archiveConversation,
  ChatError,
  createConversation,
  listConversations,
  listMessages,
  loadConversation,
  postUserMessage,
  purgeConversation,
} from '../src/conversations.ts';
import { createWorker, processStepJob, retryTask, STEP_QUEUE, type StepExecutor, type StepOutcome } from '../src/engine.ts';
import { verifyEventChain } from '../src/events.ts';
import { loadFailure, recordFailure } from '../src/failures.ts';
import { createJobQueue } from '../src/jobs.ts';
import type { TaskLimits } from '../src/limits.ts';
import { attachQuestion, openFailureChat, QUESTION_HEADER } from '../src/system-chats.ts';
import { createTask, loadTask, TaskError } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const OPTIONS = {
  allowedActions: (): readonly string[] => [],
  agentLimits: (): TaskLimits => ({ maxSteps: 100, maxMinutes: 60 }),
};
// Every text the user wrote carries this word: no error row or event may hold it.
const MARK = 'segretofinto';

function executor(run: () => Promise<StepOutcome>): StepExecutor & { calls: number } {
  const state = {
    calls: 0,
    plan: () => ({ agent: 'arianna', executor: 'local', locality: 'local' as const }),
    async run() {
      state.calls += 1;
      return run();
    },
  };
  return state;
}

const downModel = () =>
  executor(() => {
    const tried = new LocalModelError('unavailable', `omlx is not reachable ${MARK}`, { endpoint: 'omlx' });
    throw new LocalModelError('unavailable', 'no local endpoint answered', { attempts: [tried] });
  });

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

/** A message in a new conversation, whose task fails on a local model that is down. */
async function failedTask(mode: 'private' | 'work' = 'private') {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode });
  const { task } = await postUserMessage(sql, conversation.id, `Domanda ${MARK}`);
  const worker = createWorker({ sql, executor: downModel(), ...OPTIONS, pollMs: 10, retryAfterMs: 0, endpointPort: (id) => (id === 'omlx' ? 7001 : undefined) });
  await worker.start();
  try {
    await waitFor(async () => (await loadTask(sql, task.id))?.status === 'failed');
  } finally {
    await worker.stop();
  }
  return { conversation, task };
}

test('a task that fails on a model that is down stores a readable error without text, and task.failed', async () => {
  const { sql } = db();
  const { task } = await failedTask();
  const failure = await loadFailure(sql, task.id);
  assert.equal(failure?.origin, 'local-model');
  assert.equal(failure.code, 'local-model.unavailable');
  assert.deepEqual(failure.details, { endpoint: 'omlx', endpoints: 1, port: 7001, attempts: 3 });
  assert.equal(failure.label, 'L2', 'the label of what the task had read');

  const events = await sql<{ label: string; payload: Record<string, unknown> }[]>`
    SELECT label, payload FROM events WHERE task_id = ${task.id} AND kind = 'task.failed'`;
  assert.deepEqual(events.map((event) => [event.label, event.payload]), [['L0', { origin: 'local-model', code: 'local-model.unavailable' }]]);
  const rows = await sql`SELECT * FROM task_errors WHERE task_id = ${task.id}`;
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(MARK));
});

test('a failed outcome keeps the executor only; a dead worker gives engine.lock-expired', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Domanda finta');
  const job = await createJobQueue(sql).claim(STEP_QUEUE, 'test');
  assert.ok(job !== undefined);
  assert.equal(await processStepJob(sql, executor(() => Promise.resolve({ kind: 'failed', reason: `cannot ${MARK}` })), job, 'test', OPTIONS), 'failed');
  const failure = await loadFailure(sql, task.id);
  assert.deepEqual([failure?.code, failure?.details], ['engine.step-failed', { executor: 'local' }]);

  const other = await postUserMessage(sql, conversation.id, 'Altra domanda finta');
  await sql`UPDATE jobs SET max_attempts = 1 WHERE key = ${`task:${other.task.id}`}`;
  const dead = await createJobQueue(sql).claim(STEP_QUEUE, 'dead');
  assert.ok(dead !== undefined);
  await db().owner`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = ${dead.id}::bigint`;
  const worker = createWorker({ sql, executor: executor(() => Promise.resolve({ kind: 'continue' })), ...OPTIONS, lockTimeoutMs: 1_000, pollMs: 20 });
  await worker.start();
  await worker.stop();
  assert.equal((await loadFailure(sql, other.task.id))?.code, 'engine.lock-expired');
});

test('retry puts a failed task back in the queue from the failed step; a second failure is the current error', async () => {
  const { sql } = db();
  const { task } = await failedTask();
  const retried = await retryTask(sql, task.id);
  assert.equal(retried.status, 'ready');
  const [job] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM jobs WHERE key = ${`task:${task.id}`} AND status = 'queued'`;
  assert.deepEqual([job?.status, job?.attempts], ['queued', 0]);
  const [event] = await sql<{ label: string; payload: Record<string, unknown> }[]>`
    SELECT label, payload FROM events WHERE task_id = ${task.id} AND kind = 'task.retried'`;
  assert.deepEqual([event?.label, event?.payload], ['L0', { step: 1 }]);
  await assert.rejects(retryTask(sql, task.id), TaskError, 'only a failed task');

  const claimed = await createJobQueue(sql).claim(STEP_QUEUE, 'test');
  assert.ok(claimed !== undefined);
  await processStepJob(sql, executor(() => Promise.resolve({ kind: 'failed', reason: 'again' })), claimed, 'test', OPTIONS);
  assert.equal((await loadFailure(sql, task.id))?.code, 'engine.step-failed');
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM task_errors WHERE task_id = ${task.id}`;
  assert.equal(count?.n, 2);
});

test('retry is refused for a task that did not fail and for an archived conversation', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Domanda finta');
  await assert.rejects(retryTask(sql, task.id), TaskError);

  const failed = await failedTask();
  await archiveConversation(sql, failed.conversation.id, true);
  await assert.rejects(retryTask(sql, failed.task.id), TaskError);
  assert.equal((await loadTask(sql, failed.task.id))?.status, 'failed');
});

test('task_errors refuses text-shaped details, a code outside its origin, and changes', async () => {
  const { sql } = db();
  const { task } = await failedTask();
  const insert = (code: string, origin: string, details: unknown) =>
    sql`INSERT INTO task_errors (task_id, origin, code, details) VALUES (${task.id}, ${origin}, ${code}, ${sql.json(details as never)})`;
  await assert.rejects(insert('engine.unknown', 'engine', { error: { nested: true } }), /scalar_details|check/i);
  await assert.rejects(insert('engine.unknown', 'engine', { error: ['a'] }), /check/i);
  await assert.rejects(insert('engine.unknown', 'engine', { error: 'x'.repeat(101) }), /check/i);
  await assert.rejects(insert('engine.unknown', 'tool', {}), /task_errors_code_in_origin/);
  await assert.rejects(insert('Engine Unknown', 'engine', {}), /check/i);
  await assert.rejects(sql`UPDATE task_errors SET code = 'engine.unknown' WHERE task_id = ${task.id}`, /permission denied|append-only/);
  await assert.rejects(sql`DELETE FROM task_errors WHERE task_id = ${task.id}`, /permission denied/);
  await assert.rejects(db().owner`DELETE FROM task_errors WHERE task_id = ${task.id}`, /append-only/);
});

test('the system chat of a failed task: same mode, its own list, the error as first message, opened once', async () => {
  const { sql } = db();
  const { conversation, task } = await failedTask('work');
  const chat = await openFailureChat(sql, task.id);
  assert.deepEqual(
    [chat.origin, chat.systemReason, chat.sourceTaskId, chat.sourceConversationId, chat.mode, chat.clearance, chat.questionAttached],
    ['system', 'failure', task.id, conversation.id, 'work', 'L1', false],
  );
  assert.equal(chat.workspace, null);
  const messages = await listMessages(sql, chat.id, { limit: 10 });
  assert.equal(messages.length, 1);
  const [first] = messages;
  assert.ok(first !== undefined);
  assert.deepEqual([first.role, first.label], ['system', 'L1']);
  assert.match(first.body, /local-model\.unavailable/);
  assert.doesNotMatch(first.body, new RegExp(MARK), 'the question is not attached by itself');

  assert.ok(!(await listConversations(sql)).some((item) => item.id === chat.id), 'not among the user conversations');
  assert.ok((await listConversations(sql, 50, { origin: 'system' })).some((item) => item.id === chat.id));

  assert.equal((await openFailureChat(sql, task.id)).id, chat.id, 'the second opening resumes the first');
  await archiveConversation(sql, chat.id, true);
  const reopened = await openFailureChat(sql, task.id);
  assert.equal(reopened.id, chat.id);
  assert.equal(reopened.archivedAt, null, 'opening it brings it back from the archive');
  assert.ok((await listConversations(sql, 50, { archived: true })).every((item) => item.id !== chat.id));
});

test('a private task opens a private system chat; a task without an error opens none', async () => {
  const { sql } = db();
  const { task } = await failedTask('private');
  const chat = await openFailureChat(sql, task.id);
  assert.deepEqual([chat.mode, chat.clearance], ['private', 'L2']);

  const conversation = await createConversation(sql, { mode: 'private' });
  const { task: fine } = await postUserMessage(sql, conversation.id, 'Domanda finta');
  await assert.rejects(openFailureChat(sql, fine.id), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(openFailureChat(sql, '00000000-0000-4000-8000-000000000000'), (error: unknown) => error instanceof ChatError && error.code === 'not-found');
});

test('the question is attached only when asked, once, with its label', async () => {
  const { sql } = db();
  const { task } = await failedTask('private');
  const chat = await openFailureChat(sql, task.id);
  const message = await attachQuestion(sql, chat.id);
  assert.equal(message.role, 'system');
  assert.equal(message.label, 'L2');
  assert.equal(message.body, `${QUESTION_HEADER}\nDomanda ${MARK}`);
  assert.equal((await loadConversation(sql, chat.id))?.questionAttached, true);
  await assert.rejects(attachQuestion(sql, chat.id), (error: unknown) => error instanceof ChatError && error.code === 'invalid');

  const ordinary = await createConversation(sql, { mode: 'private' });
  await assert.rejects(attachQuestion(sql, ordinary.id), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
});

test('the database keeps the system fields fixed and the mode of the source', async () => {
  const { sql } = db();
  const { task } = await failedTask('private');
  const chat = await openFailureChat(sql, task.id);
  await attachQuestion(sql, chat.id);
  await assert.rejects(sql`UPDATE conversations SET question_attached = false WHERE id = ${chat.id}`, /stays attached/);
  await assert.rejects(sql`UPDATE conversations SET origin = 'user', system_reason = NULL, source_task_id = NULL WHERE id = ${chat.id}`, /can change/);
  await assert.rejects(
    sql`INSERT INTO conversations (mode, clearance, origin, system_reason, source_task_id) VALUES ('work', 'L1', 'system', 'failure', ${task.id})`,
    /differs from the mode/,
  );
  await assert.rejects(sql`INSERT INTO conversations (mode, clearance, origin) VALUES ('private', 'L2', 'system')`, /conversations_system_fields/);
  await assert.rejects(sql`INSERT INTO conversations (mode, clearance, question_attached) VALUES ('private', 'L2', true)`, /conversations_system_fields/);
});

test('deleting a conversation deletes the system chats about its tasks, attached question included', async () => {
  const { sql } = db();
  const { conversation, task } = await failedTask('private');
  const chat = await openFailureChat(sql, task.id);
  await attachQuestion(sql, chat.id);
  await archiveConversation(sql, conversation.id, true);
  await purgeConversation(sql, conversation.id);

  const [row] = await db().owner<{ purged: boolean; n: number }[]>`
    SELECT purged_at IS NOT NULL AS purged, (SELECT count(*)::int FROM messages WHERE conversation_id = ${chat.id}) AS n
    FROM conversations WHERE id = ${chat.id}`;
  assert.deepEqual([row?.purged, row?.n], [true, 0]);
  const texts = await db().owner`SELECT body FROM messages WHERE conversation_id IN (${chat.id}, ${conversation.id})`;
  assert.equal(texts.length, 0);
  const purged = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'conversation.purged' ORDER BY events.id`;
  assert.ok(purged.some((event) => event.payload.conversationId === chat.id && event.payload.cause === 'source'));
  assert.ok(purged.some((event) => event.payload.conversationId === conversation.id));
  await assert.rejects(openFailureChat(sql, task.id), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
});

test('a system chat at work stops the purge of its source conversation', async () => {
  const { sql } = db();
  const { conversation, task } = await failedTask('private');
  const chat = await openFailureChat(sql, task.id);
  await postUserMessage(sql, chat.id, 'Perché?');
  await archiveConversation(sql, conversation.id, true);
  await assert.rejects(purgeConversation(sql, conversation.id), (error: unknown) => error instanceof ChatError && error.code === 'busy');
  assert.equal((await loadConversation(sql, chat.id))?.archivedAt, null, 'nothing changed');
});

test('recordFailure stores the effective label of the task', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work' });
  const { task } = await postUserMessage(sql, conversation.id, 'Domanda finta');
  await db().owner`UPDATE tasks SET status = 'failed' WHERE id = ${task.id}`;
  await recordFailure(sql, task.id, { origin: 'tool', code: 'tool.kb', details: { attempts: 1, note: 'dropped' } });
  const failure = await loadFailure(sql, task.id);
  assert.deepEqual([failure?.label, failure?.details], ['L1', { attempts: 1 }]);
});

test('the title of a system chat names the origin, never the question', async () => {
  const { sql } = db();
  const { task } = await failedTask('private');
  const chat = await openFailureChat(sql, task.id);
  assert.equal(chat.title, 'Perché è fallito: modello locale');
  assert.doesNotMatch(JSON.stringify(await listConversations(sql, 50, { origin: 'system' })), new RegExp(MARK));
});

test('a new system chat only for a task that is failed now; an open one is told a newer error', async () => {
  const { sql } = db();
  const retried = await failedTask('private');
  await retryTask(sql, retried.task.id);
  await assert.rejects(openFailureChat(sql, retried.task.id), (error: unknown) => error instanceof ChatError && error.message === 'the task is not failed');

  const { task } = await failedTask('private');
  const chat = await openFailureChat(sql, task.id);
  assert.equal((await openFailureChat(sql, task.id)).id, chat.id);
  assert.equal((await listMessages(sql, chat.id, { limit: 10 })).length, 1, 'the same error is not told twice');
  await retryTask(sql, task.id);
  const claimed = await createJobQueue(sql).claim(STEP_QUEUE, 'test');
  assert.ok(claimed !== undefined);
  await processStepJob(sql, executor(() => Promise.resolve({ kind: 'failed', reason: 'again' })), claimed, 'test', OPTIONS);
  assert.equal((await openFailureChat(sql, task.id)).id, chat.id);
  const messages = await listMessages(sql, chat.id, { limit: 10 });
  assert.equal(messages.length, 2);
  assert.match(messages[1]?.body ?? '', /fallito di nuovo[\s\S]*engine\.step-failed/);
  await assert.rejects(sql`UPDATE conversations SET source_error_id = NULL WHERE id = ${chat.id}`, /newer one/);
});

test('one system chat per task in the database; a new one after the old one is deleted', async () => {
  const { sql } = db();
  const { task } = await failedTask('private');
  const chat = await openFailureChat(sql, task.id);
  await assert.rejects(
    sql`INSERT INTO conversations (mode, clearance, origin, system_reason, source_task_id) VALUES ('private', 'L2', 'system', 'failure', ${task.id})`,
    /conversations_one_system_chat/,
  );
  await archiveConversation(sql, chat.id, true);
  await purgeConversation(sql, chat.id);
  const again = await openFailureChat(sql, task.id);
  assert.notEqual(again.id, chat.id);
  assert.equal((await listMessages(sql, again.id, { limit: 10 })).length, 1);
});

test('a system chat has no project; a task without a conversation gets a private one', async () => {
  const { sql } = db();
  const { task } = await failedTask('work');
  await assert.rejects(
    sql`INSERT INTO conversations (mode, clearance, workspace, origin, system_reason, source_task_id) VALUES ('work', 'L1', 'demo', 'system', 'failure', ${task.id})`,
    /has no project/,
  );
  const loose = await createTask(sql, { title: 'Carta finta', label: 'L1', clearance: 'L1', status: 'ready' });
  await db().owner`UPDATE tasks SET status = 'failed' WHERE id = ${loose.id}`;
  await recordFailure(sql, loose.id, { origin: 'engine', code: 'engine.lock-expired', details: {} });
  const chat = await openFailureChat(sql, loose.id);
  assert.deepEqual([chat.mode, chat.clearance, chat.sourceConversationId], ['private', 'L2', null]);
});

test('scalar_details: up to 12 keys of up to 40 characters, booleans allowed', async () => {
  const { sql } = db();
  const { task } = await failedTask();
  const insert = (details: Record<string, unknown>) =>
    sql`INSERT INTO task_errors (task_id, origin, code, details) VALUES (${task.id}, 'engine', 'engine.unknown', ${sql.json(details as never)})`;
  const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i)}`, i]));
  await insert({ ...keys(11), flag: true });
  await assert.rejects(insert(keys(13)), /check/i);
  await insert({ ['k'.repeat(40)]: 1 });
  await assert.rejects(insert({ ['k'.repeat(41)]: 1 }), /check/i);
});

test('the question: refused in an archived system chat, labeled L1 in a work one', async () => {
  const { sql } = db();
  const { task } = await failedTask('work');
  const chat = await openFailureChat(sql, task.id);
  await archiveConversation(sql, chat.id, true);
  assert.ok((await listConversations(sql, 50, { archived: true })).some((item) => item.id === chat.id), 'archived system chats are in the archive');
  await assert.rejects(attachQuestion(sql, chat.id), (error: unknown) => error instanceof ChatError && error.code === 'archived');
  await archiveConversation(sql, chat.id, false);
  assert.equal((await attachQuestion(sql, chat.id)).label, 'L1');
  await assert.rejects(listConversations(sql, 50, { archived: true, origin: 'system' }), ChatError);
});

test('the purge goes down a chain of system chats; a busy system chat says so', async () => {
  const { sql } = db();
  const { conversation, task } = await failedTask('private');
  const first = await openFailureChat(sql, task.id);
  const { task: inner } = await postUserMessage(sql, first.id, `Perché ${MARK}?`);
  await db().owner`UPDATE jobs SET status = 'failed' WHERE key = ${`task:${inner.id}`}`;
  await db().owner`UPDATE tasks SET status = 'failed' WHERE id = ${inner.id}`;
  await recordFailure(sql, inner.id, { origin: 'engine', code: 'engine.lock-expired', details: {} });
  const second = await openFailureChat(sql, inner.id);
  await attachQuestion(sql, second.id);
  await archiveConversation(sql, conversation.id, true);
  await purgeConversation(sql, conversation.id);
  const rows = await db().owner<{ id: string; purged: boolean }[]>`
    SELECT id::text, purged_at IS NOT NULL AS purged FROM conversations WHERE id IN (${first.id}, ${second.id})`;
  assert.deepEqual(rows.map((row) => row.purged), [true, true]);
  const left = await db().owner`SELECT 1 FROM messages WHERE conversation_id IN (${first.id}, ${second.id})`;
  assert.equal(left.length, 0);

  const busy = await failedTask('private');
  const chat = await openFailureChat(sql, busy.task.id);
  await postUserMessage(sql, chat.id, 'Perché?');
  await archiveConversation(sql, busy.conversation.id, true);
  await assert.rejects(purgeConversation(sql, busy.conversation.id), /system chat about this conversation is still at work/);
});
