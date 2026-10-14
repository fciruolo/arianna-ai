// The saved terminal of a run of the Coder (D-095, migration 0062): saved with
// its delegation, read within the clearance of the conversation, never for an
// incognito conversation, insert-only for the application role, deleted with
// the delegation by the purge.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { archiveConversation, createConversation, postUserMessage, purgeConversation } from '../src/conversations.ts';
import { eraseConversation } from '../src/erase.ts';
import { listTaskTerminal, MAX_SAVED_TERMINAL, saveTerminal, type TerminalEntry } from '../src/live-terminal.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

async function delegated(incognito = false): Promise<{ conversationId: string; taskId: string; delegationId: string }> {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work', incognito });
  const { task } = await postUserMessage(sql, conversation.id, 'Chiedi al Coder di lanciare git status');
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO task_delegations (task_id, step, agent, brief, label) VALUES (${task.id}, 1, 'coder', 'git status', 'L1') RETURNING id::text`;
  assert.ok(row !== undefined);
  return { conversationId: conversation.id, taskId: task.id, delegationId: row.id };
}

const command: TerminalEntry = { callId: 'toolu_1', part: 'command', label: 'L1', text: 'git status', truncated: false, hidden: 0 };
const output: TerminalEntry = { callId: 'toolu_1', part: 'output', label: 'L1', text: 'On branch main\nOperation not permitted', truncated: false, hidden: 1, error: true };

test('a command and its output are saved with the delegation and read back in order', async () => {
  const { sql } = db();
  const { taskId, delegationId } = await delegated();
  await saveTerminal(sql, delegationId, command);
  await saveTerminal(sql, delegationId, output);
  assert.deepEqual(await listTaskTerminal(sql, taskId), [
    { callId: 'toolu_1', step: 1, part: 'command', text: 'git status', truncated: false, hidden: 0, refused: false, error: false },
    { callId: 'toolu_1', step: 1, part: 'output', text: 'On branch main\nOperation not permitted', truncated: false, hidden: 1, refused: false, error: true },
  ]);
  // A task that does not exist has no terminal.
  assert.equal(await listTaskTerminal(sql, '00000000-0000-0000-0000-000000000000'), undefined);
});

test('the database refuses an incognito conversation, a label above L1, a refused text with content and a bad call id', async () => {
  const { sql } = db();
  const hidden = await delegated(true);
  await assert.rejects(saveTerminal(sql, hidden.delegationId, command), /incognito/);
  const { delegationId } = await delegated();
  // In a work conversation (clearance L1) the guard, which runs before the checks, refuses L2 as above the clearance.
  await assert.rejects(saveTerminal(sql, delegationId, { ...command, label: 'L2' }), /above the clearance/);
  await assert.rejects(saveTerminal(sql, delegationId, { ...output, refused: true }), /task_terminal_refused_empty/);
  await assert.rejects(saveTerminal(sql, delegationId, { ...command, callId: 'a\nb' }), /check/i);
  // Allowed: a refused text, empty.
  await saveTerminal(sql, delegationId, { ...output, text: '', refused: true });
});

test('at most MAX_SAVED_TERMINAL rows per delegation', async () => {
  const { sql, owner } = db();
  const { delegationId } = await delegated();
  await owner`
    INSERT INTO task_terminal (delegation_id, call_id, part, label, text, truncated, hidden)
    SELECT ${delegationId}::bigint, 'toolu_' || n, 'command', 'L1', 'ls', false, 0 FROM generate_series(1, ${MAX_SAVED_TERMINAL}) n`;
  await assert.rejects(saveTerminal(sql, delegationId, command), /400 rows already/);
});

test('the application role cannot change or delete a row; the purge deletes them with the delegation', async () => {
  const { sql, owner } = db();
  const { conversationId, taskId, delegationId } = await delegated();
  await saveTerminal(sql, delegationId, command);
  await assert.rejects(sql`UPDATE task_terminal SET text = 'x'`, /permission denied/);
  await assert.rejects(sql`DELETE FROM task_terminal`, /permission denied/);
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${taskId}`}`;
  await owner`UPDATE tasks SET status = 'waiting_user', waiting_reason = 'domanda per l''utente' WHERE id = ${taskId}`;
  await archiveConversation(sql, conversationId, true);
  await purgeConversation(sql, conversationId);
  const [left] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM task_terminal WHERE delegation_id = ${delegationId}::bigint`;
  assert.equal(left?.n, 0);
});

test('«Elimina» of the chat (erase_conversation) deletes them with the delegation too', async () => {
  const { sql, owner } = db();
  const { conversationId, taskId, delegationId } = await delegated();
  await saveTerminal(sql, delegationId, command);
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${taskId}`}`;
  await owner`UPDATE tasks SET status = 'waiting_user', waiting_reason = 'domanda per l''utente' WHERE id = ${taskId}`;
  await eraseConversation(sql, conversationId);
  const [left] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM task_terminal WHERE delegation_id = ${delegationId}::bigint`;
  assert.equal(left?.n, 0);
});

test('the guard refuses a conversation deleted below the purge (as only a bug or a hand could); reading finds nothing', async () => {
  const { sql, owner } = db();
  const gone = await delegated();
  await owner`ALTER TABLE conversations DISABLE TRIGGER USER`;
  try {
    await owner`UPDATE conversations SET archived_at = now(), title = NULL, purged_at = now() WHERE id = ${gone.conversationId}`;
  } finally {
    await owner`ALTER TABLE conversations ENABLE TRIGGER USER`;
  }
  await assert.rejects(saveTerminal(sql, gone.delegationId, command), /was deleted/);
  assert.equal(await listTaskTerminal(sql, gone.taskId), undefined);
});
