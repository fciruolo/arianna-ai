import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  archiveConversation,
  ChatError,
  createConversation,
  listConversations,
  listMessages,
  loadConversation,
  postUserMessage,
  renameConversation,
  taskTitle,
} from '../src/conversations.ts';
import { loadMigrations } from '../src/db/migrate.ts';
import { startLiveFeed, type LiveMessage } from '../src/live.ts';
import { openReply } from '../src/reply.ts';
import { createTask, loadTask } from '../src/tasks.ts';
import { ensureTelegramState } from '../src/telegram/channel.ts';
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

test('the first message names the conversation; the user can rename it, on one line', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  assert.equal(conversation.title, null);
  await postUserMessage(db().sql, conversation.id, '  Prepara la bozza\r della mail finta\nseconda riga');
  assert.equal((await loadConversation(db().sql, conversation.id))?.title, 'Prepara la bozza della mail finta');
  await postUserMessage(db().sql, conversation.id, 'Un altro messaggio');
  assert.equal((await loadConversation(db().sql, conversation.id))?.title, 'Prepara la bozza della mail finta');

  const renamed = await renameConversation(db().sql, conversation.id, '  Mail al fornitore finto ');
  assert.equal(renamed.title, 'Mail al fornitore finto');
  for (const title of ['', '   ', 'due\nrighe', 'x'.repeat(201), `a${String.fromCharCode(0)}b`, 42, null]) {
    await assert.rejects(renameConversation(db().sql, conversation.id, title), ChatError, String(title));
  }
  assert.equal((await renameConversation(db().sql, conversation.id, 'è'.repeat(200))).title, 'è'.repeat(200));
  await renameConversation(db().sql, conversation.id, 'Mail al fornitore finto');
  await assert.rejects(renameConversation(db().sql, '00000000-0000-0000-0000-000000000000', 'Titolo'), /does not exist/);
  // The event says that it changed, never what it says.
  const [event] = await db().sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE kind = 'conversation.title' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(event?.payload, { conversationId: conversation.id });
  // The database holds the same rule.
  await assert.rejects(db().sql`UPDATE conversations SET title = ${'a\nb'} WHERE id = ${conversation.id}`, /check constraint/);
  await assert.rejects(db().sql`UPDATE conversations SET title = '' WHERE id = ${conversation.id}`, /check constraint/);
  await assert.rejects(db().sql`UPDATE conversations SET title = NULL WHERE id = ${conversation.id}`, /changed, never removed/);
});

test('the database lets title, model and archive change, and nothing else', async () => {
  const { sql } = db();
  const work = await createConversation(sql, { mode: 'work' });
  await sql`UPDATE conversations SET title = 'Diretto', model = 'opus', archived_at = now() WHERE id = ${work.id}`;
  await sql`UPDATE conversations SET archived_at = NULL, model = NULL WHERE id = ${work.id}`;
  const updated = await loadConversation(sql, work.id);
  assert.deepEqual([updated?.title, updated?.model, updated?.archivedAt], ['Diretto', null, null]);
  await assert.rejects(sql`UPDATE conversations SET workspace = 'repos/x' WHERE id = ${work.id}`, /only the effective label, title, model and archive/);
  await assert.rejects(sql`UPDATE conversations SET created_at = now() - interval '1 day' WHERE id = ${work.id}`, /only the effective label/);
});

