import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createConversation, listMessages, postUserMessage } from '../src/conversations.ts';
import { startLiveFeed, type LiveMessage } from '../src/live.ts';
import { openReply } from '../src/reply.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('the thinking streams live apart from the answer, then is stored with it and its label (D-249)', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work' });
  const { task } = await postUserMessage(sql, conversation.id, 'Pensa e rispondi');
  const live = await startLiveFeed(sql);
  const received: LiveMessage[] = [];
  const stop = await live.subscribe({ send: (message) => received.push(message) });
  try {
    const reply = await openReply(sql, task.id);
    await reply.thought('');
    await reply.thought('Cerco la nota finta.');
    await reply.thought('');
    await reply.thought('Poi rispondo.');
    await reply.delta('Ecco.');
    const result = await reply.finish('Ecco.', 'L0');
    assert.ok(result.stored);
    assert.equal(result.message.label, 'L1');
    assert.equal(result.message.thought, 'Cerco la nota finta.\n\nPoi rispondo.');
    assert.ok(typeof result.message.thoughtMs === 'number' && result.message.thoughtMs >= 0);
    await waitFor(() => received.filter((message) => message.type === 'delta').length >= 4);
    const deltas = received.flatMap((message) => (message.type === 'delta' ? [[message.part ?? 'text', message.text]] : []));
    assert.deepEqual(deltas, [
      ['thought', ''],
      ['thought', 'Cerco la nota finta.'],
      ['thought', '\n\nPoi rispondo.'],
      ['text', 'Ecco.'],
    ]);
    // Read back with the history, for the chat's «Ha ragionato per».
    const [stored] = (await listMessages(sql, conversation.id, { limit: 10 })).filter((message) => message.role === 'assistant');
    assert.equal(stored?.thought, 'Cerco la nota finta.\n\nPoi rispondo.');
  } finally {
    stop();
    await live.close();
  }
});

test('an answer without thinking keeps none; a model that hid it keeps the time alone; the caller may give its own (D-249)', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Rispondi');
  const plain = await (await openReply(sql, task.id)).finish('Senza pensiero', 'L2');
  assert.ok(plain.stored);
  assert.deepEqual([plain.message.thought, plain.message.thoughtMs], [null, null]);
  const hidden = await openReply(sql, task.id);
  await hidden.thought('');
  const kept = await hidden.finish('Pensato in silenzio', 'L2');
  assert.ok(kept.stored);
  assert.equal(kept.message.thought, '');
  assert.equal(typeof kept.message.thoughtMs, 'number');
  const given = await (await openReply(sql, task.id)).finish('Dal JSON', 'L2', { thought: '  dal campo thought  ', thoughtMs: 1234 });
  assert.ok(given.stored);
  assert.deepEqual([given.message.thought, given.message.thoughtMs], ['dal campo thought', 1234]);
});

test('an incognito never stores the thinking, whatever the core sends (D-249, D-136)', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private', incognito: true });
  const { task } = await postUserMessage(sql, conversation.id, 'Pensa in incognito');
  const reply = await openReply(sql, task.id);
  await reply.thought('Pensiero da non tenere');
  const result = await reply.finish('Risposta', 'L2');
  assert.ok(result.stored);
  assert.deepEqual([result.message.thought, result.message.thoughtMs], [null, null]);
  // The database drops it too, written by hand.
  await sql`INSERT INTO messages (conversation_id, role, label, body, task_id, thought, thought_ms)
    VALUES (${conversation.id}, 'assistant', 'L2', 'a mano', ${task.id}, 'pensiero a mano', 10)`;
  const rows = await sql<{ thought: string | null }[]>`SELECT thought FROM messages WHERE conversation_id = ${conversation.id} AND body = 'a mano'`;
  assert.deepEqual(rows.map((row) => row.thought), [null]);
});

test('the database keeps the thinking on answers only, within its length, with its time (D-249)', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Vincoli');
  const insert = (role: string, thought: string | null, ms: number | null) =>
    sql`INSERT INTO messages (conversation_id, role, label, body, task_id, thought, thought_ms) VALUES (${conversation.id}, ${role}, 'L2', 'x', ${task.id}, ${thought}, ${ms})`;
  await insert('assistant', 'ok', 5);
  await assert.rejects(insert('user', 'no', 5), /messages_thought_answer/);
  await assert.rejects(insert('assistant', 'x'.repeat(32_001), 5), /messages_thought_length/);
  await assert.rejects(insert('assistant', 'senza tempo', null), /messages_thought_ms/);
  await assert.rejects(insert('assistant', null, 5), /messages_thought_ms/);
  await assert.rejects(insert('assistant', 'negativo', -1), /messages_thought_ms/);
});

test('the thinking passes the gateway with the answer, logged as one exit to the chat (D-249)', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Gateway');
  const exits = async () =>
    sql<{ bytes_out: number | null }[]>`SELECT bytes_out FROM gateway_log WHERE task_id = ${task.id} AND target = 'web' ORDER BY id`;
  const thought = await (await openReply(sql, task.id)).finish('Risposta', 'L2', { thought: 'Ho pensato così' });
  assert.ok(thought.stored);
  assert.equal(thought.message.thought, 'Ho pensato così');
  assert.deepEqual(await exits(), [{ bytes_out: Buffer.byteLength('Risposta') + Buffer.byteLength('Ho pensato così') }]);
  // Negative: without thinking, only the answer is offered.
  const plain = await (await openReply(sql, task.id)).finish('Sola', 'L2');
  assert.ok(plain.stored);
  assert.deepEqual((await exits()).slice(1), [{ bytes_out: Buffer.byteLength('Sola') }]);
});
