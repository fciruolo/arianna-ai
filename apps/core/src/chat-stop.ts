/**
 * "Ferma" in the chat (D-218, idea 4 of OpenWork, D-093): the user stops the
 * answer at work in a conversation. The task fails with `engine.user-stopped`,
 * a line "Fermato da te." goes under it, and the queue of the conversation
 * pauses: nothing of it leaves alone until the user says so.
 */
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { recordFailure } from './failures.ts';
import { interruptRunning } from './runs.ts';
import { loadTask, moveTask } from './tasks.ts';

/** The line under a task the user stopped: the chat recognizes it by this text. */
export const STOPPED_TEXT = 'Fermato da te.';

/**
 * Fails a task the user stopped, inside the caller's transaction: its open
 * runs end, the task fails with `engine.user-stopped` and the line goes in
 * its conversation. A task that already moved on is left as it is.
 */
export async function stopTaskByUser(tx: Queryable, taskId: string): Promise<boolean> {
  const task = await loadTask(tx, taskId);
  if (task === undefined || (task.status !== 'running' && task.status !== 'ready')) return false;
  await interruptRunning(tx, taskId);
  await moveTask(tx, taskId, 'failed', { cause: 'user' });
  await recordFailure(tx, taskId, { origin: 'engine', code: 'engine.user-stopped', details: {} });
  if (task.conversationId !== null) {
    const [line] = await tx<{ id: string }[]>`
      INSERT INTO messages (conversation_id, role, channel, label, body, task_id)
      VALUES (${task.conversationId}, 'system', 'web', 'L0'::privacy_label, ${STOPPED_TEXT}, ${taskId})
      RETURNING id::text`;
    if (line === undefined) throw new Error('INSERT INTO messages returned no row');
    await appendEvent(tx, { kind: 'message.created', taskId, label: 'L0', payload: { conversationId: task.conversationId, messageId: line.id, role: 'system' } });
  }
  return true;
}

/** "Ferma", or a queued message the checks now refuse (message-queue.ts): nothing of the queue leaves alone. */
export async function pauseQueue(tx: Queryable, conversationId: string): Promise<void> {
  await tx`
    INSERT INTO message_queue_pauses (conversation_id) VALUES (${conversationId})
    ON CONFLICT (conversation_id) DO UPDATE SET paused = true, changed_at = now()`;
}

export interface StopOptions {
  /** Stops the step of a task the worker is running now (Worker.stopTask, cause `user`); false when none runs. */
  stopTask: (taskId: string) => boolean;
  /** Pause between the looks at the tasks still at work. */
  pollMs?: number;
  attempts?: number;
}

/**
 * "Ferma": every task of the conversation at work (ready or running) stops.
 * A step not yet taken by the worker fails here with its job; one at work is
 * stopped through the worker, which fails it the same way. The queue pauses
 * when it holds messages. The conversation is locked first, as every writer
 * of it does (closing, erase, the queue), and the event comes last (0033).
 * Returns how many tasks were at work, and how many still were at the end.
 */
export async function stopConversation(sql: Sql, conversationId: string, options: StopOptions): Promise<{ stopped: number; left: number }> {
  const pollMs = options.pollMs ?? 200;
  const attempts = options.attempts ?? 10;
  const atWork = new Set<string>();
  let running: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    running = await sql.begin(async (tx) => {
      const [conversation] = await tx`SELECT 1 FROM conversations WHERE id = ${conversationId} AND purged_at IS NULL FOR UPDATE`;
      if (conversation === undefined) return [];
      const tasks = await tx<{ id: string }[]>`
        SELECT id::text FROM tasks WHERE conversation_id = ${conversationId} AND status IN ('ready', 'running') ORDER BY id FOR UPDATE`;
      const left: string[] = [];
      for (const task of tasks) {
        atWork.add(task.id);
        // Not yet taken by the worker: its job fails here, never back in the queue.
        const [job] = await tx<{ id: string }[]>`
          UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = 'user'
          WHERE key = ${`task:${task.id}`} AND status = 'queued' RETURNING id::text`;
        if (job !== undefined) await stopTaskByUser(tx, task.id);
        else left.push(task.id);
      }
      // Paused in the same transaction: the queue never sends in between.
      if (attempt === 0 && tasks.length > 0) {
        const [queued] = await tx`SELECT 1 FROM queued_messages WHERE conversation_id = ${conversationId} LIMIT 1`;
        if (queued !== undefined) {
          await pauseQueue(tx, conversationId);
          await appendEvent(tx, { kind: 'conversation.queue', label: 'L0', payload: { conversationId } });
        }
      }
      return left;
    });
    if (running.length === 0) break;
    for (const taskId of running) options.stopTask(taskId);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { stopped: atWork.size, left: running.length };
}
