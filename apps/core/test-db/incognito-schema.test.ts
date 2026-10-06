import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyEventChain } from '../src/events.ts';
import { canaryPlaces, newCanary } from './support/canary.ts';
import { useTestDatabase } from './support/database.ts';

// Migration 0031 (D-136, I-4 tappa 1): the incognito mark, its constraints and purge_incognito.
const db = useTestDatabase();

async function incognito(mode: 'private' | 'work' = 'private'): Promise<string> {
  const { sql } = db();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO conversations (mode, clearance, workspace, incognito)
    VALUES (${mode}, ${mode === 'work' ? 'L1' : 'L2'}::privacy_label, ${mode === 'work' ? 'sito-demo' : null}, true)
    RETURNING id::text`;
  return row?.id ?? '';
}

async function task(conversationId: string, title = 'Incognito', clearance = 'L2'): Promise<string> {
  const { sql } = db();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO tasks (title, conversation_id, label, clearance, effective_label, assignee, status)
    VALUES (${title}, ${conversationId}, ${clearance}::privacy_label, ${clearance}::privacy_label, ${clearance}::privacy_label, 'arianna', 'running')
    RETURNING id::text`;
  return row?.id ?? '';
}

test('incognito is chosen at creation and never changes, in both directions', async () => {
  const { sql } = db();
  const id = await incognito();
  await assert.rejects(sql`UPDATE conversations SET incognito = false WHERE id = ${id}`, /never changes/);
  const [normal] = await sql<{ id: string }[]>`INSERT INTO conversations (mode) VALUES ('private') RETURNING id::text`;
  await assert.rejects(sql`UPDATE conversations SET incognito = true WHERE id = ${normal?.id ?? ''}`, /never changes/);
  // Other columns still move as before.
  await sql`UPDATE conversations SET effective_label = 'L1' WHERE id = ${id}`;
});

test('an incognito conversation is never titled, archived nor pinned', async () => {
  const { sql } = db();
  const id = await incognito();
  await assert.rejects(sql`UPDATE conversations SET title = 'Segreto' WHERE id = ${id}`, /conversations_incognito_fields/);
  await assert.rejects(sql`UPDATE conversations SET archived_at = now() WHERE id = ${id}`, /conversations_incognito_fields/);
  await assert.rejects(sql`UPDATE conversations SET pinned_at = now() WHERE id = ${id}`, /conversations_incognito_fields/);
  await assert.rejects(sql`INSERT INTO conversations (mode, incognito, title) VALUES ('private', true, 'Titolo')`, /conversations_incognito_fields/);
  // A normal conversation still takes all three.
  const [normal] = await sql<{ id: string }[]>`INSERT INTO conversations (mode) VALUES ('private') RETURNING id::text`;
  await sql`UPDATE conversations SET title = 'Titolo', pinned_at = now() WHERE id = ${normal?.id ?? ''}`;
  await sql`UPDATE conversations SET archived_at = now() WHERE id = ${normal?.id ?? ''}`;
});

test('incognito is refused for a direct chat, for a system chat and for a system chat about an incognito task', async () => {
  const { sql } = db();
  await assert.rejects(
    sql`INSERT INTO conversations (mode, clearance, workspace, agent, incognito) VALUES ('work', 'L1', 'sito-demo', 'coder', true)`,
    /conversations_incognito_fields/,
  );
  const id = await incognito();
  const taskId = await task(id);
  await assert.rejects(
    sql`INSERT INTO conversations (mode, origin, system_reason, source_task_id, incognito) VALUES ('private', 'system', 'failure', ${taskId}, true)`,
    /conversations_incognito_fields|incognito/,
  );
  await assert.rejects(
    sql`INSERT INTO conversations (mode, origin, system_reason, source_task_id) VALUES ('private', 'system', 'failure', ${taskId})`,
    /belongs to an incognito conversation/,
  );
  // A system chat about a task of a normal conversation still opens.
  const [normal] = await sql<{ id: string }[]>`INSERT INTO conversations (mode) VALUES ('private') RETURNING id::text`;
  const normalTask = await task(normal?.id ?? '', 'Domanda');
  await sql`INSERT INTO conversations (mode, origin, system_reason, source_task_id) VALUES ('private', 'system', 'failure', ${normalTask})`;
});

