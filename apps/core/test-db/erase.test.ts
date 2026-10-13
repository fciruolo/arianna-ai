import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { ChatError, createConversation, postUserMessage } from '../src/conversations.ts';
import { eraseConversation } from '../src/erase.ts';
import { appendEvent, verifyEventChain } from '../src/events.ts';
import { createTask } from '../src/tasks.ts';
import { useTestDatabase, type TestDatabase } from './support/database.ts';

// Migration 0043 (D-157): a conversation erased for good, with its audit, and the chain sewn again.
const db = useTestDatabase();

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Every `table.column` of the test schema whose text holds one of `needles`: any column type, cast to text. */
async function places(database: TestDatabase, needles: readonly string[]): Promise<string[]> {
  const { owner, schema } = database;
  const columns = await owner<{ table: string; column: string }[]>`
    SELECT c.table_name AS table, c.column_name AS column
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = ${schema} AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.column_name`;
  const found: string[] = [];
  for (const { table, column } of columns) {
    const [row] = await owner.unsafe<{ found: boolean }[]>(
      `SELECT EXISTS (SELECT FROM "${table}" WHERE EXISTS (SELECT FROM unnest($1::text[]) n WHERE strpos("${column}"::text, n) > 0)) AS found`,
      [needles],
    );
    if (row?.found === true) found.push(`${table}.${column}`);
  }
  return found;
}

interface Busy {
  conversationId: string;
  taskIds: string[];
  systemChatId: string;
  cardId: string;
  commitmentId: string;
  /** Every id the erase must leave nowhere. */
  needles: string[];
}

/** A conversation as the core leaves it after some work, with a system chat about its task, a card and a commitment made from it. */
async function busyConversation(): Promise<Busy> {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Domanda finta sul contratto finto');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  const [run] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality) VALUES (${task.id}, 1, 'arianna', 'local', 'local') RETURNING id::text`;
  const runId = run?.id ?? '';
  const [reply] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id)
    VALUES (${conversation.id}, 'assistant', 'L2', 'Risposta finta', ${task.id}) RETURNING id::text`;
  await owner`
    INSERT INTO task_turns (task_id, step, run_id, label, answer, thought, result, message_id)
    VALUES (${task.id}, 1, ${runId}, 'L2', ${owner.json({ action: 'reply' })}, 'pensiero', 'risultato', ${reply?.id ?? ''})`;
  await owner`UPDATE runs SET status = 'ok', ended_at = now() WHERE id = ${runId}`;
  await owner`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${task.id}, 1, 'search', 'cerca', 'L2')`;
  const [delegation] = await owner<{ id: string }[]>`
    INSERT INTO task_delegations (task_id, step, agent, brief, label, status, result, result_label, ended_at)
    VALUES (${task.id}, 2, 'coder', 'brief', 'L1', 'ok', 'rapporto', 'L1', now())
    RETURNING id::text`;
  await owner`
    INSERT INTO conversation_participants (conversation_id, agent, added_by, task_id, delegation_id)
    VALUES (${conversation.id}, 'coder', 'arianna', ${task.id}, ${delegation?.id ?? ''})`;
  const text = 'testo da declassare';
  const [declassify] = await owner<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label, state, decided_at, decided_via)
    VALUES (${task.id}, 'declassify', 'declassify', ${owner.json({ text, sha256: sha256(text), from: 'L2', to: 'L1' })}, 'L2', 'approved', now(), 'web')
    RETURNING id::text`;
  await owner`INSERT INTO label_changes (subject, from_label, to_label, approval_id) VALUES (${`content:${sha256(text)}`}, 'L2', 'L1', ${declassify?.id ?? ''})`;
  await owner`INSERT INTO label_changes (subject, from_label, to_label) VALUES (${`task:${task.id}`}, 'L1', 'L2')`;
  await owner`
    INSERT INTO gateway_log (task_id, run_id, target_kind, target, locality, label, decision, rule, reason, bytes_out, payload_sha256, summary)
    VALUES (${task.id}, ${runId}, 'executor', 'claude', 'cloud', 'L1', 'allow', 'cloud-up-to-l1', 'L1 to cloud', 42, ${sha256(text)}, 'brief L1')`;
  await owner`
    INSERT INTO router_decisions (task_id, run_id, step, label, difficulty, decision, executor, model, locality, candidates, reason)
    VALUES (${task.id}, ${runId}, 1, 'L2', 'normal', 'route', 'local', 'local-large', 'local', '[]', 'L2 stays local')`;
  const [error] = await owner<{ id: string }[]>`
    INSERT INTO task_errors (task_id, origin, code, details, label) VALUES (${task.id}, 'engine', 'engine.timeout', '{}', 'L0') RETURNING id::text`;
  await appendEvent(sql, { kind: 'run.started', taskId: task.id, runId, label: 'L0', payload: {} });
  await appendEvent(sql, { kind: 'delegation.started', label: 'L0', payload: { delegationId: delegation?.id ?? '', conversationId: conversation.id } });

  // A system chat about the task (D-064), with its own task and message.
  const [system] = await owner<{ id: string }[]>`
    INSERT INTO conversations (mode, origin, system_reason, source_task_id, source_error_id)
    VALUES ('private', 'system', 'failure', ${task.id}, ${error?.id ?? ''}) RETURNING id::text`;
  const systemChatId = system?.id ?? '';
  const systemTask = await postUserMessage(sql, systemChatId, 'Perché è fallito?');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${systemTask.task.id}`}`;

  // A card made by the conversation (D-152): it stays, without its parent.
  const card = await createTask(sql, { title: 'Card finta', parentId: task.id, assignee: 'user', label: 'L2', clearance: 'L2' });
  // A call scheduled on the conversation.
  const [call] = await owner<{ id: string }[]>`
    INSERT INTO calls (conversation_id, direction, reason, task_id, status, scheduled_at)
    VALUES (${conversation.id}, 'out', 'scheduled', ${task.id}, 'scheduled', now() + interval '1 day') RETURNING id::text`;
  // A commitment told in it: it stays, without its origin.
  const [commitment] = await owner<{ id: string }[]>`
    INSERT INTO commitments (body, day, conversation_id, task_id) VALUES ('Impegno finto', current_date, ${conversation.id}, ${task.id}) RETURNING id::text`;

  const taskIds = [task.id, systemTask.task.id];
  return {
    conversationId: conversation.id,
    taskIds,
    systemChatId,
    cardId: card.id,
    commitmentId: commitment?.id ?? '',
    needles: [conversation.id, systemChatId, ...taskIds, runId, declassify?.id ?? '', call?.id ?? '', 'Domanda finta', 'Risposta finta'],
  };
}

