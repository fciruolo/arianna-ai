import assert from 'node:assert/strict';
import { test } from 'node:test';

import { archiveConversation, ChatError, createConversation, listConversations, loadConversation, pinConversation, postUserMessage, purgeConversation } from '../src/conversations.ts';
import { eraseConversation } from '../src/erase.ts';
import { plainChatHistory } from '../src/orchestrator/claude-direct.ts';
import { listSideThreads, openSideThread, SIDE_ANSWER_MARK, SIDE_MARK, sideContext } from '../src/side-threads.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

/** A conversation with a question and its answer, as the step executor leaves it. */
async function answered(mode: 'private' | 'work', agent?: { name: string; modes: ('private' | 'work')[]; project: boolean }): Promise<{ conversationId: string; answerId: string; questionId: string }> {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode, ...(agent === undefined ? {} : { agent }) });
  const { message, task } = await postUserMessage(sql, conversation.id, 'Spiegami la fattura finta FT-2026-001');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  const label = mode === 'private' ? 'L2' : 'L1';
  const [reply] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id, model)
    VALUES (${conversation.id}, 'assistant', ${label}::privacy_label, 'Imponibile 1.000 euro, IVA 220 euro, totale 1.220 euro.', ${task.id},
      ${agent?.name === 'claude' ? 'sonnet' : null}) RETURNING id::text`;
  await owner`UPDATE tasks SET status = 'done', evidence = ${owner.json([{ kind: 'message', ref: reply?.id ?? '' }])} WHERE id = ${task.id}`;
  return { conversationId: conversation.id, answerId: reply?.id ?? '', questionId: message.id };
}

test('a side thread copies who answers and what may be read, and opens the same one again', async () => {
  const { sql, owner } = db();
  const { conversationId, answerId } = await answered('private');
  const first = await openSideThread(sql, conversationId, answerId);
  assert.equal(first.created, true);
  assert.equal(first.conversation.sideOf, conversationId);
  assert.equal(first.conversation.sideMessageId, answerId);
  assert.equal(first.conversation.mode, 'private');
  assert.equal(first.conversation.clearance, 'L2');
  assert.equal(first.conversation.agent, null);
  // Never lower than the answer it reads.
  assert.equal(first.conversation.effectiveLabel, 'L2');
  const again = await openSideThread(sql, conversationId, answerId);
  assert.deepEqual([again.created, again.conversation.id], [false, first.conversation.id]);
  assert.deepEqual(await listSideThreads(sql, conversationId), [{ messageId: answerId, conversationId: first.conversation.id }]);
  // Hidden from the list, also from the archive.
  assert.ok(!(await listConversations(sql)).some((item) => item.id === first.conversation.id));
  // The event carries ids only.
  const [event] = await owner<{ label: string; payload: Record<string, unknown> }[]>`
    SELECT label, payload FROM events WHERE kind = 'conversation.side' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(event, { label: 'L0', payload: { conversationId: first.conversation.id, sideOf: conversationId, messageId: answerId } });
});

test('a side thread only on an answer of an open conversation that allows one', async () => {
  const { sql, owner } = db();
  const { conversationId, answerId, questionId } = await answered('work');
  const invalid = (error: unknown): boolean => error instanceof ChatError && error.code === 'invalid';
  await assert.rejects(openSideThread(sql, conversationId, questionId), invalid);
  await assert.rejects(openSideThread(sql, conversationId, 'x1'), invalid);
  const other = await answered('work');
  await assert.rejects(openSideThread(sql, conversationId, other.answerId), (error: unknown) => error instanceof ChatError && error.code === 'not-found');
  // Never a side thread of a side thread.
  const side = await openSideThread(sql, conversationId, answerId);
  const [inner] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body) VALUES (${side.conversation.id}, 'assistant', 'L1', 'Risposta a lato') RETURNING id::text`;
  await assert.rejects(openSideThread(sql, side.conversation.id, inner?.id ?? ''), invalid);
  // An incognito conversation and an archived one take none.
  const incognito = await createConversation(sql, { mode: 'private', incognito: true });
  const [hidden] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body) VALUES (${incognito.id}, 'assistant', 'L2', 'Segreto') RETURNING id::text`;
  await assert.rejects(openSideThread(sql, incognito.id, hidden?.id ?? ''), (error: unknown) => error instanceof ChatError && error.code === 'incognito');
  await archiveConversation(sql, other.conversationId, true);
  await assert.rejects(openSideThread(sql, other.conversationId, other.answerId), (error: unknown) => error instanceof ChatError && error.code === 'archived');
});