test('the bot of Telegram is never bound to an incognito conversation', async () => {
  const { owner } = db();
  const id = await incognito('work');
  await assert.rejects(owner`INSERT INTO telegram_state (conversation_id) VALUES (${id})`, /never bound to an incognito/);
  const [work] = await owner<{ id: string }[]>`INSERT INTO conversations (mode, clearance) VALUES ('work', 'L1') RETURNING id::text`;
  await owner`INSERT INTO telegram_state (conversation_id) VALUES (${work?.id ?? ''})`;
  await owner`DELETE FROM telegram_state`;
});

test('the tasks of an incognito conversation are titled Incognito from birth', async () => {
  const { sql } = db();
  const id = await incognito();
  await assert.rejects(task(id, 'Inizio del messaggio segreto'), /titled Incognito/);
  const taskId = await task(id);
  await assert.rejects(sql`UPDATE tasks SET title = 'Altro' WHERE id = ${taskId}`, /titled Incognito/);
  // Elsewhere the title is free.
  const [normal] = await sql<{ id: string }[]>`INSERT INTO conversations (mode) VALUES ('private') RETURNING id::text`;
  const normalTask = await task(normal?.id ?? '', 'Inizio del messaggio');
  await sql`UPDATE tasks SET title = 'Altro' WHERE id = ${normalTask}`;
});

