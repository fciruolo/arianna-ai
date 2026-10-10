import type { Label } from '@arianna/policy';

import type { Queryable } from './db/client.ts';
import { appendEvent } from './events.ts';
import { enqueueJob } from './jobs.ts';
import { parseLimits } from './limits.ts';
import { movesInto, type TaskStatus } from './task-status.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Task {
  id: string;
  parentId: string | null;
  /** The conversation the task answers in, if a chat message started it. */
  conversationId: string | null;
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
  /** The last note an agent wrote on a card with `task.update`; only cards hold one (migration 0023). */
  note: string | null;
  /** The project of a card (D-152); null: a general card, or a task of a conversation. */
  project: string | null;
  dueAt: Date | null;
  /** 0 none, 1-4 Bassa-Altissima (migration 0041). */
  priority: number;
  /** "YYYY-MM-DD": the day a card is meant to be done on ("Data esecuzione"). */
  plannedOn: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTask {
  title: string;
  goal?: string;
  doneCriteria?: string;
  parentId?: string;
  /** Its clearance may not exceed the conversation's (database trigger). */
  conversationId?: string;
  /** Omitted: L2 (default-deny). */
  label?: Label;
  clearance?: Label;
  /** What the task has already read when it starts, e.g. the user's message. Omitted: L0. */
  effectiveLabel?: Label;
  assignee?: string;
  /** Only for a card (no conversation): the name of a project of arianna.toml (D-152). */
  project?: string;
  dueAt?: Date;
  /** snake_case, as in the agent cards: max_steps, max_minutes, max_cost. */
  limits?: { max_steps?: number; max_minutes?: number; max_cost?: number };
  status?: 'inbox' | 'ready';
}

/** The queue of the task engine's steps (engine.ts). */
export const STEP_QUEUE = 'task.step';

export class TaskError extends Error {
  override name = 'TaskError';
}

function columns(table = ''): string {
  const t = table === '' ? '' : `${table}.`;
  return `${t}id::text, ${t}parent_id::text AS "parentId", ${t}conversation_id::text AS "conversationId", ${t}title, ${t}goal, ${t}done_criteria AS "doneCriteria",
  ${t}status, ${t}label, ${t}clearance, ${t}effective_label AS "effectiveLabel", ${t}assignee, ${t}limits, ${t}evidence,
  ${t}waiting_reason AS "waitingReason", ${t}waiting_approval_id::text AS "waitingApprovalId", ${t}note, ${t}project, ${t}due_at AS "dueAt", ${t}priority, ${t}planned_on::text AS "plannedOn", ${t}created_at AS "createdAt", ${t}updated_at AS "updatedAt"`;
}
const COLUMNS = columns();

/** Creates a task and its `task.created` event. Titles may be L2: events carry the id only. */
export async function createTask(sql: Queryable, task: NewTask): Promise<Task> {
  parseLimits(task.limits ?? {});
  const [row] = await sql<Task[]>`
    INSERT INTO tasks (
      title, goal, done_criteria, parent_id, conversation_id, label, clearance, effective_label, assignee, limits, status, project, due_at
    )
    VALUES (
      ${task.title}, ${task.goal ?? null}, ${task.doneCriteria ?? null}, ${task.parentId ?? null}, ${task.conversationId ?? null},
      ${task.label ?? 'L2'}::privacy_label, ${task.clearance ?? 'L2'}::privacy_label,
      ${task.effectiveLabel ?? 'L0'}::privacy_label, ${task.assignee ?? 'user'},
      ${sql.json(task.limits ?? {})}, ${task.status ?? 'inbox'}::task_status, ${task.project ?? null}, ${task.dueAt ?? null}
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

/**
 * Why a task moved, for the event log; the free-text reason stays in `tasks`.
 * `superseded`: a wait closed because the user wrote again in its conversation (D-109).
 * `incognito`: its incognito conversation closed (D-136): the work stops for good.
 */
export type MoveCause = 'user' | 'engine' | 'limit' | 'approval' | 'executor' | 'error' | 'agent' | 'superseded' | 'incognito';

export interface MoveOptions {
  /** Required for `waiting_user`: the one line the user reads. Stored in the task, not in events. */
  reason?: string;
  cause?: MoveCause;
  /** With `waiting_user`: the approval whose decision resumes the task. */
  approvalId?: string;
  /** Replaces the evidence (diff, test, document references). */
  evidence?: Json[];
  /** The statuses it may move from, instead of task-status.ts: the user's moves on the wall (cardwall.ts). */
  from?: readonly TaskStatus[];
}

/**
 * Moves a task to `to`, only from a status allowed by task-status.ts, and
 * writes `task.status`. Run it inside a transaction with the work it records.
 */
export async function moveTask(sql: Queryable, id: string, to: TaskStatus, options: MoveOptions = {}): Promise<Task> {
  if (to === 'waiting_user' && (options.reason === undefined || options.reason.trim() === '')) {
    throw new TaskError('waiting_user needs a reason');
  }
  const from = options.from ?? movesInto(to);
  const evidence = options.evidence === undefined ? null : sql.json(options.evidence);
  const [row] = await sql<(Task & { previous: TaskStatus })[]>`
    UPDATE tasks t SET
      status = ${to}::task_status,
      waiting_reason = ${to === 'waiting_user' ? (options.reason ?? null) : null},
      waiting_approval_id = ${to === 'waiting_user' ? (options.approvalId ?? null) : null}::uuid,
      evidence = COALESCE(${evidence}::jsonb, t.evidence),
      updated_at = now()
    FROM (SELECT id, status AS previous FROM tasks WHERE id = ${id} FOR UPDATE) old
    WHERE t.id = old.id AND old.previous::text = ANY(${sql.array([...from])})
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
  if (to === 'done') {
    const waiting = await sql<{ id: string }[]>`
      SELECT DISTINCT task_id::text AS id FROM task_dependencies WHERE depends_on = ${id} AND removed_at IS NULL`;
    await releaseIfFree(sql, waiting.map((row) => row.id));
  }
  return task;
}