test('migration 0011 names the conversations written before it as taskTitle would', async () => {
  const { sql, owner } = db();
  // Messages written straight into the table, as before the migration: no title yet.
  const cases: [string, string | null][] = [
    ['\n  Primo   messaggio\tfinto  \nseconda riga', 'Primo messaggio finto'],
    [' \nciao', 'ciao'],
    [' Ciao finto ', 'Ciao finto'],
    [`${'parola '.repeat(20)}fine`, taskTitle(`${'parola '.repeat(20)}fine`).replace(/\s+/g, ' ')],
    [`${'x'.repeat(100)}\nresto`, `${'x'.repeat(79)}…`],
  ];
  const ids: string[] = [];
  for (const [body] of cases) {
    const conversation = await createConversation(sql, { mode: 'private' });
    await sql`INSERT INTO messages (conversation_id, role, label, body) VALUES (${conversation.id}, 'user', 'L2', ${body})`;
    await sql`INSERT INTO messages (conversation_id, role, label, body) VALUES (${conversation.id}, 'user', 'L2', 'Secondo messaggio')`;
    ids.push(conversation.id);
  }
  const empty = await createConversation(sql, { mode: 'private' });
  const migration = loadMigrations().find((candidate) => candidate.version === '0011');
  const backfill = migration?.sql.split('-- Conversations written before this migration')[1];
  assert.ok(backfill !== undefined);
  await owner.unsafe(`--${backfill}`);
  for (const [index, [body, expected]] of cases.entries()) {
    assert.equal((await loadConversation(sql, ids[index] ?? ''))?.title, expected, JSON.stringify(body));
    assert.equal(expected, taskTitle(body).replace(/\s+/g, ' '), 'the rule of a new conversation');
  }
  assert.equal((await loadConversation(sql, empty.id))?.title, null);
});

test('a work conversation refuses a title the scanner flags; a private one keeps it', async () => {
  const work = await createConversation(db().sql, { mode: 'work' });
  await assert.rejects(renameConversation(db().sql, work.id, `Bonifico ${FAKE_IBAN}`), /cannot hold this title \(iban\)/);
  const own = await createConversation(db().sql, { mode: 'private' });
  assert.equal((await renameConversation(db().sql, own.id, `Bonifico ${FAKE_IBAN}`)).title, `Bonifico ${FAKE_IBAN}`);
});

test('an archived conversation leaves the list, keeps its messages and takes no new one until restored', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Messaggio finto da archiviare');
  const archived = await archiveConversation(db().sql, conversation.id, true);
  assert.ok(archived.archivedAt instanceof Date);
  assert.ok(!(await listConversations(db().sql)).some((item) => item.id === conversation.id));
  assert.ok((await listConversations(db().sql, 50, { archived: true })).some((item) => item.id === conversation.id));
  assert.equal((await listMessages(db().sql, conversation.id, { limit: 10 })).length, 1);

  await assert.rejects(postUserMessage(db().sql, conversation.id, 'Ancora?'), (error: unknown) => error instanceof ChatError && error.code === 'archived');
  // The database refuses it too; the reply of a task already running is still written.
  await assert.rejects(
    db().sql`INSERT INTO messages (conversation_id, role, label, body) VALUES (${conversation.id}, 'user', 'L2', 'diretto')`,
    /is archived/,
  );
  await db().sql`INSERT INTO messages (conversation_id, role, label, body, task_id) VALUES (${conversation.id}, 'assistant', 'L2', 'risposta', ${task.id})`;

  // Archiving twice records one event; restoring brings it back.
  await archiveConversation(db().sql, conversation.id, true);
  const restored = await archiveConversation(db().sql, conversation.id, false);
  assert.equal(restored.archivedAt, null);
  assert.ok((await listConversations(db().sql)).some((item) => item.id === conversation.id));
  await postUserMessage(db().sql, conversation.id, 'Di nuovo nella lista');
  const events = await db().sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE kind = 'conversation.archived' AND payload ->> 'conversationId' = ${conversation.id} ORDER BY id`;
  assert.deepEqual(events.map((event) => event.payload.archived), [true, false]);
});

test('the conversation of Telegram cannot be archived', async () => {
  const state = await ensureTelegramState(db().sql);
  const conversation = await loadConversation(db().sql, state.conversationId);
  assert.equal(conversation?.telegram, true);
  await assert.rejects(archiveConversation(db().sql, state.conversationId, true), /Telegram cannot be archived/);
  await assert.rejects(db().sql`UPDATE conversations SET archived_at = now() WHERE id = ${state.conversationId}`, /Telegram cannot be archived/);
  assert.equal((await createConversation(db().sql, { mode: 'work' })).telegram, false);
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