test('purge_incognito refuses a normal conversation and an incognito still at work', async () => {
  const { sql, owner } = db();
  const [normal] = await sql<{ id: string }[]>`INSERT INTO conversations (mode) VALUES ('private') RETURNING id::text`;
  await assert.rejects(sql`SELECT purge_incognito(${normal?.id ?? ''}::uuid)`, /only an incognito/);
  const id = await incognito();
  const taskId = await task(id);
  await assert.rejects(sql`SELECT purge_incognito(${id}::uuid)`, /still at work/);
  await owner`UPDATE tasks SET status = 'waiting_user', waiting_reason = 'attesa' WHERE id = ${taskId}`;
  const [run] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality) VALUES (${taskId}, 1, 'arianna', 'local', 'local') RETURNING id::text`;
  await assert.rejects(sql`SELECT purge_incognito(${id}::uuid)`, /still at work/);
  await owner`UPDATE runs SET status = 'interrupted', ended_at = now() WHERE id = ${run?.id ?? ''}`;
  await sql`SELECT purge_incognito(${id}::uuid)`;
  await assert.rejects(sql`SELECT purge_incognito(${id}::uuid)`, /does not exist/);
  // purge_conversation still wants an archived conversation, and never takes an incognito one.
  const other = await incognito();
  await assert.rejects(sql`SELECT purge_conversation(${other}::uuid)`, /only an archived/);
});

test('canary: after purge_incognito no text or jsonb column of the schema holds what the incognito wrote', async () => {
  const { sql, owner, schema } = db();
  const canary = newCanary();
  const id = await incognito('work');
  const taskId = await task(id, 'Incognito', 'L1');
  await owner`UPDATE tasks SET goal = ${`obiettivo ${canary}`} WHERE id = ${taskId}`;
  const [run] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality, session_ref, workspace)
    VALUES (${taskId}, 1, 'arianna', 'local', 'local', ${`sessione-${canary}`}, ${`data/worktrees/${canary}`}) RETURNING id::text`;
  const runId = run?.id ?? '';
  const [question] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id)
    VALUES (${id}, 'user', 'L1', ${`Domanda ${canary}`}, ${taskId}) RETURNING id::text`;
  const [reply] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id)
    VALUES (${id}, 'assistant', 'L1', ${`Risposta ${canary}`}, ${taskId}) RETURNING id::text`;
  await owner`
    INSERT INTO task_turns (task_id, step, run_id, label, answer, thought, result, message_id)
    VALUES (${taskId}, 1, ${runId}, 'L1', ${owner.json({ action: 'reply', text: canary })}, ${`pensiero ${canary}`}, ${`risultato ${canary}`}, ${reply?.id ?? ''})`;
  await owner`
    INSERT INTO conversation_summaries (conversation_id, first_message_id, last_message_id, label, body, model, task_id, run_id)
    VALUES (${id}, ${question?.id ?? ''}::bigint, ${reply?.id ?? ''}::bigint, 'L1', ${`riassunto ${canary}`}, 'local-large', ${taskId}, ${runId})`;
  await owner`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${taskId}, 1, 'search', ${`cerca ${canary}`}, 'L1')`;
  const [delegation] = await owner<{ id: string }[]>`
    INSERT INTO task_delegations (task_id, step, agent, brief, label, status, result, result_label, ended_at)
    VALUES (${taskId}, 2, 'coder', ${`brief ${canary}`}, 'L1', 'ok', ${`rapporto ${canary}`}, 'L1', now())
    RETURNING id::text`;
  await owner`
    INSERT INTO conversation_participants (conversation_id, agent, added_by, task_id, delegation_id)
    VALUES (${id}, 'coder', 'arianna', ${taskId}, ${delegation?.id ?? ''})`;
  await owner`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${taskId}, 'budget', 'budget', ${owner.json({ why: canary })}, 'L1')`;
  await owner`UPDATE runs SET status = 'interrupted', ended_at = now() WHERE id = ${runId}`;
  await owner`UPDATE tasks SET status = 'failed' WHERE id = ${taskId}`;
  assert.ok((await canaryPlaces(owner, schema, canary)).length >= 8);

  const [row] = await sql<{ purged: Record<string, unknown> }[]>`SELECT purge_incognito(${id}::uuid) AS purged`;
  assert.deepEqual(
    { tasks: row?.purged.tasks, messages: row?.purged.messages, summaries: row?.purged.summaries },
    { tasks: 1, messages: 2, summaries: 1 },
  );
  assert.deepEqual(await canaryPlaces(owner, schema, canary), []);

  // The skeleton stays: the conversation purged and never archived, the task titled Incognito, the run without session or folder.
  const [conversation] = await owner<{ purged: boolean; archived: boolean; incognito: boolean; title: string | null }[]>`
    SELECT purged_at IS NOT NULL AS purged, archived_at IS NOT NULL AS archived, incognito, title FROM conversations WHERE id = ${id}`;
  assert.deepEqual(conversation, { purged: true, archived: false, incognito: true, title: null });
  const [skeleton] = await owner<{ title: string; session: string | null; workspace: string | null }[]>`
    SELECT t.title, r.session_ref AS session, r.workspace FROM tasks t JOIN runs r ON r.task_id = t.id WHERE t.id = ${taskId}`;
  assert.deepEqual(skeleton, { title: 'Incognito', session: null, workspace: null });
  assert.equal((await verifyEventChain(owner)).ok, true);
  // A purged incognito never changes again, and its guards are on.
  await assert.rejects(sql`UPDATE conversations SET effective_label = 'L1' WHERE id = ${id}`, /never changes/);
  await assert.rejects(owner`INSERT INTO messages (conversation_id, role, label, body) VALUES (${id}, 'assistant', 'L1', 'tardi')`, /was deleted/);
  const [setting] = await sql<{ flag: string | null }[]>`SELECT current_setting('arianna.purge', true) AS flag`;
  assert.ok(setting?.flag === null || setting?.flag === '');
});

test('the core cannot fake the purge of an incognito with the setting', async () => {
  const { sql } = db();
  const id = await incognito();
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('arianna.purge', ${id}, true)`;
      await tx`UPDATE conversations SET purged_at = now() WHERE id = ${id}`;
    }),
    /only purge_conversation purges/,
  );
});
