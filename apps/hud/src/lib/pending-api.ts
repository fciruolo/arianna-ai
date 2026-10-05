import { ApiError, listPendingApprovals, loadConversation, loadTask } from './api.ts';
import type { WaitingTask } from './pending.ts';
import type { Approval, Task } from './types.ts';

/**
 * What the "Decisioni in attesa" window reads (D-091): pending approvals, the
 * tasks waiting for the user (up to L2, the others only counted in `hidden`),
 * and, for an approval whose task is not among them, its task and the title
 * of its conversation.
 */
export interface PendingData {
  approvals: Approval[];
  waiting: WaitingTask[];
  hidden: number;
  tasks: Record<string, Task>;
  titles: Record<string, string | null>;
}

/** GET /api/tasks/waiting, same origin, as api.ts reads the other routes. */
async function listWaitingTasks(): Promise<{ tasks: WaitingTask[]; hidden: number }> {
  const response = await fetch('/api/tasks/waiting', { method: 'GET', credentials: 'same-origin' });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`);
  return { tasks: Array.isArray(data.tasks) ? (data.tasks as WaitingTask[]) : [], hidden: typeof data.hidden === 'number' ? data.hidden : 0 };
}

export async function loadPending(): Promise<PendingData> {
  const [approvals, waiting] = await Promise.all([listPendingApprovals(), listWaitingTasks()]);
  const known = new Set(waiting.tasks.map((task) => task.id));
  const taskIds = [...new Set(approvals.map((approval) => approval.taskId).filter((id): id is string => id !== null && !known.has(id)))];
  const tasks: Record<string, Task> = {};
  await Promise.all(
    taskIds.map(async (id) => {
      try {
        tasks[id] = await loadTask(id);
      } catch {
        // A task that cannot be read leaves its approval without a conversation.
      }
    }),
  );
  const conversationIds = [...new Set(Object.values(tasks).map((task) => task.conversationId).filter((id): id is string => id !== null))];
  const titles: Record<string, string | null> = {};
  await Promise.all(
    conversationIds.map(async (id) => {
      try {
        titles[id] = (await loadConversation(id)).title;
      } catch {
        // Missing: shown as untitled.
      }
    }),
  );
  return { approvals, waiting: waiting.tasks, hidden: waiting.hidden, tasks, titles };
}