test('an erased conversation leaves no row anywhere; cards and commitments stay unlinked; the chain is sewn with one line', async () => {
  const database = db();
  const { sql, owner } = database;
  const busy = await busyConversation();
  // Another conversation written after it: its events come after the gap, so their hashes are written again.
  const other = await createConversation(sql, { mode: 'private' });
  const otherPost = await postUserMessage(sql, other.id, 'Altra conversazione finta');
  const before = await owner<{ messages: number; events: number }[]>`
    SELECT (SELECT count(*)::int FROM messages WHERE conversation_id = ${other.id}) AS messages,
           (SELECT count(*)::int FROM events WHERE task_id = ${otherPost.task.id} OR payload ->> 'conversationId' = ${other.id}) AS events`;
  assert.ok((await places(database, busy.needles)).length > 0);
  const rewovenBefore = (await owner`SELECT 1 FROM events WHERE kind = 'events.rewoven'`).length;

  const result = await eraseConversation(sql, busy.conversationId);
  assert.deepEqual({ conversations: result.conversations, tasks: result.tasks, cards: result.cards }, { conversations: 2, tasks: 2, cards: 1 });
  assert.ok(result.events > 0);

  assert.deepEqual(await places(database, busy.needles), []);
  const [card] = await owner<{ parent: string | null; title: string }[]>`SELECT parent_id::text AS parent, title FROM tasks WHERE id = ${busy.cardId}`;
  assert.deepEqual(card, { parent: null, title: 'Card finta' });
  const [commitment] = await owner<{ body: string; conversation: string | null; task: string | null }[]>`
    SELECT body, conversation_id::text AS conversation, task_id::text AS task FROM commitments WHERE id = ${busy.commitmentId}`;
  assert.deepEqual(commitment, { body: 'Impegno finto', conversation: null, task: null });

  // The doctor's check: the chain is intact, with one line that says it was sewn and says nothing else.
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
  const rewoven = await owner<{ label: string; payload: unknown; task: string | null; run: string | null; agent: string | null }[]>`
    SELECT label, payload, task_id::text AS task, run_id::text AS run, agent FROM events WHERE kind = 'events.rewoven'`;
  assert.equal(rewoven.length, rewovenBefore + 1);
  assert.deepEqual(rewoven.at(-1), { label: 'L0', payload: {}, task: null, run: null, agent: null });

  // The other conversation is untouched.
  const after = await owner<{ messages: number; events: number }[]>`
    SELECT (SELECT count(*)::int FROM messages WHERE conversation_id = ${other.id}) AS messages,
           (SELECT count(*)::int FROM events WHERE task_id = ${otherPost.task.id} OR payload ->> 'conversationId' = ${other.id}) AS events`;
  assert.deepEqual(after, before);

  // New events chain on as before.
  await appendEvent(sql, { kind: 'test.after', label: 'L0' });
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
});

