import { declassifyRequest, labelOrDefault, type Context, type DeclassifyApproval, type Label, type Labeled } from '@arianna/policy';

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
  /** The conversation of its task; null for a task without one. */
  conversationId: string | null;
  /** Its task is in an incognito conversation (D-136): the chat shows it only in that conversation's page. */
  incognito: boolean;
  /**
   * The executor the user chose, on an approved approval of kind `executor` (D-159); how long a folder of the Mac
   * is allowed, on an approved approval of kind `mac` (D-314); null otherwise.
   */
  choice: ApprovalChoice | null;
  /**
   * The chat task an approval of kind `executor` shows under (D-159): the task
   * of the plan the card came from, whose conversation is `conversationId`;
   * for a plan of a card «Piano» (D-235), the chat task of «/progetta». Null
   * for every other approval, and for a card that came from no chat.
   */
  chatTaskId: string | null;
}

/** Where a card of an agent with `executor_choice: ask` runs (D-159): the column `approvals.choice`. */
export const EXECUTOR_CHOICES = ['claude', 'codex', 'local'] as const;
export type ExecutorChoice = (typeof EXECUTOR_CHOICES)[number];

/**
 * How long a folder of the Mac is allowed (D-314), on an approved card of kind `mac`: that call only, the whole
 * conversation, or always (the folder joins the permanent list of Impostazioni → Cartelle del Mac).
 */
export const MAC_CHOICES = ['once', 'conversation', 'always'] as const;
export type MacChoice = (typeof MAC_CHOICES)[number];
export type ApprovalChoice = ExecutorChoice | MacChoice;

export function isMacChoice(value: unknown): value is MacChoice {
  return (MAC_CHOICES as readonly unknown[]).includes(value);
}

/**
 * The chat task of a card's executor approval, or of the plan of a card
 * «Piano» (D-235): the card's parent, when the card has no conversation and
 * the parent has one.
 */
const CHAT_TASK = `(CASE WHEN approvals.kind IN ('executor', 'plan') THEN (SELECT p.id FROM tasks t JOIN tasks p ON p.id = t.parent_id
  WHERE t.id = approvals.task_id AND t.conversation_id IS NULL AND p.conversation_id IS NOT NULL) END)`;

const COLUMNS = `id::text, task_id::text AS "taskId", kind, action, detail, label, state,
  requested_at AS "requestedAt", decided_at AS "decidedAt", decided_via AS "decidedVia",
  coalesce((SELECT t.conversation_id FROM tasks t WHERE t.id = approvals.task_id),
    (SELECT t.conversation_id FROM tasks t WHERE t.id = ${CHAT_TASK}))::text AS "conversationId",
  coalesce((SELECT c.incognito FROM tasks t JOIN conversations c ON c.id = t.conversation_id WHERE t.id = coalesce(${CHAT_TASK}, approvals.task_id)), false) AS incognito,
  choice, ${CHAT_TASK}::text AS "chatTaskId"`;

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
  context: Context,
  options: { taskId?: string } = {},
): Promise<StoredApproval> {
  const detail = declassifyRequest(item, to, context);
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
 * through), decided or expired ones most recently decided first. With `incognito` and the conversation of each
 * (D-136: the chat shows one of an incognito conversation only in its page);
 * with `conversationId`, only those of that conversation.
 */
export async function listApprovals(sql: Queryable, state: ApprovalState, limit = 100, options: { conversationId?: string } = {}): Promise<StoredApproval[]> {
  const order = state === 'pending' ? 'requested_at, id' : 'decided_at DESC, id';
  // The executor approvals of the cards a plan of the conversation created go with it (D-159), and the plan of its «/progetta» (D-235).
  const where =
    options.conversationId === undefined
      ? ''
      : `AND (task_id IN (SELECT id FROM tasks WHERE conversation_id = $3::uuid)
          OR (kind IN ('executor', 'plan') AND task_id IN (SELECT t.id FROM tasks t JOIN tasks p ON p.id = t.parent_id WHERE t.conversation_id IS NULL AND p.conversation_id = $3::uuid)))`;
  const rows = await sql.unsafe<StoredApproval[]>(
    `SELECT ${COLUMNS} FROM approvals WHERE state = $1 ${where} ORDER BY ${order} LIMIT $2`,
    options.conversationId === undefined ? [state, limit] : [state, limit, options.conversationId],
  );
  return [...rows];
}

export async function loadApproval(sql: Queryable, id: string): Promise<StoredApproval | undefined> {
  const [row] = await sql.unsafe<StoredApproval[]>(`SELECT ${COLUMNS} FROM approvals WHERE id = $1`, [id]);
  return row;
}

/**
 * Records the user's decision. An approval is decided once: a second decision
 * throws. `choice`: the executor chosen on an approval of kind `executor`
 * (D-159), one of its `detail.options`; how long a folder of the Mac is
 * allowed on an approval of kind `mac` (D-314); required to approve one of
 * those, refused on any other approval and on a rejection (the database
 * checks it too).
 */
export async function decideApproval(
  sql: Queryable,
  id: string,
  state: 'approved' | 'rejected',
  via: DecisionChannel,
  choice?: ApprovalChoice,
): Promise<StoredApproval> {
  if (choice !== undefined || state === 'approved') {
    const current = await loadApproval(sql, id);
    if (current !== undefined && current.kind === 'executor' && state === 'approved') {
      const options = Array.isArray(current.detail.options) ? current.detail.options : [];
      if (choice === undefined || !options.includes(choice)) throw new ApprovalChoiceError('choose one of the executors the approval offers');
    } else if (current !== undefined && current.kind === 'mac' && state === 'approved') {
      if (!isMacChoice(choice)) throw new ApprovalChoiceError('choose once, conversation or always');
    } else if (choice !== undefined) {
      throw new ApprovalChoiceError('only an approved choice of executor or of a folder of the Mac carries a choice');
    }
  }
  const [row] = await sql.unsafe<StoredApproval[]>(
    `UPDATE approvals SET state = $2, decided_at = now(), decided_via = $3, choice = $4
     WHERE id = $1 AND state = 'pending'
     RETURNING ${COLUMNS}`,
    [id, state, via, choice ?? null],
  );
  if (row === undefined) throw new Error(`approval ${id} does not exist or is already decided`);
  return row;
}

/** A decision whose choice of executor does not fit the approval (D-159). */
export class ApprovalChoiceError extends Error {
  override name = 'ApprovalChoiceError';
}

/** A choice the decision route takes: an executor (D-159) or how long a folder of the Mac is allowed (D-314). */
export function isApprovalChoice(value: unknown): value is ApprovalChoice {
  return isExecutorChoice(value) || isMacChoice(value);
}

export function isExecutorChoice(value: unknown): value is ExecutorChoice {
  return (EXECUTOR_CHOICES as readonly unknown[]).includes(value);
}
