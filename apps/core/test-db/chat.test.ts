import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ChatError,
  createConversation,
  listConversations,
  listMessages,
  loadConversation,
  postUserMessage,
} from '../src/conversations.ts';
import { startLiveFeed, type LiveMessage } from '../src/live.ts';
import { openReply } from '../src/reply.ts';
import { createTask, loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
// A made-up IBAN with a valid checksum: the scanner must flag it.
const FAKE_IBAN = 'IT60X0542811101000000123456';

async function eventsOf(taskId: string) {
  return db().sql<{ kind: string; label: string; payload: Record<string, unknown> }[]>`
    SELECT kind, label, payload FROM events WHERE task_id = ${taskId} ORDER BY events.id`;
}

test('the clearance of a conversation follows its mode', async () => {
  const work = await createConversation(db().sql, { mode: 'work', workspace: 'repos/fake-site', allowlist: ['repos/fake-site'] });
  const own = await createConversation(db().sql, { mode: 'private' });
  assert.deepEqual([work.clearance, work.effectiveLabel, work.workspace], ['L1', 'L0', 'repos/fake-site']);
  assert.deepEqual([own.clearance, own.effectiveLabel, own.workspace], ['L2', 'L0', null]);
  const ids = (await listConversations(db().sql)).map((conversation) => conversation.id);
  assert.ok(ids.includes(work.id) && ids.includes(own.id));
});

test('a conversation gets no workspace outside ARIANNA_HOME, and only in work mode', async () => {
  for (const workspace of ['/etc', '../outside', 'a/../../b', 'c:drive', '']) {
    await assert.rejects(createConversation(db().sql, { mode: 'work', workspace }), ChatError, workspace);
  }
  await assert.rejects(createConversation(db().sql, { mode: 'private', workspace: 'repos/x' }), ChatError);
  await assert.rejects(createConversation(db().sql, { mode: 'work', workspace: 'repos/x', allowlist: ['repos/y'] }), /not in cloud.allowlist/);
  await assert.rejects(createConversation(db().sql, { mode: 'work', workspace: 'repos/x' }), /not in cloud.allowlist/);
  await assert.rejects(createConversation(db().sql, { mode: 'secret' as 'work' }), ChatError);
});

test('the database keeps mode and clearance together and frozen', async () => {
  const { sql, owner } = db();
  await assert.rejects(sql`INSERT INTO conversations (mode, clearance) VALUES ('work', 'L2')`, /conversations_clearance_follows_mode/);
  await assert.rejects(sql`INSERT INTO conversations (mode, clearance) VALUES ('private', 'L3')`, /conversations_clearance_follows_mode/);
  const conversation = await createConversation(sql, { mode: 'private' });
  await assert.rejects(sql`UPDATE conversations SET mode = 'work', clearance = 'L1' WHERE id = ${conversation.id}`, /only the effective label/);
  await sql`UPDATE conversations SET effective_label = 'L1' WHERE id = ${conversation.id}`;
  await assert.rejects(sql`UPDATE conversations SET effective_label = 'L0' WHERE id = ${conversation.id}`, /cannot go down/);
  // The role of the core cannot delete; the owner, who can, meets the trigger.
  await assert.rejects(sql`DELETE FROM conversations WHERE id = ${conversation.id}`, /permission denied/);
  await assert.rejects(owner`DELETE FROM conversations WHERE id = ${conversation.id}`, /append-only/);
});

test('a user message starts a task of Arianna in its conversation, with the conversation clearance', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { message, task } = await postUserMessage(db().sql, conversation.id, 'Riepiloga la fattura finta 42\nsecond line');

  assert.deepEqual([message.role, message.channel, message.label, message.taskId], ['user', 'web', 'L2', task.id]);
  assert.deepEqual(
    [task.conversationId, task.assignee, task.status, task.label, task.clearance, task.effectiveLabel, task.title],
    [conversation.id, 'arianna', 'ready', 'L2', 'L2', 'L2', 'Riepiloga la fattura finta 42'],
  );
  assert.equal((await loadConversation(db().sql, conversation.id))?.effectiveLabel, 'L2');
  const [job] = await db().sql<{ key: string; status: string }[]>`SELECT key, status FROM jobs WHERE key = ${`task:${task.id}`}`;
  assert.deepEqual(job, { key: `task:${task.id}`, status: 'queued' });

  // Events carry ids only, never the text.
  const events = await eventsOf(task.id);
  assert.deepEqual(events.map((event) => event.kind), ['task.created', 'message.created']);
  assert.doesNotMatch(JSON.stringify(events), /fattura/);
});

