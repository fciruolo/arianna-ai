import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  archiveConversation,
  ChatError,
  createConversation,
  listConversations,
  loadConversation,
  postUserMessage,
  purgeConversation,
} from '../src/conversations.ts';
import { verifyEventChain } from '../src/events.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
// Every text of the conversation carries this word: none may survive the purge.
const MARK = 'segretofinto';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A private conversation as the core leaves it after some work: messages, an
 * orchestrator turn, a delegation, a decided declassification with its label
 * change, a budget card still pending, a gateway row with its L1 summary.
 */
async function busyConversation(): Promise<{ conversationId: string; taskId: string; otherTaskId: string }> {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, `Domanda ${MARK} sul contratto finto`);
  // The step job ran.
  await owner`UPDATE jobs SET status = 'done', last_error = ${`errore ${MARK}`} WHERE key = ${`task:${task.id}`}`;
  const [run] = await owner<{ id: string }[]>`
    INSERT INTO runs (task_id, step, agent, executor, locality) VALUES (${task.id}, 1, 'arianna', 'local', 'local') RETURNING id::text`;
  const [reply] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id)
    VALUES (${conversation.id}, 'assistant', 'L2', ${`Risposta ${MARK}`}, ${task.id}) RETURNING id::text`;
  await owner`
    INSERT INTO task_turns (task_id, step, run_id, label, answer, thought, result, message_id)
    VALUES (${task.id}, 1, ${run?.id ?? ''}, 'L2', ${owner.json({ action: 'reply', text: MARK })}, ${`pensiero ${MARK}`}, ${`risultato ${MARK}`}, ${reply?.id ?? ''})`;
  await owner`UPDATE runs SET status = 'ok', ended_at = now() WHERE id = ${run?.id ?? ''}`;
  await owner`
    INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${task.id}, 1, 'search', ${`cerca ${MARK}`}, 'L2')`;
  await owner`
    INSERT INTO task_delegations (task_id, step, agent, brief, label, status, result, result_label, ended_at)
    VALUES (${task.id}, 2, 'coder', ${`brief ${MARK}`}, 'L1', 'ok', ${`rapporto ${MARK}`}, 'L1', now())`;
  const text = `testo da declassare ${MARK}`;
  const [declassify] = await owner<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label, state, decided_at, decided_via)
    VALUES (${task.id}, 'declassify', 'declassify',
      ${owner.json({ text, sha256: sha256(text), from: 'L2', to: 'L1' })}, 'L2', 'approved', now(), 'web')
    RETURNING id::text`;
  await owner`
    INSERT INTO label_changes (subject, from_label, to_label, approval_id)
    VALUES (${`content:${sha256(text)}`}, 'L2', 'L1', ${declassify?.id ?? ''})`;
  await owner`
    INSERT INTO gateway_log (task_id, target_kind, target, locality, label, decision, rule, reason, bytes_out, payload_sha256, summary)
    VALUES (${task.id}, 'executor', 'claude', 'cloud', 'L1', 'allow', 'cloud-up-to-l1', 'L1 to cloud', 42, ${sha256(text)}, 'brief di prova L1')`;
  const [budget] = await owner<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${task.id}, 'budget', 'budget', ${owner.json({ model: 'fable', why: MARK })}, 'L2') RETURNING id::text`;
  await owner`
    UPDATE tasks SET status = 'waiting_user', waiting_reason = 'approval needed: budget', waiting_approval_id = ${budget?.id ?? ''},
      goal = ${`obiettivo ${MARK}`}
    WHERE id = ${task.id}`;
  // A second task, done by the agent and waiting for the user to check it, with an approved workspace card.
  const second = await postUserMessage(sql, conversation.id, `Seconda domanda ${MARK}`);
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${second.task.id}`}`;
  await owner`UPDATE tasks SET status = 'to_verify', evidence = ${owner.json([{ kind: 'message', ref: second.message.id }])} WHERE id = ${second.task.id}`;
  await owner`
    INSERT INTO approvals (task_id, kind, action, detail, label, state, decided_at, decided_via)
    VALUES (${second.task.id}, 'workspace', 'dirty-workspace', ${owner.json({ repo: 'repos/demo', files: [`${MARK}.txt`] })}, 'L1', 'approved', now(), 'web')`;
  return { conversationId: conversation.id, taskId: task.id, otherTaskId: second.task.id };
}

/** What is left of a conversation's texts: its messages, turns, delegations, and rows that mention MARK. */
async function leftovers(conversationId: string, ...taskIds: string[]): Promise<string[]> {
  const { owner } = db();
  const mark = `%${MARK}%`;
  const keys = taskIds.map((id) => `task:${id}`);
  const rows = await owner<{ place: string }[]>`
    SELECT 'messages' AS place FROM messages m WHERE m.conversation_id = ${conversationId}
    UNION ALL SELECT 'conversations' FROM conversations c WHERE c.id = ${conversationId} AND c::text LIKE ${mark}
    UNION ALL SELECT 'tasks' FROM tasks t WHERE t.id::text = ANY (${taskIds}) AND t::text LIKE ${mark}
    UNION ALL SELECT 'task_turns' FROM task_turns tt WHERE tt.task_id::text = ANY (${taskIds})
    UNION ALL SELECT 'task_delegations' FROM task_delegations d WHERE d.task_id::text = ANY (${taskIds})
    UNION ALL SELECT 'task_activities' FROM task_activities ta WHERE ta.task_id::text = ANY (${taskIds})
    UNION ALL SELECT 'approvals' FROM approvals a WHERE a.task_id::text = ANY (${taskIds}) AND a::text LIKE ${mark}
    UNION ALL SELECT 'jobs' FROM jobs j WHERE j.key = ANY (${keys}) AND j::text LIKE ${mark}
    UNION ALL SELECT 'events' FROM events e
      WHERE (e.task_id::text = ANY (${taskIds}) OR e.payload ->> 'conversationId' = ${conversationId}) AND e.payload::text LIKE ${mark}`;
  return rows.map((row) => row.place);
}

test('a purge deletes every text of an archived conversation and keeps the skeleton of the audit', async () => {
  const { sql, owner } = db();
  const { conversationId, taskId, otherTaskId } = await busyConversation();
  assert.ok((await leftovers(conversationId, taskId, otherTaskId)).length > 0);
  await archiveConversation(sql, conversationId, true);
  await purgeConversation(sql, conversationId);

  assert.deepEqual(await leftovers(conversationId, taskId, otherTaskId), []);
  const [conversation] = await owner<{ title: string | null; purged: boolean; archived: boolean }[]>`
    SELECT title, purged_at IS NOT NULL AS purged, archived_at IS NOT NULL AS archived FROM conversations WHERE id = ${conversationId}`;
  assert.deepEqual(conversation, { title: null, purged: true, archived: true });
  const [task] = await owner<{ title: string; status: string; goal: string | null; waiting: string | null }[]>`
    SELECT title, status, goal, waiting_approval_id::text AS waiting FROM tasks WHERE id = ${taskId}`;
  assert.deepEqual(task, { title: 'Conversazione eliminata', status: 'failed', goal: null, waiting: null });
  const approvals = await owner<{ kind: string; state: string; detail: Record<string, unknown> }[]>`
    SELECT kind, state, detail FROM approvals WHERE task_id = ${taskId} ORDER BY kind`;
  assert.deepEqual([...approvals], [
    { kind: 'budget', state: 'expired', detail: { purged: true } },
    { kind: 'declassify', state: 'approved', detail: { text: '', sha256: sha256(''), from: 'L2', to: 'L1', purged: true } },
  ]);
  const [other] = await owner<{ title: string; status: string; detail: Record<string, unknown> }[]>`
    SELECT t.title, t.status, a.detail FROM tasks t JOIN approvals a ON a.task_id = t.id WHERE t.id = ${otherTaskId}`;
  assert.deepEqual(other, { title: 'Conversazione eliminata', status: 'failed', detail: { purged: true } });

  // The audit: what left for the cloud, the label change, the runs, the chain.
  const [gateway] = await owner<{ summary: string; bytes: number }[]>`
    SELECT summary, bytes_out AS bytes FROM gateway_log WHERE task_id = ${taskId}`;
  assert.deepEqual(gateway, { summary: 'brief di prova L1', bytes: 42 });
  assert.equal((await owner`SELECT 1 FROM label_changes WHERE approval_id IN (SELECT id FROM approvals WHERE task_id = ${taskId})`).length, 1);
  assert.equal((await owner`SELECT 1 FROM runs WHERE task_id = ${taskId}`).length, 1);
  assert.equal((await verifyEventChain(owner)).ok, true);
  const [event] = await owner<{ label: string; payload: Record<string, unknown> }[]>`
    SELECT label, payload FROM events WHERE kind = 'conversation.purged' AND payload ->> 'conversationId' = ${conversationId}`;
  assert.deepEqual(event, { label: 'L0', payload: { conversationId, tasks: 2 } });
  // Every state the purge changed is in the log, as the engine logs its own.
  const changes = await owner<{ kind: string; task: string; payload: Record<string, unknown> }[]>`
    SELECT kind, task_id::text AS task, payload FROM events
    WHERE ((kind = 'task.status' AND payload ->> 'cause' = 'purge') OR (kind = 'approval.decided' AND payload ->> 'state' = 'expired'))
      AND task_id IN (${taskId}, ${otherTaskId})
    ORDER BY id`;
  assert.deepEqual(
    changes.filter((row) => row.task === taskId || row.task === otherTaskId).map((row) => [row.kind, row.task, row.payload.from ?? row.payload.state]),
    [
      ...[
        ['task.status', taskId, 'waiting_user'],
        ['task.status', otherTaskId, 'to_verify'],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      ['approval.decided', taskId, 'expired'],
    ],
  );

  // Shown nowhere, written to never again.
  assert.equal(await loadConversation(sql, conversationId), undefined);
  assert.ok(!(await listConversations(sql, 200, { archived: true })).some((item) => item.id === conversationId));
  await assert.rejects(postUserMessage(sql, conversationId, 'Ci sei?'), (error: unknown) => error instanceof ChatError && error.code === 'not-found');
  await assert.rejects(archiveConversation(sql, conversationId, false), /does not exist/);
  await assert.rejects(purgeConversation(sql, conversationId), /does not exist/);
  await assert.rejects(sql`UPDATE conversations SET archived_at = NULL WHERE id = ${conversationId}`, /never changes/);
  await assert.rejects(
    owner`INSERT INTO messages (conversation_id, role, label, body) VALUES (${conversationId}, 'assistant', 'L2', 'tardi')`,
    /was deleted/,
  );
});

test('after a purge the append-only guards are on again', async () => {
  const { sql, owner } = db();
  const { conversationId, taskId } = await busyConversation();
  const other = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, other.id, 'Questa resta');
  await archiveConversation(sql, conversationId, true);
  await purgeConversation(sql, conversationId);

  await assert.rejects(owner`DELETE FROM messages WHERE conversation_id = ${other.id}`, /append-only/);
  await assert.rejects(owner`DELETE FROM task_turns`, /append-only/);
  await assert.rejects(owner`DELETE FROM task_delegations`, /append-only/);
  await assert.rejects(owner`DELETE FROM task_activities`, /append-only/);
  await assert.rejects(owner`UPDATE approvals SET detail = '{}' WHERE task_id = ${taskId} AND state = 'approved'`, /already approved/);
  await assert.rejects(owner`UPDATE conversations SET mode = 'work', clearance = 'L1' WHERE id = ${other.id}`, /only the effective label/);
  const [triggers] = await owner<{ disabled: number }[]>`
    SELECT count(*)::int AS disabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema()) AND NOT t.tgisinternal AND t.tgenabled = 'D'`;
  assert.equal(triggers?.disabled, 0);
  assert.equal((await listConversations(sql)).find((item) => item.id === other.id)?.title, 'Questa resta');
  // The setting does not outlive the purge.
  const [setting] = await sql<{ flag: string | null }[]>`SELECT current_setting('arianna.purge', true) AS flag`;
  assert.ok(setting?.flag === null || setting?.flag === '');
});

test('the setting of the purge opens nothing to the core, nor to the owner outside it', async () => {
  const { sql, owner } = db();
  const { conversationId, otherTaskId } = await busyConversation();
  await archiveConversation(sql, conversationId, true);
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('arianna.purge', ${conversationId}, true)`;
      await tx`UPDATE approvals SET detail = '{"purged": true}' WHERE task_id = ${otherTaskId}`;
    }),
    /already approved/,
  );
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('arianna.purge', ${conversationId}, true)`;
      await tx`UPDATE conversations SET title = NULL, purged_at = now() WHERE id = ${conversationId}`;
    }),
    /only purge_conversation purges/,
  );
  // Without the setting, not even the owner deletes.
  await assert.rejects(owner`DELETE FROM messages WHERE conversation_id = ${conversationId}`, /append-only/);
  assert.ok((await leftovers(conversationId, otherTaskId)).length > 0);
});

test('a purge does not wait for, nor block, a reply being written in another conversation', async () => {
  const { sql } = db();
  const { conversationId } = await busyConversation();
  await archiveConversation(sql, conversationId, true);
  const other = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, other.id, 'Altra conversazione');
  // A reply's transaction holds its rows in messages and conversations while the purge runs.
  await sql.begin(async (tx) => {
    await tx`INSERT INTO messages (conversation_id, role, label, body, task_id) VALUES (${other.id}, 'assistant', 'L2', 'risposta', ${task.id})`;
    await purgeConversation(sql, conversationId);
    await tx`INSERT INTO messages (conversation_id, role, label, body, task_id) VALUES (${other.id}, 'assistant', 'L2', 'seconda', ${task.id})`;
  });
  assert.equal(await loadConversation(sql, conversationId), undefined);
});

test('only an archived conversation whose tasks are not at work can be purged', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, `Ancora al lavoro ${MARK}`);
  await assert.rejects(purgeConversation(sql, conversation.id), /only an archived conversation/);
  await assert.rejects(sql`SELECT purge_conversation(${conversation.id}::uuid)`, /only an archived conversation/);

  // The task is ready and its job queued: the purge waits for them.
  await archiveConversation(sql, conversation.id, true);
  await assert.rejects(purgeConversation(sql, conversation.id), (error: unknown) => error instanceof ChatError && error.code === 'busy');
  await assert.rejects(sql`SELECT purge_conversation(${conversation.id}::uuid)`, /still at work/);
  // A task already done but with its job still queued is at work too.
  await owner`UPDATE tasks SET status = 'done', evidence = '[{"kind":"message","ref":"1"}]' WHERE id = ${task.id}`;
  await assert.rejects(sql`SELECT purge_conversation(${conversation.id}::uuid)`, /still at work/);
  // Seen only under the locks: the refusal of the function becomes the same error.
  await assert.rejects(purgeConversation(sql, conversation.id), (error: unknown) => error instanceof ChatError && error.code === 'busy');
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  await purgeConversation(sql, conversation.id);
  assert.equal((await leftovers(conversation.id, task.id)).length, 0);

  await assert.rejects(purgeConversation(sql, '00000000-0000-0000-0000-000000000000'), /does not exist/);
  await assert.rejects(purgeConversation(sql, 'not-a-uuid'), /does not exist/);
});

test('the core reaches the texts only through purge_conversation', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  await postUserMessage(sql, conversation.id, 'Messaggio finto');
  await assert.rejects(sql`DELETE FROM messages WHERE conversation_id = ${conversation.id}`, /permission denied/);
  await assert.rejects(sql`ALTER TABLE messages DISABLE TRIGGER messages_append_only`, /must be owner/);
  await assert.rejects(sql`UPDATE conversations SET purged_at = now(), title = NULL, archived_at = now() WHERE id = ${conversation.id}`, /only purge_conversation/);
  // Nobody else may call it.
  const [grants] = await owner<{ public: boolean; app: boolean }[]>`
    SELECT has_function_privilege('public', 'purge_conversation(uuid)', 'EXECUTE') AS public,
           has_function_privilege('arianna_app', 'purge_conversation(uuid)', 'EXECUTE') AS app`;
  assert.deepEqual(grants, { public: false, app: true });
});
