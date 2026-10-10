import { ChatError, isUuid } from './conversations.ts';
import type { Queryable, Sql } from './db/client.ts';

/**
 * "Elimina" of a conversation (D-157, the user's choice of 2026-10-10): the
 * conversation goes for good with everything it left, the audit included,
 * and the chain of the events is sewn again over the gap (erase_conversation
 * in migration 0043). What stays: the cards made from it (unlinked), the
 * notes saved from it in kb/, the files the Coder changed in a project, what
 * a cloud provider received, the sessions of Claude Code in the user's
 * profile. Never the secretary's conversation, nor Telegram's, nor an
 * incognito one (it has "Termina"). A step at work is stopped first, as an
 * incognito does (D-136); a step that does not stop in time answers busy.
 */

export interface EraseOptions {
  /**
   * Stops the step of a task the worker is running now, for good: true when
   * there was one. Without it (tests, a core without a worker) a step still
   * claimed answers busy.
   */
  stopTask?: (taskId: string) => boolean;
  /** How long to wait for a stopped step to give its job back. Default 15 s. */
  waitMs?: number;
  pollMs?: number;
}

/** What erase_conversation removed and kept, as counts only. */
export interface EraseResult {
  conversations: number;
  tasks: number;
  /** Cards made from the conversation, kept without their parent. */
  cards: number;
  events: number;
}

interface Target {
  secretary: boolean;
  incognito: boolean;
  telegram: boolean;
}

async function target(sql: Queryable, id: string): Promise<Target> {
  const [row] = isUuid(id)
    ? await sql<Target[]>`
        SELECT secretary, incognito, EXISTS (SELECT FROM telegram_state t WHERE t.conversation_id = c.id) AS telegram
        FROM conversations c WHERE id = ${id} AND purged_at IS NULL`
    : [];
  if (row === undefined) throw new ChatError('not-found', `conversation ${id} does not exist`);
  return row;
}

/** The tasks of the conversation and of the system chats about them, at any depth: those erase_conversation takes. */
async function tasksOf(sql: Queryable, id: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    WITH RECURSIVE tree (id) AS (
      SELECT ${id}::uuid
      UNION
      SELECT s.id FROM conversations s JOIN tasks t ON t.id = s.source_task_id JOIN tree ON t.conversation_id = tree.id
    )
    SELECT t.id::text FROM tasks t JOIN tree ON t.conversation_id = tree.id`;
  return rows.map((row) => row.id);
}

async function waitForSteps(sql: Sql, taskIds: readonly string[], waitMs: number, pollMs: number): Promise<void> {
  const keys = taskIds.map((id) => `task:${id}`);
  const until = Date.now() + waitMs;
  for (;;) {
    const [row] = await sql<{ running: boolean }[]>`
      SELECT EXISTS (SELECT FROM jobs WHERE status = 'running' AND key = ANY (${keys})) AS running`;
    if (row?.running !== true || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Stops every step of these tasks the worker runs now; waits for them to give their jobs back. */
async function stopSteps(sql: Sql, taskIds: readonly string[], options: EraseOptions): Promise<void> {
  let stopped = false;
  for (const taskId of taskIds) stopped = (options.stopTask?.(taskId) ?? false) || stopped;
  if (stopped) await waitForSteps(sql, taskIds, options.waitMs ?? 15_000, options.pollMs ?? 100);
}

/**
 * Erases a conversation for good (D-157). Refused for the secretary's, for
 * Telegram's and for an incognito one (ChatError 'invalid' or 'incognito'),
 * for a missing one ('not-found'), and while a step or a call is still at
 * work after the stop ('busy'). No event names it: the only trace is the
 * `events.rewoven` line the function writes.
 */
export async function eraseConversation(sql: Sql, id: string, options: EraseOptions = {}): Promise<EraseResult> {
  const found = await target(sql, id);
  if (found.secretary) throw new ChatError('invalid', 'the conversation of the secretary cannot be erased');
  if (found.telegram) throw new ChatError('invalid', 'the conversation of Telegram cannot be erased');
  if (found.incognito) throw new ChatError('incognito', 'an incognito conversation ends with Termina');

  // Two attempts: a step claimed between the stop and the locks is stopped again.
  for (let attempt = 1; ; attempt += 1) {
    await stopSteps(sql, await tasksOf(sql, id), options);
    try {
      const [row] = await sql<{ erased: EraseResult }[]>`SELECT erase_conversation(${id}::uuid) AS erased`;
      return row?.erased ?? { conversations: 0, tasks: 0, cards: 0, events: 0 };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'P0002') throw new ChatError('not-found', `conversation ${id} does not exist`);
      if (code === '55000') throw new ChatError('invalid', 'this conversation cannot be erased');
      if (code === '55006' && attempt < 2 && options.stopTask !== undefined) continue;
      if (code === '55006') throw new ChatError('busy', 'a step or a call of the conversation is still at work: try again in a moment');
      if (code === '55P03' || code === '40P01') throw new ChatError('busy', 'the conversation is in use: try again in a moment');
      throw error;
    }
  }
}