test('a work conversation holds L1, and refuses what the scanner flags', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work' });
  const { message, task } = await postUserMessage(db().sql, conversation.id, 'Aggiungi un test al sito finto');
  assert.deepEqual([message.label, task.clearance, task.effectiveLabel], ['L1', 'L1', 'L1']);

  const before = await listMessages(db().sql, conversation.id, { limit: 50 });
  await assert.rejects(
    postUserMessage(db().sql, conversation.id, `Paga sul conto ${FAKE_IBAN}`),
    (error: unknown) => error instanceof ChatError && error.code === 'scanner' && !error.message.includes(FAKE_IBAN),
  );
  // Nothing of the refused message is left: no message, no task.
  assert.deepEqual(await listMessages(db().sql, conversation.id, { limit: 50 }), before);
  const [{ count } = { count: '' }] = await db().sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM tasks WHERE conversation_id = ${conversation.id}`;
  assert.equal(count, '1');
});

test('a private conversation accepts what the scanner flags: it stays local', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { message } = await postUserMessage(db().sql, conversation.id, `IBAN finto ${FAKE_IBAN}`);
  assert.equal(message.label, 'L2');
});

test('a message to a missing conversation, or an empty one, is refused', async () => {
  await assert.rejects(postUserMessage(db().sql, '7d444840-9dc0-11d1-b245-5ffdce74fad2', 'ciao'), (error: unknown) => error instanceof ChatError && error.code === 'not-found');
  await assert.rejects(postUserMessage(db().sql, 'nope', 'ciao'), (error: unknown) => error instanceof ChatError && error.code === 'not-found');
  const conversation = await createConversation(db().sql, { mode: 'private' });
  await assert.rejects(postUserMessage(db().sql, conversation.id, '  '), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
});

test('the database keeps messages within the clearance, tied to their own tasks, and unchanged', async () => {
  const { sql, owner } = db();
  const work = await createConversation(sql, { mode: 'work' });
  await assert.rejects(
    sql`INSERT INTO messages (conversation_id, role, label, body) VALUES (${work.id}, 'assistant', 'L2', 'x')`,
    /above the clearance/,
  );
  await assert.rejects(sql`INSERT INTO messages (conversation_id, role, label, body) VALUES (${work.id}, 'bot', 'L1', 'x')`, /messages_role_check/);

  const other = await createConversation(sql, { mode: 'work' });
  const { task } = await postUserMessage(sql, other.id, 'altro');
  await assert.rejects(
    sql`INSERT INTO messages (conversation_id, role, label, body, task_id) VALUES (${work.id}, 'assistant', 'L1', 'x', ${task.id})`,
    /does not belong/,
  );
  // A task never has a clearance above its conversation's, and never moves to another one.
  await assert.rejects(createTask(sql, { title: 't', conversationId: work.id, clearance: 'L2' }), /above the clearance/);
  await assert.rejects(sql`UPDATE tasks SET conversation_id = ${work.id} WHERE id = ${task.id}`, /cannot change/);
  await assert.rejects(sql`UPDATE tasks SET clearance = 'L2' WHERE id = ${task.id}`, /above the clearance/);
  await assert.rejects(sql`INSERT INTO conversations (mode, clearance, workspace) VALUES ('private', 'L2', 'repos/x')`, /conversations_workspace_only_work/);

  await assert.rejects(sql`UPDATE messages SET body = 'changed' WHERE task_id = ${task.id}`, /permission denied/);
  await assert.rejects(sql`DELETE FROM messages WHERE task_id = ${task.id}`, /permission denied/);
  await assert.rejects(owner`UPDATE messages SET body = 'changed' WHERE task_id = ${task.id}`, /append-only/);
  await assert.rejects(owner`DELETE FROM messages WHERE task_id = ${task.id}`, /append-only/);
});

test('the history pages backwards and comes back in chronological order', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  for (const text of ['uno', 'due', 'tre', 'quattro', 'cinque']) await postUserMessage(db().sql, conversation.id, text);
  const latest = await listMessages(db().sql, conversation.id, { limit: 2 });
  assert.deepEqual(latest.map((message) => message.body), ['quattro', 'cinque']);
  const earlier = await listMessages(db().sql, conversation.id, { limit: 10, beforeId: latest[0]?.id ?? '' });
  assert.deepEqual(earlier.map((message) => message.body), ['uno', 'due', 'tre']);
});

test('a reply streams fragments to the live feed, then stores the message through the gateway', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work' });
  const { task } = await postUserMessage(sql, conversation.id, 'Scrivi un saluto');
  const live = await startLiveFeed(sql);
  const received: LiveMessage[] = [];
  const stop = await live.subscribe({ send: (message) => received.push(message) });
  try {
    const reply = await openReply(sql, task.id);
    await reply.delta('Ciao, ');
    await reply.delta('mondo');
    // The executor says it read L0 only: the task had read L1, so the message is L1.
    const result = await reply.finish('Ciao, mondo', 'L0');
    assert.ok(result.stored);
    assert.deepEqual([result.message.role, result.message.label, result.message.body, result.message.taskId], ['assistant', 'L1', 'Ciao, mondo', task.id]);

    const [log] = await sql<{ target: string; locality: string; decision: string; label: string }[]>`
      SELECT target, locality, decision, label FROM gateway_log WHERE task_id = ${task.id}`;
    assert.deepEqual(log, { target: 'web', locality: 'local', decision: 'allow', label: 'L1' });

    await waitFor(() => received.some((message) => message.type === 'event' && message.event.kind === 'message.created' && message.event.payload !== null && (message.event.payload as Record<string, unknown>).replyId === reply.id));
    const deltas = received.filter((message) => message.type === 'delta');
    assert.deepEqual(deltas.map((delta) => [delta.replyId, delta.seq, delta.text, delta.conversationId]), [
      [reply.id, 0, 'Ciao, ', conversation.id],
      [reply.id, 1, 'mondo', conversation.id],
    ]);
    await assert.rejects(reply.delta('more'), /finished/);
  } finally {
    stop();
    await live.close();
  }
});

test('a reply above the conversation clearance is refused before the gateway', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work' });
  const { task } = await postUserMessage(sql, conversation.id, 'Leggi la fattura finta');
  for (const label of ['L2', 'L9'] as const) {
    const reply = await openReply(sql, task.id);
    const result = await reply.finish('contenuto privato finto', label as 'L2');
    assert.deepEqual(result, { stored: false, reason: 'above-clearance', label: 'L2' });
  }
  // Nothing was offered to the gateway, so it logged no allowed exit.
  assert.equal((await sql`SELECT 1 FROM gateway_log WHERE task_id = ${task.id}`).length, 0);
});

test('an L3 reply is never stored, not even in a private conversation', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Leggi il segreto finto');
  const reply = await openReply(sql, task.id);
  const result = await reply.finish('contenuto L3 finto', 'L3');
  assert.deepEqual(result, { stored: false, reason: 'above-clearance', label: 'L3' });
  assert.equal((await listMessages(sql, conversation.id, { limit: 10 })).filter((message) => message.role === 'assistant').length, 0);
});

test('only a task of a conversation can reply', async () => {
  const task = await createTask(db().sql, { title: 'Senza chat' });
  await assert.rejects(openReply(db().sql, task.id), /does not answer in a conversation/);
  assert.equal((await loadTask(db().sql, task.id))?.conversationId, null);
});

test('the live feed sends missed events first, then live ones, each once and in order', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const live = await startLiveFeed(sql);
  const [{ last } = { last: '0' }] = await sql<{ last: string }[]>`SELECT max(id)::text AS last FROM events`;
  // Written before the subscription: the subscriber asks from an older id.
  await postUserMessage(sql, conversation.id, 'prima');
  const received: string[] = [];
  const stop = await live.subscribe({ send: (message) => { if (message.type === 'event') received.push(message.event.id); } }, last);
  try {
    await postUserMessage(sql, conversation.id, 'dopo');
    const [{ now } = { now: '0' }] = await sql<{ now: string }[]>`SELECT max(id)::text AS now FROM events`;
    await waitFor(() => received.at(-1) === now);
    const expected = await sql<{ id: string }[]>`SELECT id::text FROM events WHERE id > ${last}::bigint ORDER BY events.id`;
    assert.deepEqual(received, expected.map((row) => row.id));
  } finally {
    stop();
    await live.close();
  }
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the live feed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
