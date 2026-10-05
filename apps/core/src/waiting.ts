import { isAtMost, maxLabel, type Label } from '@arianna/policy';

import type { Queryable } from './db/client.ts';

/**
 * The tasks that wait for the user ("Attende te"), for the "Decisioni in
 * attesa" window of the web chat (D-091). Only tasks up to L2: a task whose
 * label, context, question or approval is above L2 is only counted in
 * `hidden`, never shown. Tasks of a deleted conversation are left out (their
 * tasks fail with the purge anyway); those of an archived one are marked.
 */

/** Longest question shown, in characters. */
export const WAITING_QUESTION_MAX = 200;

export type WaitingReason = 'question' | 'approval' | 'other';

export interface WaitingTask {
  id: string;
  /** null: the task has no conversation, so it cannot be opened. */
  conversationId: string | null;
  conversationTitle: string | null;
  /** work | private; null without a conversation. */
  mode: string | null;
  archived: boolean;
  title: string;
  /** When the task last moved to waiting_user. */
  since: Date;
  reason: WaitingReason;
  /** Arianna's last message of the task, short; null for the other reasons. */
  question: string | null;
  /** The pending approval that resumes the task. */
  approvalId: string | null;
  /** The message to scroll to: the question, or the user's message that started the task. */
  messageId: string | null;
  /** Why the task waits, as the core wrote it (the page translates the known reasons). */
  waitingReason: string;
  label: Label;
}

export interface WaitingListing {
  tasks: WaitingTask[];
  hidden: number;
}

interface Row {
  id: string;
  conversationId: string | null;
  conversationTitle: string | null;
  mode: string | null;
  archived: boolean | null;
  title: string;
  since: Date;
  waitingReason: string;
  approvalId: string | null;
  approvalPending: boolean | null;
  approvalLabel: Label | null;
  taskLabel: Label;
  effectiveLabel: Label;
  questionId: string | null;
  questionBody: string | null;
  questionLabel: Label | null;
  openerId: string | null;
}

/** One line, at most `max` characters (code points), with an ellipsis when cut. */
export function shortText(text: string, max = WAITING_QUESTION_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

export async function listWaitingTasks(sql: Queryable): Promise<WaitingListing> {
  const rows = await sql<Row[]>`
    SELECT t.id::text, t.conversation_id::text AS "conversationId", c.title AS "conversationTitle", c.mode,
      c.archived_at IS NOT NULL AS archived, t.title, t.waiting_reason AS "waitingReason",
      coalesce(
        (SELECT max(e.ts) FROM events e WHERE e.task_id = t.id AND e.kind = 'task.status' AND e.payload ->> 'to' = 'waiting_user'),
        t.updated_at) AS since,
      t.waiting_approval_id::text AS "approvalId", a.state = 'pending' AS "approvalPending", a.label AS "approvalLabel",
      t.label AS "taskLabel", t.effective_label AS "effectiveLabel",
      q.id::text AS "questionId", q.body AS "questionBody", q.label AS "questionLabel",
      (SELECT min(u.id) FROM messages u WHERE u.task_id = t.id AND u.conversation_id = t.conversation_id AND u.role = 'user')::text AS "openerId"
    FROM tasks t
    LEFT JOIN conversations c ON c.id = t.conversation_id
    LEFT JOIN approvals a ON a.id = t.waiting_approval_id
    LEFT JOIN LATERAL (
      SELECT m.id, m.body, m.label FROM messages m
      WHERE m.task_id = t.id AND m.conversation_id = t.conversation_id AND m.role = 'assistant' AND m.agent IS NULL
      ORDER BY m.id DESC LIMIT 1
    ) q ON true
    WHERE t.status = 'waiting_user' AND (t.conversation_id IS NULL OR c.purged_at IS NULL)
    ORDER BY since, t.id`;
  const tasks: WaitingTask[] = [];
  let hidden = 0;
  for (const row of rows) {
    const label = maxLabel(
      row.taskLabel,
      row.effectiveLabel,
      ...(row.questionLabel === null ? [] : [row.questionLabel]),
      ...(row.approvalLabel === null ? [] : [row.approvalLabel]),
    );
    if (!isAtMost(label, 'L2')) {
      hidden += 1;
      continue;
    }
    const approval = row.approvalId !== null && row.approvalPending === true;
    const question = !approval && row.questionBody !== null && row.questionBody.trim() !== '';
    tasks.push({
      id: row.id,
      conversationId: row.conversationId,
      conversationTitle: row.conversationTitle,
      mode: row.mode,
      archived: row.archived === true,
      title: row.title,
      since: row.since,
      reason: approval ? 'approval' : question ? 'question' : 'other',
      question: question && row.questionBody !== null ? shortText(row.questionBody) : null,
      approvalId: approval ? row.approvalId : null,
      messageId: question ? row.questionId : row.openerId,
      waitingReason: row.waitingReason,
      label,
    });
  }
  return { tasks, hidden };
}