/**
 * How many dependencies of `id` are not done yet (D-152): while any is, the
 * task does not start. `lock` holds them until the transaction ends, so that
 * one moving to done waits and then finds the step held back.
 */
export async function openDependencies(sql: Queryable, id: string, lock = false): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    SELECT t.id::text FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on
    WHERE d.task_id = ${id} AND d.removed_at IS NULL AND t.status <> 'done'
    ${lock ? sql`FOR SHARE OF t` : sql``}`;
  return rows.length;
}

/**
 * Queues again the step the engine held back (`task.blocked`) of each of
 * `ids` that is still ready and has no dependency left to wait for (D-152).
 * A card nobody started is not started here: only a held step goes on.
 */
export async function releaseIfFree(sql: Queryable, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  // Locked first, in a statement of its own: two dependencies done at once
  // take turns here, and the second one reads the first one done.
  await sql`SELECT id FROM tasks WHERE id = ANY (${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  const free = await sql<{ id: string }[]>`
    SELECT t.id::text FROM tasks t
    WHERE t.id = ANY (${ids}::uuid[]) AND t.status = 'ready'
      AND NOT EXISTS (
        SELECT FROM task_dependencies d JOIN tasks u ON u.id = d.depends_on
        WHERE d.task_id = t.id AND d.removed_at IS NULL AND u.status <> 'done')
      AND (SELECT e.kind FROM events e WHERE e.task_id = t.id AND e.kind IN ('task.blocked', 'task.unblocked')
           ORDER BY e.id DESC LIMIT 1) = 'task.blocked'`;
  const released: string[] = [];
  for (const { id } of free) {
    // A step already queued is not queued twice, and then nothing was released.
    if ((await enqueueJob(sql, STEP_QUEUE, { taskId: id }, { key: `task:${id}` })) === undefined) continue;
    await appendEvent(sql, { kind: 'task.unblocked', taskId: id, label: 'L0', payload: {} });
    released.push(id);
  }
  return released;
}

/** Whether a step of `id` was held back for a dependency and not queued again yet (releaseIfFree). */
export async function isHeld(sql: Queryable, id: string): Promise<boolean> {
  const [row] = await sql<{ kind: string | null }[]>`
    SELECT (SELECT kind FROM events WHERE task_id = ${id} AND kind IN ('task.blocked', 'task.unblocked') ORDER BY id DESC LIMIT 1) AS kind`;
  return row?.kind === 'task.blocked';
}

/** Replaces the caps of a task (the user raising them from "Attende te"). */
export async function setTaskLimits(sql: Queryable, id: string, limits: NonNullable<NewTask['limits']>): Promise<void> {
  parseLimits(limits);
  const rows = await sql`UPDATE tasks SET limits = ${sql.json(limits)}, updated_at = now() WHERE id = ${id} RETURNING id`;
  if (rows.length !== 1) throw new TaskError(`task ${id} does not exist`);
  await appendEvent(sql, { kind: 'task.limits', taskId: id, label: 'L0', payload: { ...limits } });
}
