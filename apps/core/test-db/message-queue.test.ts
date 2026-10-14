import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stopConversation, STOPPED_TEXT } from '../src/chat-stop.ts';
import { ChatError, createConversation, postUserMessage } from '../src/conversations.ts';
import { createWorker, retryTask, type StepExecutor } from '../src/engine.ts';
import { eraseConversation } from '../src/erase.ts';
import { loadFailure } from '../src/failures.ts';
import { closeIncognito } from '../src/incognito.ts';
import { TaskError } from '../src/tasks.ts';
import { dispatchQueues, editQueued, listQueue, MAX_QUEUED, postOrQueue, removeQueued, resumeQueue, sendQueuedNow } from '../src/message-queue.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
// A made-up IBAN with a valid checksum: the scanner must flag it.
const FAKE_IBAN = 'IT60X0542811101000000123456';

async function waitFor(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function userBodies(conversationId: string): Promise<string[]> {
  const rows = await db().owner<{ body: string }[]>`
    SELECT body FROM messages WHERE conversation_id = ${conversationId} AND role = 'user' ORDER BY id`;
  return rows.map((row) => row.body);
}

/** The task of the conversation still at work ends, as a finished answer does. */
async function finishWork(conversationId: string): Promise<void> {
  const { owner } = db();
  await owner`UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL
    WHERE key IN (SELECT 'task:' || id FROM tasks WHERE conversation_id = ${conversationId}) AND status IN ('queued', 'running')`;
  await owner`UPDATE tasks SET status = 'done', assignee = 'user' WHERE conversation_id = ${conversationId} AND status IN ('ready', 'running')`;
}

test('a message with nothing at work is sent at once; one written during an answer waits in the queue (D-218)', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const first = await postOrQueue(sql, conversation.id, 'Cerca le fatture di settembre');
  assert.ok('sent' in first);
  const second = await postOrQueue(sql, conversation.id, 'e anche quelle di agosto');
  assert.ok('queued' in second);
  assert.equal(second.queued.label, 'L2');
  assert.deepEqual(await userBodies(conversation.id), ['Cerca le fatture di settembre']);
  const queue = await listQueue(sql, conversation.id);
  assert.deepEqual([queue.paused, queue.messages.map((message) => message.body)], [false, ['e anche quelle di agosto']]);
  // The events carry the conversation only, never the text.
  const events = await owner<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'conversation.queue'`;
  assert.ok(events.length > 0);
  for (const event of events) assert.deepEqual(Object.keys(event.payload), ['conversationId']);
});

test('a queued message is checked as a sent one: the scanner of a work conversation, the length, the cap', async () => {
  const { sql } = db();
  const work = await createConversation(sql, { mode: 'work', project: 'fake-site', projects: ['fake-site'] });
  assert.ok('sent' in (await postOrQueue(sql, work.id, 'Rifai la pagina dei contatti')));
  await assert.rejects(postOrQueue(sql, work.id, `Paga su ${FAKE_IBAN}`), (error) => error instanceof ChatError && error.code === 'scanner');
  await assert.rejects(postOrQueue(sql, work.id, '   '), (error) => error instanceof ChatError && error.code === 'invalid');
  const queued = await postOrQueue(sql, work.id, 'poi aggiorna il README');
  assert.ok('queued' in queued);
  assert.equal(queued.queued.label, 'L1');
  // An edit goes through the same checks.
  await assert.rejects(editQueued(sql, queued.queued.id, `Paga su ${FAKE_IBAN}`), (error) => error instanceof ChatError && error.code === 'scanner');
  for (let index = 1; index < MAX_QUEUED; index += 1) await postOrQueue(sql, work.id, `passo ${String(index)}`);
  await assert.rejects(postOrQueue(sql, work.id, 'uno di troppo'), (error) => error instanceof ChatError && error.code === 'busy');
  assert.equal((await listQueue(sql, work.id)).messages.length, MAX_QUEUED);
});

test('"Modifica" and "Togli" change the queue before the message leaves; a removed message is gone', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await postOrQueue(sql, conversation.id, 'Prima domanda');
  const queued = await postOrQueue(sql, conversation.id, 'e anche agosto');
  assert.ok('queued' in queued);
  const changed = await editQueued(sql, queued.queued.id, 'e anche luglio');
  assert.equal(changed.body, 'e anche luglio');
  await removeQueued(sql, queued.queued.id);
  assert.deepEqual((await listQueue(sql, conversation.id)).messages, []);
  await assert.rejects(removeQueued(sql, queued.queued.id), (error) => error instanceof ChatError && error.code === 'not-found');
  await assert.rejects(editQueued(sql, queued.queued.id, 'x'), (error) => error instanceof ChatError && error.code === 'not-found');
});

test('the queue leaves one message at a time, in order, only when the answer at work has ended', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await postOrQueue(sql, conversation.id, 'uno');
  await postOrQueue(sql, conversation.id, 'due');
  await postOrQueue(sql, conversation.id, 'tre');
  await dispatchQueues(sql);
  assert.deepEqual(await userBodies(conversation.id), ['uno']);
  await finishWork(conversation.id);
  await dispatchQueues(sql);
  // "due" is at work now: "tre" waits for it.
  await dispatchQueues(sql);
  assert.deepEqual(await userBodies(conversation.id), ['uno', 'due']);
  await finishWork(conversation.id);
  await dispatchQueues(sql);
  assert.deepEqual(await userBodies(conversation.id), ['uno', 'due', 'tre']);
  assert.deepEqual((await listQueue(sql, conversation.id)).messages, []);
});

test('"Ferma" stops a step not yet taken: the task fails as stopped by the user, its line follows, the queue pauses', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const sent = await postOrQueue(sql, conversation.id, 'Lavoro lungo');
  assert.ok('sent' in sent);
  await postOrQueue(sql, conversation.id, 'poi questo');
  const result = await stopConversation(sql, conversation.id, { stopTask: () => false });
  assert.equal(result.stopped, 1);
  const [state] = await owner<{ task: string; job: string }[]>`
    SELECT t.status AS task, (SELECT j.status FROM jobs j WHERE j.key = ${`task:${sent.sent.task.id}`} ORDER BY j.id DESC LIMIT 1) AS job
    FROM tasks t WHERE t.id = ${sent.sent.task.id}`;
  assert.deepEqual(state, { task: 'failed', job: 'failed' });
  assert.equal((await loadFailure(sql, sent.sent.task.id))?.code, 'engine.user-stopped');
  const [line] = await owner<{ body: string; label: string }[]>`
    SELECT body, label FROM messages WHERE conversation_id = ${conversation.id} AND role = 'system' AND task_id = ${sent.sent.task.id}`;
  assert.deepEqual(line, { body: STOPPED_TEXT, label: 'L0' });
  // Paused: nothing leaves alone.
  assert.equal((await listQueue(sql, conversation.id)).paused, true);
  await dispatchQueues(sql);
  assert.deepEqual(await userBodies(conversation.id), ['Lavoro lungo']);
  // A new message after "Ferma" goes at once, the paused one still waits.
  assert.ok('sent' in (await postOrQueue(sql, conversation.id, 'cambio strada')));
  assert.equal((await listQueue(sql, conversation.id)).messages.length, 1);
});

test('"Invia ora" sends a queued message of a paused queue; refused while an answer works; "Riprendi la coda" unpauses', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await postOrQueue(sql, conversation.id, 'primo');
  const a = await postOrQueue(sql, conversation.id, 'secondo');
  const b = await postOrQueue(sql, conversation.id, 'terzo');
  assert.ok('queued' in a && 'queued' in b);
  await assert.rejects(sendQueuedNow(sql, a.queued.id), (error) => error instanceof ChatError && error.code === 'busy');
  await stopConversation(sql, conversation.id, { stopTask: () => false });
  // "terzo" first: the user chooses which.
  await sendQueuedNow(sql, b.queued.id);
  assert.deepEqual(await userBodies(conversation.id), ['primo', 'terzo']);
  assert.equal((await listQueue(sql, conversation.id)).paused, true);
  await finishWork(conversation.id);
  await resumeQueue(sql, conversation.id);
  await dispatchQueues(sql);
  assert.deepEqual(await userBodies(conversation.id), ['primo', 'terzo', 'secondo']);
  // An emptied queue is not paused any more.
  const queue = await listQueue(sql, conversation.id);
  assert.deepEqual([queue.paused, queue.messages.length], [false, 0]);
});

test('"Ferma" with nothing at work stops nothing and does not pause the queue', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  assert.deepEqual(await stopConversation(sql, conversation.id, { stopTask: () => false }), { stopped: 0, left: 0 });
  assert.equal((await listQueue(sql, conversation.id)).paused, false);
});

test('"Ferma" stops the step at work through the worker, as stopped by the user', async () => {
  const { sql, owner } = db();
  let started: string | undefined;
  let aborted: unknown;
  const executor: StepExecutor = {
    plan: () => ({ agent: 'arianna', executor: 'local-model', locality: 'local' }),
    run: (ctx) =>
      new Promise((_resolve, reject) => {
        started = ctx.task.id;
        ctx.signal.addEventListener('abort', () => {
          aborted = ctx.signal.reason;
          reject(new Error('stopped'));
        });
      }),
  };
  const worker = createWorker({ sql, executor, allowedActions: () => [], agentLimits: () => ({ maxSteps: 10, maxMinutes: 10 }), pollMs: 10, retryAfterMs: 0 });
  // Only this step in the queue: the steps of the other tests never ran.
  await owner`UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL WHERE status IN ('queued', 'running')`;
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Lavoro lungo');
  await worker.start();
  try {
    await waitFor(() => started === task.id);
    const result = await stopConversation(sql, conversation.id, { stopTask: (taskId) => worker.stopTask(taskId, 'user'), pollMs: 20 });
    assert.equal(result.stopped, 1);
    assert.equal(aborted, 'user');
    await waitFor(async () => (await owner`SELECT 1 FROM tasks WHERE id = ${task.id} AND status = 'failed'`).length === 1);
    assert.equal((await loadFailure(sql, task.id))?.code, 'engine.user-stopped');
    const lines = await owner`SELECT 1 FROM messages WHERE task_id = ${task.id} AND role = 'system' AND body = ${STOPPED_TEXT}`;
    assert.equal(lines.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await owner`SELECT 1 FROM jobs WHERE key = ${`task:${task.id}`} AND status IN ('queued', 'running')`).length, 0);
  } finally {
    await worker.stop();
  }
});

test('the purge of an incognito conversation takes its queue with it; nothing is queued in a purged one', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private', incognito: true });
  await postOrQueue(sql, conversation.id, 'Segreto in corso');
  const queued = await postOrQueue(sql, conversation.id, 'Testo in coda da non lasciare');
  assert.ok('queued' in queued);
  await stopConversation(sql, conversation.id, { stopTask: () => false });
  await closeIncognito(sql, conversation.id, 'user', { stopTask: () => false });
  assert.equal((await owner`SELECT 1 FROM queued_messages WHERE conversation_id = ${conversation.id}`).length, 0);
  assert.equal((await owner`SELECT 1 FROM message_queue_pauses WHERE conversation_id = ${conversation.id}`).length, 0);
  await assert.rejects(owner`INSERT INTO queued_messages (conversation_id, label, body) VALUES (${conversation.id}, 'L2', 'dopo')`, /purged/);
});

test('a message written outside the chat (Telegram, GOD) is at work for the queue too', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, conversation.id, 'uno');
  const posted = await postOrQueue(sql, conversation.id, 'due');
  assert.ok('queued' in posted);
});

test('a queued message the checks now refuse pauses its queue only; the other conversations go on', async () => {
  const { sql, owner } = db();
  const work = await createConversation(sql, { mode: 'work', project: 'fake-site', projects: ['fake-site'] });
  const other = await createConversation(sql, { mode: 'private' });
  await postOrQueue(sql, work.id, 'primo');
  await postOrQueue(sql, other.id, 'altro');
  await postOrQueue(sql, other.id, 'altro in coda');
  // As if the rules had changed after it was queued: the scanner refuses it now.
  await owner`INSERT INTO queued_messages (conversation_id, label, body) VALUES (${work.id}, 'L1', ${`Paga su ${FAKE_IBAN}`})`;
  await finishWork(work.id);
  await finishWork(other.id);
  const errors: unknown[] = [];
  await dispatchQueues(sql, undefined, (error) => errors.push(error));
  assert.equal((await listQueue(sql, work.id)).paused, true);
  assert.deepEqual(await userBodies(work.id), ['primo']);
  assert.deepEqual(await userBodies(other.id), ['altro', 'altro in coda']);
  // A refusal of the checks is not an error of the core.
  assert.deepEqual(errors, []);
});

test('«Elimina» takes the queue with the conversation', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await postOrQueue(sql, conversation.id, 'primo');
  await postOrQueue(sql, conversation.id, 'in coda da cancellare');
  await stopConversation(sql, conversation.id, { stopTask: () => false });
  await eraseConversation(sql, conversation.id);
  assert.equal((await owner`SELECT 1 FROM queued_messages WHERE conversation_id = ${conversation.id}`).length, 0);
  assert.equal((await owner`SELECT 1 FROM message_queue_pauses WHERE conversation_id = ${conversation.id}`).length, 0);
});

test('«Riprova» on a stopped answer waits while another answer of the conversation is at work', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const first = await postOrQueue(sql, conversation.id, 'Lavoro lungo');
  assert.ok('sent' in first);
  await stopConversation(sql, conversation.id, { stopTask: () => false });
  // A new message after "Ferma" leaves at once and is at work.
  assert.ok('sent' in (await postOrQueue(sql, conversation.id, 'cambio strada')));
  await assert.rejects(retryTask(sql, first.sent.task.id), TaskError);
  await finishWork(conversation.id);
  assert.equal((await retryTask(sql, first.sent.task.id)).status, 'ready');
});
