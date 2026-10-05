import type { Label } from '@arianna/policy';

import type { Queryable } from './db/client.ts';
import type { ActivityKind } from './reply.ts';

/**
 * The activity lines of a task, saved where they are published (D-083,
 * postActivity) and read again by the web chat once the task has ended. The
 * chat reads them as it reads the messages of the conversation: only lines of
 * a task of a conversation not deleted, within its clearance.
 */
export interface SavedActivity {
  id: string;
  step: number;
  kind: Exclude<ActivityKind, 'thinking'>;
  detail: string;
  label: Label;
  /** ISO time of the line. */
  at: string;
}

/** The lines of a task, oldest first; undefined when the task has no readable conversation. */
export async function listTaskActivities(sql: Queryable, taskId: string): Promise<SavedActivity[] | undefined> {
  const [task] = await sql<{ clearance: Label }[]>`
    SELECT c.clearance FROM tasks t JOIN conversations c ON c.id = t.conversation_id
    WHERE t.id = ${taskId}::uuid AND c.purged_at IS NULL`;
  if (task === undefined) return undefined;
  const rows = await sql<SavedActivity[]>`
    SELECT a.id::text, a.step, a.kind, a.detail, a.label, to_char(a.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM task_activities a
    WHERE a.task_id = ${taskId}::uuid AND a.label <= ${task.clearance}::privacy_label
    ORDER BY a.id`;
  return [...rows];
}

/** How many lines each task of a conversation has saved, for "Mostra i passi (N)"; tasks with none are left out. */
export async function countConversationActivities(sql: Queryable, conversationId: string): Promise<Record<string, number>> {
  const rows = await sql<{ taskId: string; n: number }[]>`
    SELECT t.id::text AS "taskId", count(a.id)::int AS n
    FROM tasks t
    JOIN conversations c ON c.id = t.conversation_id
    JOIN task_activities a ON a.task_id = t.id AND a.label <= c.clearance
    WHERE c.id = ${conversationId}::uuid AND c.purged_at IS NULL
    GROUP BY t.id`;
  return Object.fromEntries(rows.map((row) => [row.taskId, row.n]));
}