test('the conversation of the secretary, of Telegram and an incognito one are never erased', async () => {
  const { sql, owner } = db();
  const [secretary] = await sql<{ id: string }[]>`INSERT INTO conversations (mode, secretary) VALUES ('private', true) RETURNING id::text`;
  await assert.rejects(eraseConversation(sql, secretary?.id ?? ''), (error) => error instanceof ChatError && error.code === 'invalid');
  await assert.rejects(sql`SELECT erase_conversation(${secretary?.id ?? ''}::uuid)`, /is not erased/);

  const telegram = await createConversation(sql, { mode: 'work' });
  await owner`INSERT INTO telegram_state (conversation_id) VALUES (${telegram.id})`;
  try {
    await assert.rejects(eraseConversation(sql, telegram.id), (error) => error instanceof ChatError && error.code === 'invalid');
    await assert.rejects(sql`SELECT erase_conversation(${telegram.id}::uuid)`, /is not erased/);
  } finally {
    await owner`DELETE FROM telegram_state`;
  }

  const [incognito] = await sql<{ id: string }[]>`INSERT INTO conversations (mode, incognito) VALUES ('private', true) RETURNING id::text`;
  await assert.rejects(eraseConversation(sql, incognito?.id ?? ''), (error) => error instanceof ChatError && error.code === 'incognito');
  await assert.rejects(sql`SELECT erase_conversation(${incognito?.id ?? ''}::uuid)`, /is not erased/);
  // All three are still there.
  const ids = [secretary?.id ?? '', telegram.id, incognito?.id ?? ''];
  assert.equal((await owner`SELECT 1 FROM conversations WHERE id = ANY (${ids}::uuid[])`).length, 3);
});

test('a missing or already deleted conversation is not found', async () => {
  const { sql } = db();
  const notFound = (error: unknown): boolean => error instanceof ChatError && error.code === 'not-found';
  await assert.rejects(eraseConversation(sql, '00000000-0000-4000-8000-000000000000'), notFound);
  await assert.rejects(eraseConversation(sql, 'not-a-uuid'), notFound);
  const conversation = await createConversation(sql, { mode: 'private' });
  await eraseConversation(sql, conversation.id);
  await assert.rejects(eraseConversation(sql, conversation.id), notFound);
});

test('a step claimed by a worker is stopped first; without a stop the erase answers busy and keeps everything', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Lavoro in corso finto');
  await owner`UPDATE jobs SET status = 'running', locked_at = now(), locked_by = 'worker-test' WHERE key = ${`task:${task.id}`}`;
  await owner`UPDATE tasks SET status = 'running' WHERE id = ${task.id}`;

  await assert.rejects(eraseConversation(sql, conversation.id), (error) => error instanceof ChatError && error.code === 'busy');
  assert.equal((await owner`SELECT 1 FROM messages WHERE conversation_id = ${conversation.id}`).length, 1);

  // The worker stops the step for good, as the engine does with the cause `erase`.
  const stopped: string[] = [];
  const stopTask = (taskId: string): boolean => {
    stopped.push(taskId);
    owner`UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = 'erase' WHERE key = ${`task:${taskId}`}`.then(
      () => undefined,
      () => undefined,
    );
    return true;
  };
  await eraseConversation(sql, conversation.id, { stopTask, pollMs: 10, waitMs: 5_000 });
  assert.deepEqual(stopped, [task.id]);
  assert.equal((await owner`SELECT 1 FROM conversations WHERE id = ${conversation.id}`).length, 0);
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
});

