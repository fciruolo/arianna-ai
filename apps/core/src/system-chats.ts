import { clearanceFor, type ConversationMode } from '@arianna/policy';

import { ChatError, isUuid, loadConversation, loadMessage, type Conversation, type DirectModel, type Message } from './conversations.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { loadFailure, type StoredFailure } from './failures.ts';

/**
 * System chats (D-064): conversations the system opens, not the user, kept in
 * their own section of the chat. The first one is about a failed task: its
 * first message, written by the system, holds only the structured error; the
 * question of the task is attached only when the user asks. Mode and
 * clearance are those of the task's conversation (a task without one: private),
 * so the privacy constraints do not change. Arianna answers on the local
 * model like in any conversation; in a work system chat the user can have
 * Claude answer directly instead (`conversations.model`, second part).
 */

/**
 * The title names where it failed, never the task: the task's title is the
 * start of the user's question, which the chat holds only once attached.
 */
const ORIGIN_TITLE: Record<StoredFailure['origin'], string> = {
  'local-model': 'Perché è fallito: modello locale',
  claude: 'Perché è fallito: Claude Code',
  tool: 'Perché è fallito: uno strumento',
  engine: 'Perché è fallito: il nucleo',
};
/** How an attached question starts, for the model and for the user. */
export const QUESTION_HEADER = 'Domanda originale del task fallito:';

const DETAIL_TEXT: Record<string, string> = {
  endpoint: 'endpoint',
  endpoints: 'endpoint provati',
  port: 'porta',
  status: 'stato HTTP',
  attempts: 'tentativi',
  exitCode: 'codice di uscita',
  apiStatus: 'stato HTTP dell’API',
  sqlstate: 'codice SQL',
  executor: 'esecutore',
  error: 'errore',
};

/**
 * The system's first message: the structured error and nothing else. Its
 * values are scalars from the closed list of the code (failures.ts).
 */
export function failureMessage(failure: Pick<StoredFailure, 'origin' | 'code' | 'details'>, options: { again?: boolean } = {}): string {
  const details = Object.entries(failure.details).map(([key, value]) => `${DETAIL_TEXT[key] ?? key} ${String(value)}`);
  return [
    options.again === true ? 'Il task è stato riprovato ed è fallito di nuovo.' : 'Chat di sistema aperta per un task fallito.',
    `Origine: ${failure.origin}`,
    `Codice: ${failure.code}`,
    `Dettagli: ${details.length === 0 ? 'nessuno' : details.join(', ')}`,
    'La domanda del task non è allegata: l’utente può allegarla con «Allega la domanda».',
    'Solo l’utente può riprovare il task, con il pulsante «Riprova»: qui si può solo suggerirlo.',
  ].join('\n');
}

/**
 * Opens the system chat of a failed task, or resumes the one already open
 * (brought back from the archive if needed, and told the newer error if the
 * task failed again). A new one only for a task that is failed now, with a
 * recorded error, whose conversation was not deleted.
 *
 * `directModel` is the Claude model this installation can use now: a new
 * work system chat about a failure of the local model starts with it,
 * because Arianna could not answer there (the user's choice, D-064).
 */
