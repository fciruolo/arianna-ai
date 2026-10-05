import type { FileChange } from '@arianna/executors';
import type { Label } from '@arianna/policy';

import type { Queryable } from '../db/client.ts';

/**
 * A step the orchestrator handed to another agent (task_delegations,
 * migration 0009, D-055). Written when the model calls `task.delegate`,
 * updated by the cloud step that runs it; its outcome is what the next local
 * step reads as the tool result of that call.
 */
export type DelegationStatus = 'pending' | 'running' | 'ok' | 'failed' | 'refused';

export interface Delegation {
  id: string;
  taskId: string;
  /** The orchestrator step whose call delegated. */
  step: number;
  agent: string;
  brief: string;
  /** Label of the brief: as written, or lowered by an approved declassification. */
  label: Label;
  repo: string | null;
  status: DelegationStatus;
  executor: string | null;
  model: string | null;
  runId: string | null;
  /** The run whose folder in data/worktrees is the workspace. */
  workspaceRun: string | null;
  sessionRef: string | null;
  result: string | null;
  resultLabel: Label | null;
  messageId: string | null;
  /**
   * The files the run left changed in the project (D-082, migration 0020):
   * paths and kinds only. Null when not recorded, [] when nothing changed.
   */
  files: FileChange[] | null;
  /** HEAD of the project when the files were listed (D-117, migration 0024); null without commits or not recorded. */
  baseCommit: string | null;
}

export interface NewDelegation {
  taskId: string;
  step: number;
  agent: string;
  brief: string;
  label: Label;
  repo?: string;
}

export interface DelegationPatch {
  status?: DelegationStatus;
  label?: Label;
  executor?: string;
  model?: string;
  runId?: string;
  workspaceRun?: string;
  sessionRef?: string;
  /** Ends the delegation: `status` must be ok, failed or refused. */
  result?: string;
  resultLabel?: Label;
  messageId?: string;
  /** Written once (database guard): the changes of the run, from `repositoryChanges`. */
  files?: readonly FileChange[];
  /** Only together with `files` (database guard): the commit they are compared against. */
  baseCommit?: string;
}

const COLUMNS = `id::text, task_id::text AS "taskId", step, agent, brief, label, repo, status, executor, model,
  run_id::text AS "runId", workspace_run::text AS "workspaceRun", session_ref AS "sessionRef", result,
  result_label AS "resultLabel", message_id::text AS "messageId", files, base_commit AS "baseCommit"`;

export async function createDelegation(sql: Queryable, delegation: NewDelegation): Promise<Delegation> {
  const [row] = await sql.unsafe<Delegation[]>(
    `INSERT INTO task_delegations (task_id, step, agent, brief, label, repo)
     VALUES ($1, $2, $3, $4, $5::privacy_label, $6)
     RETURNING ${COLUMNS}`,
    [delegation.taskId, delegation.step, delegation.agent, delegation.brief, delegation.label, delegation.repo ?? null],
  );
  if (row === undefined) throw new Error('INSERT INTO task_delegations returned no row');
  return row;
}

export async function loadDelegations(sql: Queryable, taskId: string): Promise<Delegation[]> {
  const rows = await sql.unsafe<Delegation[]>(`SELECT ${COLUMNS} FROM task_delegations WHERE task_id = $1 ORDER BY step`, [taskId]);
  return [...rows];
}

/** The delegation of a task that has not ended, if any: at most one, since the orchestrator waits for it. */
export async function openDelegation(sql: Queryable, taskId: string): Promise<Delegation | undefined> {
  const [row] = await sql.unsafe<Delegation[]>(
    `SELECT ${COLUMNS} FROM task_delegations WHERE task_id = $1 AND status IN ('pending', 'running') ORDER BY step DESC LIMIT 1`,
    [taskId],
  );
  return row;
}

/** Applies a patch; an ending status sets `ended_at`. The database guards what may change. */
export async function updateDelegation(sql: Queryable, id: string, patch: DelegationPatch): Promise<Delegation> {
  const ended = patch.status !== undefined && patch.status !== 'pending' && patch.status !== 'running';
  const [row] = await sql.unsafe<Delegation[]>(
    `UPDATE task_delegations SET
       status = coalesce($2, status),
       label = coalesce($3::privacy_label, label),
       executor = coalesce($4, executor),
       model = coalesce($5, model),
       run_id = coalesce($6::uuid, run_id),
       workspace_run = coalesce($7::uuid, workspace_run),
       session_ref = coalesce($8, session_ref),
       result = coalesce($9, result),
       result_label = coalesce($10::privacy_label, result_label),
       message_id = coalesce($11::bigint, message_id),
       files = coalesce($13::text::jsonb, files),
       base_commit = coalesce($14, base_commit),
       ended_at = CASE WHEN $12 THEN now() ELSE ended_at END
     WHERE id = $1::bigint
     RETURNING ${COLUMNS}`,
    [
      id,
      patch.status ?? null,
      patch.label ?? null,
      patch.executor ?? null,
      patch.model ?? null,
      patch.runId ?? null,
      patch.workspaceRun ?? null,
      patch.sessionRef ?? null,
      patch.result ?? null,
      patch.resultLabel ?? null,
      patch.messageId ?? null,
      ended,
      patch.files === undefined ? null : JSON.stringify(patch.files),
      patch.baseCommit ?? null,
    ],
  );
  if (row === undefined) throw new Error(`delegation ${id} does not exist`);
  return row;
}