test('the database refuses a side thread that differs from its mother, or that moves', async () => {
  const { sql, owner } = db();
  const { conversationId, answerId } = await answered('private');
  // A work side thread of a private conversation would read L2 with a work clearance.
  await assert.rejects(
    sql`INSERT INTO conversations (mode, clearance, side_of, side_message_id) VALUES ('work', 'L1', ${conversationId}, ${answerId}::bigint)`,
    /those of conversation/,
  );
  await assert.rejects(sql`INSERT INTO conversations (mode, clearance, side_of) VALUES ('private', 'L2', ${conversationId})`, /conversations_side_pair|not an answer/);
  await assert.rejects(
    sql`INSERT INTO conversations (mode, clearance, incognito, side_of, side_message_id) VALUES ('private', 'L2', true, ${conversationId}, ${answerId}::bigint)`,
    /conversations_side_fields|those of conversation/,
  );
  const side = await openSideThread(sql, conversationId, answerId);
  await assert.rejects(owner`UPDATE conversations SET side_message_id = side_message_id + 1 WHERE id = ${side.conversation.id}`, /never changes/);
  await assert.rejects(sql`UPDATE conversations SET pinned_at = now() WHERE id = ${side.conversation.id}`, /conversations_side_fields/);
  // A direct chat with an agent of its own takes none, in the database too.
  const finance = await createConversation(sql, { mode: 'private', agent: { name: 'finanze', modes: ['private'], project: false, finance: true } });
  const [reply] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body) VALUES (${finance.id}, 'assistant', 'L2', 'Risposta') RETURNING id::text`;
  await assert.rejects(openSideThread(sql, finance.id, reply?.id ?? ''), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(
    sql`INSERT INTO conversations (mode, clearance, agent, finance, effective_label, side_of, side_message_id)
      VALUES ('private', 'L2', 'finanze', true, 'L2', ${finance.id}, ${reply?.id ?? ''}::bigint)`,
    /takes no side thread/,
  );
});

test('the side thread reads the answer and what came before it as data, the mother never reads the side thread', async () => {
  const { sql } = db();
  const { conversationId, answerId } = await answered('private');
  const side = await openSideThread(sql, conversationId, answerId);
  const context = await sideContext(sql, side.conversation.id);
  assert.ok(context !== undefined);
  assert.equal(context.label, 'L2');
  assert.equal(context.value.role, 'user');
  const lines = context.value.content.split('\n');
  assert.equal(lines[0], SIDE_MARK);
  assert.deepEqual(JSON.parse(lines[1] ?? ''), { da: 'Utente', testo: 'Spiegami la fattura finta FT-2026-001' });
  assert.equal(lines[2], SIDE_ANSWER_MARK);
  assert.deepEqual(JSON.parse(lines[3] ?? ''), { da: 'Arianna', testo: 'Imponibile 1.000 euro, IVA 220 euro, totale 1.220 euro.' });
  // Not a side thread: no context.
  assert.equal(await sideContext(sql, conversationId), undefined);

  // A question aside is a message of the side thread only.
  const asked = await postUserMessage(sql, side.conversation.id, 'Cosa vuol dire imponibile?');
  assert.equal(asked.message.conversationId, side.conversation.id);
  assert.equal(asked.task.clearance, 'L2');
  const mother = await sql<{ body: string }[]>`SELECT body FROM messages WHERE conversation_id = ${conversationId} ORDER BY id`;
  assert.ok(!mother.some((row) => row.body.includes('imponibile?')));
});

test('the side thread finds its answer when the ids of the messages gain a digit (D-241)', async () => {
  const { sql, owner } = db();
  // The question takes 9999 and the answer 10000: in the order of their text, «10000» came first.
  const [{ max } = { max: null }] = await owner<{ max: string | null }[]>`SELECT max(id)::text AS max FROM messages`;
  assert.ok(Number(max ?? 0) < 9998, 'the test database is still small');
  await owner`SELECT setval(pg_get_serial_sequence('messages', 'id'), 9998)`;
  const { conversationId, answerId, questionId } = await answered('private');
  assert.deepEqual([questionId, answerId], ['9999', '10000']);
  const side = await openSideThread(sql, conversationId, answerId);
  const lines = (await sideContext(sql, side.conversation.id))?.value.content.split('\n') ?? [];
  assert.equal(lines[2], SIDE_ANSWER_MARK);
  assert.deepEqual(JSON.parse(lines[1] ?? '{}'), { da: 'Utente', testo: 'Spiegami la fattura finta FT-2026-001' });
});

test('a plain chat with Claude starts its side thread with the answer, within its clearance', async () => {
  const { sql } = db();
  const { conversationId, answerId } = await answered('work', { name: 'claude', modes: ['work'], project: false });
  const side = await openSideThread(sql, conversationId, answerId);
  assert.equal(side.conversation.agent, 'claude');
  const { task } = await postUserMessage(sql, side.conversation.id, 'Cosa vuol dire imponibile?');
  const history = await plainChatHistory(sql, side.conversation.id, task.id);
  assert.equal(history.length, 2);
  assert.ok(history[0]?.value.content.startsWith(SIDE_MARK));
  assert.ok(history[0]?.value.content.includes('"da":"Claude"'));
  assert.equal(history[0]?.label, 'L1');
  assert.equal(history[1]?.value.content, 'Cosa vuol dire imponibile?');
});

test('in a plain chat the side thread leaves out a message the gateway blocked, as a new start of the session does', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'work', agent: { name: 'claude', modes: ['work'], project: false } });
  // A message without an answer (the gateway blocked it): it never enters.
  const blocked = await postUserMessage(sql, conversation.id, 'Messaggio fermato');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${blocked.task.id}`}`;
  await owner`UPDATE tasks SET status = 'failed' WHERE id = ${blocked.task.id}`;
  const { task } = await postUserMessage(sql, conversation.id, 'Spiegami la fattura finta');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  const [reply] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id, model)
    VALUES (${conversation.id}, 'assistant', 'L1', 'Imponibile e IVA.', ${task.id}, 'sonnet') RETURNING id::text`;
  const side = await openSideThread(sql, conversation.id, reply?.id ?? '');
  const context = await sideContext(sql, side.conversation.id);
  assert.ok(context !== undefined);
  assert.doesNotMatch(context.value.content, /Messaggio fermato/);
  assert.match(context.value.content, /Spiegami la fattura finta/);
});