export async function openFailureChat(sql: Sql, taskId: string, options: { directModel?: DirectModel } = {}): Promise<Conversation> {
  if (!isUuid(taskId)) throw new ChatError('not-found', `task ${taskId} does not exist`);
  return sql.begin(async (tx) => {
    // One at a time per task: the unique index would refuse the second anyway.
    const [task] = await tx<{ status: string; mode: ConversationMode | null; purged: boolean }[]>`
      SELECT t.status, c.mode, c.purged_at IS NOT NULL AS purged
      FROM tasks t LEFT JOIN conversations c ON c.id = t.conversation_id
      WHERE t.id = ${taskId} FOR UPDATE OF t`;
    if (task === undefined) throw new ChatError('not-found', `task ${taskId} does not exist`);
    if (task.purged) throw new ChatError('invalid', 'the conversation of the task was deleted');
    const failure = await loadFailure(tx, taskId);
    if (failure === undefined) throw new ChatError('invalid', 'the task has no recorded error');

    const [open] = await tx<{ id: string; archived: boolean; told: string | null }[]>`
      SELECT id::text, archived_at IS NOT NULL AS archived, source_error_id::text AS told FROM conversations
      WHERE origin = 'system' AND system_reason = 'failure' AND source_task_id = ${taskId} AND purged_at IS NULL
      FOR UPDATE`;
    if (open !== undefined) {
      if (open.archived) {
        await tx`UPDATE conversations SET archived_at = NULL WHERE id = ${open.id}`;
        await appendEvent(tx, { kind: 'conversation.archived', label: 'L0', payload: { conversationId: open.id, archived: false } });
      }
      // Retried and failed again: the chat hears the error that holds now.
      if (open.told === null || BigInt(failure.id) > BigInt(open.told)) {
        await writeSystemMessage(tx, open.id, failureMessage(failure, { again: true }), failure.label);
        await tx`UPDATE conversations SET source_error_id = ${failure.id}::bigint WHERE id = ${open.id}`;
      }
      return reload(tx, open.id);
    }
    if (task.status !== 'failed') throw new ChatError('invalid', 'the task is not failed');

    const mode: ConversationMode = task.mode ?? 'private';
    const model = mode === 'work' && failure.origin === 'local-model' ? (options.directModel ?? null) : null;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO conversations (mode, clearance, title, origin, system_reason, source_task_id, source_error_id, model)
      VALUES (${mode}, ${clearanceFor(mode)}::privacy_label, ${ORIGIN_TITLE[failure.origin]}, 'system', 'failure', ${taskId}, ${failure.id}::bigint, ${model})
      RETURNING id::text`;
    if (row === undefined) throw new Error('INSERT INTO conversations returned no row');
    await appendEvent(tx, { kind: 'conversation.created', label: 'L0', payload: { conversationId: row.id, mode, origin: 'system' } });
    await writeSystemMessage(tx, row.id, failureMessage(failure), failure.label);
    return reload(tx, row.id);
  });
}

/**
 * Attaches the question of the failed task to its system chat, once, when
 * the user asks for it. The message keeps the label of the question.
 */
export async function attachQuestion(sql: Sql, conversationId: string): Promise<Message> {
  return sql.begin(async (tx) => {
    if (isUuid(conversationId)) await tx`SELECT 1 FROM conversations WHERE id = ${conversationId} FOR UPDATE`;
    const conversation = await loadConversation(tx, conversationId);
    if (conversation === undefined) throw new ChatError('not-found', `conversation ${conversationId} does not exist`);
    if (conversation.origin !== 'system' || conversation.sourceTaskId === null) throw new ChatError('invalid', 'only a system chat takes the question of a task');
    if (conversation.archivedAt !== null) throw new ChatError('archived', 'the conversation is archived: restore it to write');
    if (conversation.questionAttached) throw new ChatError('invalid', 'the question is already attached');
    const [question] = await tx<{ body: string; label: Message['label'] }[]>`
      SELECT body, label FROM messages
      WHERE task_id = ${conversation.sourceTaskId} AND role = 'user'
      ORDER BY messages.id LIMIT 1`;
    if (question === undefined) throw new ChatError('invalid', 'the task has no question to attach');
    const message = await writeSystemMessage(tx, conversationId, `${QUESTION_HEADER}\n${question.body}`, question.label);
    await tx`UPDATE conversations SET question_attached = true WHERE id = ${conversationId}`;
    return message;
  });
}

async function writeSystemMessage(tx: Queryable, conversationId: string, body: string, label: Message['label']): Promise<Message> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, channel, label, body)
    VALUES (${conversationId}, 'system', 'web', ${label}::privacy_label, ${body})
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO messages returned no row');
  await appendEvent(tx, { kind: 'message.created', label: 'L0', payload: { conversationId, messageId: row.id, role: 'system' } });
  const message = await loadMessage(tx, row.id);
  if (message === undefined) throw new Error('the new message is missing');
  return message;
}

async function reload(sql: Queryable, id: string): Promise<Conversation> {
  const conversation = await loadConversation(sql, id);
  if (conversation === undefined) throw new Error('the conversation is missing');
  return conversation;
}
