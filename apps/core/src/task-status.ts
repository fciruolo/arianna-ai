/**
 * Cardwall columns (docs/SPEC.md) and the moves between them. Pure: the
 * database update in tasks.ts applies a move only from an allowed status.
 */
export const TASK_STATUSES = ['inbox', 'ready', 'running', 'waiting_user', 'to_verify', 'done', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  inbox: ['ready', 'waiting_user', 'failed'],
  ready: ['running', 'waiting_user', 'failed'],
  // `running` → `running` is a further step of the same task.
  running: ['running', 'waiting_user', 'to_verify', 'failed'],
  waiting_user: ['ready', 'failed', 'done'],
  to_verify: ['done', 'ready', 'failed'],
  done: [],
  // The user may retry a failed task.
  failed: ['ready'],
};

export function canMove(from: TaskStatus, to: TaskStatus): boolean {
  return MOVES[from].includes(to);
}

/** Statuses a task may be in to move to `to`. */
export function movesInto(to: TaskStatus): TaskStatus[] {
  return TASK_STATUSES.filter((from) => canMove(from, to));
}
