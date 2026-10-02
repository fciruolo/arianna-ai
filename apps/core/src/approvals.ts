import { declassifyRequest, labelOrDefault, type DeclassifyApproval, type Label, type Labeled } from '@arianna/policy';

import type { Queryable } from './db/client.ts';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';
export type DecisionChannel = 'web' | 'telegram' | 'phone';

export interface StoredApproval extends DeclassifyApproval {
  taskId: string | null;
  action: string;
  detail: Record<string, unknown>;
  /** Label of the detail: a channel shows the detail only if it may receive this label. */
  label: Label;
  state: ApprovalState;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedVia: DecisionChannel | null;
}

const COLUMNS = `id::text, task_id::text AS "taskId", kind, action, detail, label, state,
  requested_at AS "requestedAt", decided_at AS "decidedAt", decided_via AS "decidedVia"`;

/**
 * Asks the user to approve lowering `item` to `to`. The approval stores the
 * exact text, shown on the approval card, and its sha256: approving it covers
 * that text only. The database is local, so the text may be L2 here; it never
 * goes into events or the gateway log.
 */
export async function requestDeclassify(
  sql: Queryable,
  item: Labeled<unknown>,
  to: Label,
  options: { taskId?: string } = {},
): Promise<StoredApproval> {
  const detail = declassifyRequest(item, to);
  const [row] = await sql<StoredApproval[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (
      ${options.taskId ?? null}, 'declassify', 'declassify', ${sql.json(detail)},
      ${labelOrDefault(item.label)}::privacy_label
    )
    RETURNING ${sql.unsafe(COLUMNS)}`;
  if (row === undefined) throw new Error('INSERT INTO approvals returned no row');
  return row;
}

/**
 * Approvals in one state: pending ones oldest first (the queue to work
 * through), decided or expired ones most recently decided first.
 */
export async function listApprovals(sql: Queryable, state: ApprovalState, limit = 100): Promise<StoredApproval[]> {
  const order = state === 'pending' ? 'requested_at, id' : 'decided_at DESC, id';
  const rows = await sql.unsafe<StoredApproval[]>(
    `SELECT ${COLUMNS} FROM approvals WHERE state = $1 ORDER BY ${order} LIMIT $2`,
    [state, limit],
  );
  return [...rows];
}

export async function loadApproval(sql: Queryable, id: string): Promise<StoredApproval | undefined> {
  const [row] = await sql.unsafe<StoredApproval[]>(`SELECT ${COLUMNS} FROM approvals WHERE id = $1`, [id]);
  return row;
}

/** Records the user's decision. An approval is decided once: a second decision throws. */
export async function decideApproval(
  sql: Queryable,
  id: string,
  state: 'approved' | 'rejected',
  via: DecisionChannel,
): Promise<StoredApproval> {
  const [row] = await sql.unsafe<StoredApproval[]>(
    `UPDATE approvals SET state = $2, decided_at = now(), decided_via = $3
     WHERE id = $1 AND state = 'pending'
     RETURNING ${COLUMNS}`,
    [id, state, via],
  );
  if (row === undefined) throw new Error(`approval ${id} does not exist or is already decided`);
  return row;
}
