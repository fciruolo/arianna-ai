import type { Label } from '@arianna/policy';

import type { Queryable } from './db/client.ts';
import { appendEvent } from './events.ts';
import type { TaskUsage } from './limits.ts';

export type RunStatus = 'running' | 'ok' | 'failed' | 'cancelled' | 'limit' | 'interrupted';

export interface Run {
  id: string;
  taskId: string;
  step: number;
  agent: string;
  executor: string;
  model: string | null;
  locality: 'local' | 'cloud';
  sessionRef: string | null;
  resumedFrom: string | null;
  status: RunStatus;
  stepsUsed: number;
  startedAt: Date;
  endedAt: Date | null;
}

export interface NewRun {
  taskId: string;
  step: number;
  agent: string;
  executor: string;
  model?: string;
  locality: 'local' | 'cloud';
  /** The task's effective label: the run works on what the task has read. */
  effectiveLabel: Label;
  resumedFrom?: string;
}

export interface RunUsage {
  /** Steps the executor took inside this run; default 1. */
  steps?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Euro beyond the subscriptions. */
  cost?: number;
}

const COLUMNS = `id::text, task_id::text AS "taskId", step, agent, executor, model, locality,
  session_ref AS "sessionRef", resumed_from::text AS "resumedFrom", status, steps_used AS "stepsUsed",
  started_at AS "startedAt", ended_at AS "endedAt"`;

export async function startRun(sql: Queryable, run: NewRun): Promise<Run> {
  const [row] = await sql.unsafe<Run[]>(
    `INSERT INTO runs (task_id, step, agent, executor, model, locality, effective_label, resumed_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7::privacy_label, $8)
     RETURNING ${COLUMNS}`,
    [run.taskId, run.step, run.agent, run.executor, run.model ?? null, run.locality, run.effectiveLabel, run.resumedFrom ?? null],
  );
  if (row === undefined) throw new Error('INSERT INTO runs returned no row');
  await appendEvent(sql, {
    kind: 'run.started',
    taskId: run.taskId,
    runId: row.id,
    agent: run.agent,
    label: 'L0',
    payload: { step: run.step, executor: run.executor, locality: run.locality, resumed: run.resumedFrom !== undefined },
  });
  return row;
}

/** The session id the binary returned, for `resume`. Never a credential. */
export async function setSessionRef(sql: Queryable, runId: string, sessionRef: string): Promise<void> {
  await sql`UPDATE runs SET session_ref = ${sessionRef} WHERE id = ${runId} AND status = 'running'`;
}

/** Usage as reported by an executor; throws on values that would switch a cap off. */
export function checkUsage(usage: RunUsage): RunUsage {
  const count = (value: number | undefined, name: string) => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`usage.${name} must be a whole number of at least 0`);
  };
  count(usage.steps, 'steps');
  count(usage.tokensIn, 'tokensIn');
  count(usage.tokensOut, 'tokensOut');
  if (usage.cost !== undefined && (!Number.isFinite(usage.cost) || usage.cost < 0)) {
    throw new TypeError('usage.cost must be a finite number of at least 0');
  }
  return usage;
}

/**
 * Closes a running run with its usage. False if it was not running any more.
 * A run that ended `ok` counts at least one step, whatever the executor says.
 */
export async function endRun(sql: Queryable, runId: string, status: Exclude<RunStatus, 'running'>, usage: RunUsage = {}): Promise<boolean> {
  checkUsage(usage);
  const steps = status === 'ok' ? Math.max(1, usage.steps ?? 1) : (usage.steps ?? 1);
  const rows = await sql<{ taskId: string; agent: string; step: number }[]>`
    UPDATE runs SET
      status = ${status}, ended_at = now(),
      steps_used = ${steps},
      tokens_in = ${usage.tokensIn ?? null}, tokens_out = ${usage.tokensOut ?? null},
      cost_estimate = ${usage.cost ?? 0}
    WHERE id = ${runId} AND status = 'running'
    RETURNING task_id::text AS "taskId", agent, step`;
  const row = rows[0];
  if (row === undefined) return false;
  await appendEvent(sql, {
    kind: 'run.ended',
    taskId: row.taskId,
    runId,
    agent: row.agent,
    label: 'L0',
    payload: { step: row.step, status, steps, cost: usage.cost ?? 0 },
  });
  return true;
}

/** Heartbeat of the run in progress (see `last_seen_at`). */
export async function touchRuns(sql: Queryable, taskId: string): Promise<void> {
  await sql`UPDATE runs SET last_seen_at = now() WHERE task_id = ${taskId} AND status = 'running'`;
}

/**
 * Runs left `running` by a worker that died: marked `interrupted`, ended at
 * their last heartbeat (the time the core was down is not work), no steps
 * counted.
 */
export async function interruptRunning(sql: Queryable, taskId: string): Promise<Run[]> {
  const rows = await sql.unsafe<Run[]>(
    `UPDATE runs SET status = 'interrupted', ended_at = greatest(last_seen_at, started_at), steps_used = 0
     WHERE task_id = $1 AND status = 'running'
     RETURNING ${COLUMNS}`,
    [taskId],
  );
  for (const run of rows) {
    await appendEvent(sql, { kind: 'run.interrupted', taskId, runId: run.id, agent: run.agent, label: 'L0', payload: { step: run.step } });
  }
  return [...rows];
}

/**
 * The run to resume for `step`: its latest run, when that was interrupted
 * (by a crash, a shutdown or a lost lock). Undefined otherwise.
 */
export async function resumableRun(sql: Queryable, taskId: string, step: number): Promise<Run | undefined> {
  const [row] = await sql.unsafe<Run[]>(
    `SELECT ${COLUMNS} FROM runs WHERE task_id = $1 AND step = $2 ORDER BY started_at DESC, id DESC LIMIT 1`,
    [taskId, step],
  );
  return row?.status === 'interrupted' ? row : undefined;
}

/** The next step number: one past the last step that ended `ok`. */
export async function nextStep(sql: Queryable, taskId: string): Promise<number> {
  const [row] = await sql<{ step: number }[]>`
    SELECT COALESCE(max(step), 0)::int + 1 AS step FROM runs WHERE task_id = ${taskId} AND status = 'ok'`;
  return row?.step ?? 1;
}

/** What the task's runs have used so far, for the caps. Running runs count their time. */
export async function taskUsage(sql: Queryable, taskId: string): Promise<TaskUsage> {
  const [row] = await sql<{ steps: number; minutes: number; cost: string }[]>`
    SELECT
      COALESCE(sum(steps_used), 0)::int AS steps,
      COALESCE(sum(extract(epoch FROM COALESCE(ended_at, now()) - started_at)), 0)::float8 / 60 AS minutes,
      COALESCE(sum(cost_estimate), 0)::text AS cost
    FROM runs WHERE task_id = ${taskId}`;
  return { steps: row?.steps ?? 0, minutes: row?.minutes ?? 0, cost: Number(row?.cost ?? 0) };
}
