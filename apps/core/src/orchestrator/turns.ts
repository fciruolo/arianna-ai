import type { Answer } from '@arianna/agents';
import type { Label } from '@arianna/policy';

import type { Queryable } from '../db/client.ts';

/**
 * The orchestrator's context of a task, one turn per completed step
 * (task_turns, migration 0008, D-053). The next step rebuilds what the model
 * reads from these rows and from the conversation, nothing else: a task never
 * sees another task's turns.
 */
export interface Turn {
  step: number;
  runId: string;
  label: Label;
  answer: Answer;
  thought: string | null;
  /** How long the model thought in that step, in ms (D-249); null before 0078 or without a thought. */
  thoughtMs: number | null;
  /** Tool result or error, as the model reads it at the next step. */
  result: string | null;
  messageId: string | null;
}

export interface NewTurn {
  taskId: string;
  step: number;
  runId: string;
  /** Highest label among what the step read; the database raises the task's label to it. */
  label: Label;
  answer: Answer;
  thought?: string;
  thoughtMs?: number;
  result?: string;
  messageId?: string;
}

export async function loadTurns(sql: Queryable, taskId: string): Promise<Turn[]> {
  const rows = await sql<Turn[]>`
    SELECT step, run_id::text AS "runId", label, answer, thought, thought_ms AS "thoughtMs", result, message_id::text AS "messageId"
    FROM task_turns WHERE task_id = ${taskId} ORDER BY step`;
  return [...rows];
}

export async function recordTurn(sql: Queryable, turn: NewTurn): Promise<void> {
  await sql`
    INSERT INTO task_turns (task_id, step, run_id, label, answer, thought, thought_ms, result, message_id)
    VALUES (
      ${turn.taskId}, ${turn.step}, ${turn.runId}, ${turn.label}::privacy_label,
      ${sql.json(turn.answer as unknown as Parameters<typeof sql.json>[0])},
      ${turn.thought ?? null}, ${turn.thought === undefined ? null : (turn.thoughtMs ?? null)}, ${turn.result ?? null}, ${turn.messageId ?? null}::bigint
    )`;
}
