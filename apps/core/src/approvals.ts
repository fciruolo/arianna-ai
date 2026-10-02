import { declassifyRequest, type DeclassifyApproval, type Label, type Labeled } from '@arianna/policy';

import type { Queryable, Sql } from './db/client.ts';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';
export type DecisionChannel = 'web' | 'telegram' | 'phone';

export interface StoredApproval extends DeclassifyApproval {
  taskId: string | null;
  action: string;
  detail: Record<string, unknown>;
  state: ApprovalState;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedVia: DecisionChannel | null;
}

const COLUMNS = `id::text, task_id::text AS "taskId", kind, action, detail, state,
  requested_at AS "requestedAt", decided_at AS "decidedAt", decided_via AS "decidedVia"`;

/**
 * Asks the user to approve lowering `item` to `to`. The approval stores the
 * exact text, shown on the approval card, and its sha256: approving it covers
 * that text only. The database is local, so the text may be L2 here; it never
 * goes into events or the gateway log.
 */
export async function requestDeclassify(
  sql: Sql,
  item: Labeled<unknown>,
  to: Label,
  options: { taskId?: string } = {},
): Promise<StoredApproval> {
  const detail = declassifyRequest(item, to);
  const [row] = await sql<StoredApproval[]>`
    INSERT INTO approvals (task_id, kind, action, detail)
    VALUES (${options.taskId ?? null}, 'declassify', 'declassify', ${sql.json(detail)})
    RETURNING ${sql.unsafe(COLUMNS)}`;
  if (row === undefined) throw new Error('INSERT INTO approvals returned no row');
  return row;
}

export async function loadApproval(sql: Queryable, id: string): Promise<StoredApproval | undefined> {
  const [row] = await sql.unsafe<StoredApproval[]>(`SELECT ${COLUMNS} FROM approvals WHERE id = $1`, [id]);
  return row;
}

/** Records the user's decision. An approval is decided once: a second decision throws. */
export async function decideApproval(
  sql: Sql,
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