test('the context keeps out the lines for the user only, and stays within its limits', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  for (let index = 0; index < 12; index += 1) {
    await owner`INSERT INTO messages (conversation_id, role, label, body) VALUES (${conversation.id}, 'user', 'L2', ${`domanda ${String(index)} ${'x'.repeat(index === 11 ? 5_000 : 10)}`})`;
  }
  const { task } = await postUserMessage(sql, conversation.id, 'Ultima domanda');
  await owner`INSERT INTO messages (conversation_id, role, label, body, task_id) VALUES (${conversation.id}, 'system', 'L2', 'Riga solo per te', ${task.id})`;
  const [reply] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id) VALUES (${conversation.id}, 'assistant', 'L2', ${'r'.repeat(9_000)}, ${task.id}) RETURNING id::text`;
  const side = await openSideThread(sql, conversation.id, reply?.id ?? '');
  const lines = (await sideContext(sql, side.conversation.id))?.value.content.split('\n') ?? [];
  const data = lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as { da: string; testo: string });
  assert.ok(!data.some((row) => row.testo.includes('Riga solo per te')));
  // At most 10 messages before the answer, the newest; each cut at 4,000 characters, the answer at 8,000.
  assert.ok(data.length - 1 <= 10);
  assert.equal(data.at(-2)?.testo, 'Ultima domanda');
  assert.ok(!data.some((row) => row.testo.startsWith('domanda 0 ')));
  assert.ok(data.every((row) => row.testo.length <= 8_000 + 40));
  assert.ok(data.slice(0, -1).every((row) => row.testo.length <= 4_000 + 40));
  assert.match(data.at(-1)?.testo ?? '', /tagliato a 8000 caratteri/);
});

test('the database raises the label of a side thread to its mother, and refuses to pin or archive it alone', async () => {
  const { sql } = db();
  const { conversationId, answerId } = await answered('private');
  const [row] = await sql<{ label: string }[]>`
    INSERT INTO conversations (mode, clearance, effective_label, side_of, side_message_id)
    VALUES ('private', 'L2', 'L0', ${conversationId}, ${answerId}::bigint) RETURNING effective_label AS label`;
  assert.equal(row?.label, 'L2');
  const side = (await listSideThreads(sql, conversationId))[0]?.conversationId ?? '';
  await assert.rejects(pinConversation(sql, side, true), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(archiveConversation(sql, side, true), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
});

test('a side thread takes no message while its mother is archived', async () => {
  const { sql } = db();
  const { conversationId, answerId } = await answered('private');
  const side = await openSideThread(sql, conversationId, answerId);
  await archiveConversation(sql, conversationId, true);
  await assert.rejects(postUserMessage(sql, side.conversation.id, 'Ancora?'), (error: unknown) => error instanceof ChatError && error.code === 'archived');
});

test('deleting the mother deletes its side threads: purge and erase', async () => {
  const { sql, owner } = db();
  const purged = await answered('private');
  const side = await openSideThread(sql, purged.conversationId, purged.answerId);
  const { task } = await postUserMessage(sql, side.conversation.id, 'Domanda a lato segretofinto');
  // A side thread at work holds the purge back.
  await archiveConversation(sql, purged.conversationId, true);
  await assert.rejects(purgeConversation(sql, purged.conversationId), (error: unknown) => error instanceof ChatError && error.code === 'busy');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  await owner`UPDATE tasks SET status = 'failed' WHERE id = ${task.id}`;
  await purgeConversation(sql, purged.conversationId);
  assert.equal(await loadConversation(sql, side.conversation.id), undefined);
  assert.equal((await owner`SELECT 1 FROM messages WHERE conversation_id = ${side.conversation.id}`).length, 0);
  const [event] = await owner<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM events WHERE kind = 'conversation.purged' AND payload ->> 'conversationId' = ${side.conversation.id}`;
  assert.equal(event?.payload.cause, 'source');

  const erased = await answered('work');
  const other = await openSideThread(sql, erased.conversationId, erased.answerId);
  await postUserMessage(sql, other.conversation.id, 'Domanda a lato');
  await owner`UPDATE jobs SET status = 'done'`;
  const result = await eraseConversation(sql, erased.conversationId);
  assert.equal(result.conversations, 2);
  assert.equal((await owner`SELECT 1 FROM conversations WHERE id IN (${erased.conversationId}, ${other.conversation.id})`).length, 0);
});