test('refused after a stop (a call started meanwhile): the stopped step goes back to the queue and nothing changes', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Lavoro in corso finto');
  const key = `task:${task.id}`;
  await owner`UPDATE jobs SET status = 'running', locked_at = now(), locked_by = 'worker-test', attempts = 1 WHERE key = ${key}`;
  await owner`UPDATE tasks SET status = 'running' WHERE id = ${task.id}`;
  // A call rings on the conversation while the worker gives the job back failed with `erase`.
  const stopTask = (taskId: string): boolean => {
    // The call first: the erase goes on once the job is no longer running.
    owner`INSERT INTO calls (conversation_id, direction, reason, status) VALUES (${conversation.id}, 'in', NULL, 'ringing')`
      .then(() => owner`UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = 'erase' WHERE key = ${`task:${taskId}`}`)
      .then(
        () => undefined,
        () => undefined,
      );
    return true;
  };
  await assert.rejects(
    eraseConversation(sql, conversation.id, { stopTask, pollMs: 10, waitMs: 5_000 }),
    (error) => error instanceof ChatError && error.code === 'busy',
  );
  const [job] = await owner<{ status: string; last_error: string | null; attempts: number }[]>`SELECT status, last_error, attempts FROM jobs WHERE key = ${key}`;
  assert.deepEqual(job, { status: 'queued', last_error: null, attempts: 0 });
  assert.equal((await owner`SELECT 1 FROM messages WHERE conversation_id = ${conversation.id}`).length, 1);
  await owner`UPDATE calls SET status = 'ended', end_reason = 'hangup', ended_at = now() WHERE conversation_id = ${conversation.id}`;
});

test('a live call refuses the erase before any step is stopped', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, conversation.id, 'Messaggio finto');
  await owner`INSERT INTO calls (conversation_id, direction, reason, status) VALUES (${conversation.id}, 'in', NULL, 'active')`;
  const stopped: string[] = [];
  await assert.rejects(
    eraseConversation(sql, conversation.id, { stopTask: (taskId) => stopped.push(taskId) > 0 }),
    (error) => error instanceof ChatError && error.code === 'busy',
  );
  assert.deepEqual(stopped, []);
  await owner`UPDATE calls SET status = 'ended', end_reason = 'hangup', ended_at = now() WHERE conversation_id = ${conversation.id}`;
});

test('an id of its rows equal to the id of another row (forged) refuses the erase: the other row keeps its events', async () => {
  const { sql, owner } = db();
  const other = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, other.id, 'Altra conversazione finta');
  const conversation = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, conversation.id, 'Messaggio finto');
  // A task of this conversation that takes the id of the other one.
  await owner`INSERT INTO tasks (id, conversation_id, title, label, status) VALUES (${other.id}, ${conversation.id}, 'finto', 'L1', 'done')`;
  const before = await owner`SELECT id FROM events WHERE payload::text LIKE ${`%${other.id}%`}`;
  assert.ok(before.length > 0);
  await assert.rejects(eraseConversation(sql, conversation.id), (error) => error instanceof ChatError && error.code === 'invalid');
  assert.equal((await owner`SELECT id FROM events WHERE payload::text LIKE ${`%${other.id}%`}`).length, before.length);
  assert.equal((await owner`SELECT 1 FROM conversations WHERE id = ${conversation.id}`).length, 1);
});

test('a live call on the conversation keeps it until the call ends', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const [call] = await owner<{ id: string }[]>`
    INSERT INTO calls (conversation_id, direction, reason, status) VALUES (${conversation.id}, 'in', NULL, 'active') RETURNING id::text`;
  await assert.rejects(eraseConversation(sql, conversation.id), (error) => error instanceof ChatError && error.code === 'busy');
  await owner`UPDATE calls SET status = 'ended', end_reason = 'hangup', ended_at = now() WHERE id = ${call?.id ?? ''}`;
  await eraseConversation(sql, conversation.id);
  assert.equal((await owner`SELECT 1 FROM calls WHERE id = ${call?.id ?? ''}`).length, 0);
});

test('arianna_app still cannot delete or rewrite anything by itself, even with the setting of the erase', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, conversation.id, 'Messaggio finto');
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('arianna.erase', ${conversation.id}, true)`;
      await tx`DELETE FROM messages WHERE conversation_id = ${conversation.id}`;
    }),
    /permission denied/,
  );
  for (const statement of [
    sql`DELETE FROM messages WHERE conversation_id = ${conversation.id}`,
    sql`DELETE FROM conversations WHERE id = ${conversation.id}`,
    sql`DELETE FROM events`,
    sql`UPDATE events SET hash = hash`,
    sql`DELETE FROM gateway_log`,
    sql`DELETE FROM tasks`,
  ]) {
    await assert.rejects(statement, /permission denied/);
  }
  assert.equal((await sql`SELECT 1 FROM messages WHERE conversation_id = ${conversation.id}`).length, 1);
  // Only the function, with no other right: no one else may run it.
  const [grant] = await sql<{ app: boolean; public: boolean }[]>`
    SELECT has_function_privilege('arianna_app', 'erase_conversation(uuid)', 'EXECUTE') AS app,
           has_function_privilege('public', 'erase_conversation(uuid)', 'EXECUTE') AS public`;
  assert.deepEqual(grant, { app: true, public: false });
});
