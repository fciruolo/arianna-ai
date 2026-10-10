import { approvalAnchor, messageAnchor } from './chat-focus.ts';
import {
  PENDING_APPROVAL_ELSEWHERE,
  PENDING_KIND_TEXT,
  PENDING_NO_CONVERSATION,
  PENDING_UNTITLED,
  pendingAskText,
  pendingKind,
  pendingKindText,
  stoppedText,
  type PendingKind,
} from './pending-text.ts';
import type { Approval, Label, Task } from './types.ts';

/** A task waiting for the user, as GET /api/tasks/waiting lists it (D-091): up to L2 only. */
export interface WaitingTask {
  id: string;
  conversationId: string | null;
  /** Its conversation is incognito (D-136): shown only in that conversation's page, never in "Decisioni in attesa". Optional: an older core sends none. */
  incognito?: boolean | null;
  conversationTitle: string | null;
  mode: string | null;
  archived: boolean;
  title: string;
  /** ISO time the wait started. */
  since: string;
  reason: 'question' | 'approval' | 'other';
  /** Arianna's question, at most 200 characters; null for the other reasons. */
  question: string | null;
  approvalId: string | null;
  /** The question, or the user's message that started the task. */
  messageId: string | null;
  waitingReason: string;
  label: Label;
}

/** One thing that waits for the user in the "Decisioni in attesa" window (D-091). */
export interface PendingItem {
  key: string;
  kind: PendingKind;
  kindText: string;
  /** null when the approval has no task, or its task no conversation: then it cannot be opened. */
  conversationId: string | null;
  conversationTitle: string;
  archived: boolean;
  ask: string;
  /** ISO time the wait started. */
  since: string;
  approvalId: string | null;
  /** The element the chat scrolls to (chat-focus.ts), or null. */
  anchor: string | null;
  /** The task "Chiudi" closes (D-109); null for an approval without a task, which is decided in its card. */
  taskId: string | null;
  /** How "Chiudi" works on this row (D-109). */
  dismiss: DismissMode;
}

/**
 * "Chiudi" on a row of "Decisioni in attesa" (D-109): `none` without a task;
 * `confirm` when an approval waits too (a second click, "Sicuro?", lets it
 * expire); `direct` for a plain wait.
 */
export type DismissMode = 'none' | 'direct' | 'confirm';

export function dismissMode(taskId: string | null, approvalId: string | null): DismissMode {
  if (taskId === null) return 'none';
  return approvalId === null ? 'direct' : 'confirm';
}

/** What a click on "Chiudi" does: the first click on a `confirm` row only arms it; the second, or any on a `direct` row, closes. */
export function dismissStep(mode: DismissMode, armed: boolean): 'ignore' | 'arm' | 'close' {
  if (mode === 'none') return 'ignore';
  if (mode === 'confirm' && !armed) return 'arm';
  return 'close';
}

function titleOf(conversationId: string | null, title: string | null | undefined): string {
  if (conversationId === null) return PENDING_NO_CONVERSATION;
  const named = title?.trim();
  return named === undefined || named === '' ? PENDING_UNTITLED : named;
}

/**
 * Pending approvals and waiting tasks as rows, oldest first. `tasks` maps
 * task ids to their task (loaded for the approvals whose task is not among
 * the waiting ones), `titles` conversation ids to their title (null: no
 * title yet; missing: not readable). A waiting task behind a listed approval
 * is the approval's row, never a second one.
 */
export function pendingItems(
  approvals: readonly Approval[],
  tasks: Readonly<Record<string, Pick<Task, 'conversationId'>>>,
  titles: Readonly<Record<string, string | null>>,
  waiting: readonly WaitingTask[] = [],
): PendingItem[] {
  const pending = approvals.filter((approval) => approval.state === 'pending');
  const waitingById = new Map(waiting.map((task) => [task.id, task]));
  const rows = pending.map((approval): PendingItem => {
    const behind = approval.taskId === null ? undefined : waitingById.get(approval.taskId);
    // The choice of a card from a plan opens the plan's conversation (D-159): the core says which.
    const placed = typeof approval.conversationId === 'string' ? approval.conversationId : undefined;
    const conversationId = placed ?? (behind !== undefined ? behind.conversationId : approval.taskId === null ? null : (tasks[approval.taskId]?.conversationId ?? null));
    const title = behind !== undefined ? behind.conversationTitle : conversationId === null ? null : titles[conversationId];
    return {
      key: `approval-${approval.id}`,
      kind: pendingKind(approval),
      kindText: pendingKindText(approval),
      conversationId,
      conversationTitle: titleOf(conversationId, title),
      archived: behind?.archived ?? false,
      ask: pendingAskText(approval),
      since: approval.requestedAt,
      approvalId: approval.id,
      anchor: conversationId === null ? null : approvalAnchor(approval.id),
      taskId: approval.taskId,
      dismiss: dismissMode(approval.taskId, approval.id),
    };
  });
  const listedApprovals = new Set(pending.map((approval) => approval.id));
  const tasksWithApproval = new Set(pending.map((approval) => approval.taskId).filter((id): id is string => id !== null));
  for (const task of waiting) {
    if (tasksWithApproval.has(task.id) || (task.approvalId !== null && listedApprovals.has(task.approvalId))) continue;
    const kind: PendingKind = task.reason === 'question' ? 'question' : task.reason === 'approval' ? 'action' : 'stopped';
    const ask = task.reason === 'question' ? (task.question ?? '') : task.reason === 'approval' ? PENDING_APPROVAL_ELSEWHERE : stoppedText(task.waitingReason);
    const anchor =
      task.conversationId === null
        ? null
        : task.approvalId !== null
          ? approvalAnchor(task.approvalId)
          : task.messageId !== null
            ? messageAnchor(task.messageId)
            : null;
    rows.push({
      key: `task-${task.id}`,
      kind,
      kindText: PENDING_KIND_TEXT[kind],
      conversationId: task.conversationId,
      conversationTitle: titleOf(task.conversationId, task.conversationTitle),
      archived: task.archived,
      ask,
      since: task.since,
      approvalId: task.approvalId,
      anchor,
      taskId: task.id,
      dismiss: dismissMode(task.id, task.approvalId),
    });
  }
  return sortOldestFirst(rows);
}

/** Oldest first; a bad date goes last; ties keep their order. */
export function sortOldestFirst<T extends { since: string }>(rows: readonly T[]): T[] {
  const time = (row: T): number => {
    const parsed = Date.parse(row.since);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => time(a.row) - time(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

/** The number on the row of the status panel and in the window: every row, plus the tasks above L2 only counted. */
export function pendingTotal(items: readonly PendingItem[], hidden: number): number {
  return items.length + Math.max(0, hidden);
}
