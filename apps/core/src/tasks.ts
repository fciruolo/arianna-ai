import type { Label } from '@arianna/policy';

import type { Queryable } from './db/client.ts';
import { appendEvent } from './events.ts';
import { parseLimits } from './limits.ts';
import { movesInto, type TaskStatus } from './task-status.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Task {
  id: string;
  parentId: string | null;
  title: string;
  goal: string | null;
  doneCriteria: string | null;
  status: TaskStatus;
  label: Label;
  clearance: Label;
  effectiveLabel: Label;
  /** 'user' or the name of an agent. */
  assignee: string;
  limits: Record<string, unknown>;
  evidence: Json[];
  waitingReason: string | null;
  /** The approval a waiting task waits for. */
  waitingApprovalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTask {
  title: string;
  goal?: string;
  doneCriteria?: string;
  parentId?: string;
  /** Omitted: L2 (default-deny). */
  label?: Label;
  clearance?: Label;
  assignee?: string;
  /** snake_case, as in the agent cards: max_steps, max_minutes, max_cost. */
  limits?: { max_steps?: number; max_minutes?: number; max_cost?: number };
  status?: 'inbox' | 'ready';
}

export class TaskError extends Error {
  override name = 'TaskError';
}

function columns(table = ''): string {
  const t = table === '' ? '' : `${table}.`;
  return `${t}id::text, ${t}parent_id::text AS "parentId", ${t}title, ${t}goal, ${t}done_criteria AS "doneCriteria",
  ${t}status, ${t}label, ${t}clearance, ${t}effective_label AS "effectiveLabel", ${t}assignee, ${t}limits, ${t}evidence,
  ${t}waiting_reason AS "waitingReason", ${t}waiting_approval_id::text AS "waitingApprovalId", ${t}created_at AS "createdAt", ${t}updated_at AS "updatedAt"`;
}
const COLUMNS = columns();

/** Creates a task and its `task.created` event. Titles may be L2: events carry the id only. */
export async function createTask(sql: Queryable, task: NewTask): Promise<Task> {
  parseLimits(task.limits ?? {});
  const [row] = await sql<Task[]>`
    INSERT INTO tasks (title, goal, done_criteria, parent_id, label, clearance, assignee, limits, status)
    VALUES (
      ${task.title}, ${task.goal ?? null}, ${task.doneCriteria ?? null}, ${task.parentId ?? null},
      ${task.label ?? 'L2'}::privacy_label, ${task.clearance ?? 'L2'}::privacy_label, ${task.assignee ?? 'user'},
      ${sql.json(task.limits ?? {})}, ${task.status ?? 'inbox'}::task_status
    )
    RETURNING ${sql.unsafe(COLUMNS)}`;
  if (row === undefined) throw new Error('INSERT INTO tasks returned no row');
  await appendEvent(sql, { kind: 'task.created', taskId: row.id, payload: { status: row.status, assignee: row.assignee } });
  return row;
}

export async function loadTask(sql: Queryable, id: string): Promise<Task | undefined> {
  const [row] = await sql.unsafe<Task[]>(`SELECT ${COLUMNS} FROM tasks WHERE id = $1`, [id]);
  return row;
}

/** Why a task moved, for the event log; the free-text reason stays in `tasks`. */
export type MoveCause = 'user' | 'engine' | 'limit' | 'approval' | 'executor' | 'error';

export interface MoveOptions {
  /** Required for `waiting_user`: the one line the user reads. Stored in the task, not in events. */
  reason?: string;
  cause?: MoveCause;
  /** With `waiting_user`: the approval whose decision resumes the task. */
  approvalId?: string;
  /** Replaces the evidence (diff, test, document references). */
  evidence?: Json[];
}

/**
 * Moves a task to `to`, only from a status allowed by task-status.ts, and
 * writes `task.status`. Run it inside a transaction with the work it records.
 */
export async function moveTask(sql: Queryable, id: string, to: TaskStatus, options: MoveOptions = {}): Promise<Task> {
  if (to === 'waiting_user' && (options.reason === undefined || options.reason.trim() === '')) {
    throw new TaskError('waiting_user needs a reason');
  }
  const from = movesInto(to);
  const evidence = options.evidence === undefined ? null : sql.json(options.evidence);
  const [row] = await sql<(Task & { previous: TaskStatus })[]>`
    UPDATE tasks t SET
      status = ${to}::task_status,
      waiting_reason = ${to === 'waiting_user' ? (options.reason ?? null) : null},
      waiting_approval_id = ${to === 'waiting_user' ? (options.approvalId ?? null) : null}::uuid,
      evidence = COALESCE(${evidence}::jsonb, t.evidence),
      updated_at = now()
    FROM (SELECT id, status AS previous FROM tasks WHERE id = ${id} FOR UPDATE) old
    WHERE t.id = old.id AND old.previous::text = ANY(${sql.array(from)})
    RETURNING ${sql.unsafe(columns('t'))}, old.previous`;
  if (row === undefined) {
    const current = await loadTask(sql, id);
    throw new TaskError(
      current === undefined ? `task ${id} does not exist` : `task ${id} cannot move from ${current.status} to ${to}`,
    );
  }
  const { previous, ...task } = row;
  await appendEvent(sql, {
    kind: 'task.status',
    taskId: id,
    // The reason may come from an executor and hold content: only its cause goes in the log.
    payload: { from: previous, to, cause: options.cause ?? 'engine' },
  });
  return task;
}

/** Replaces the caps of a task (the user raising them from "Attende te"). */
export async function setTaskLimits(sql: Queryable, id: string, limits: NonNullable<NewTask['limits']>): Promise<void> {
  parseLimits(limits);
  const rows = await sql`UPDATE tasks SET limits = ${sql.json(limits)}, updated_at = now() WHERE id = ${id} RETURNING id`;
  if (rows.length !== 1) throw new TaskError(`task ${id} does not exist`);
  await appendEvent(sql, { kind: 'task.limits', taskId: id, label: 'L0', payload: { ...limits } });
}
