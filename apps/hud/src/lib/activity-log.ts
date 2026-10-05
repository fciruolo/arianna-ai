import type { Message, Task, TaskStatus } from './types.ts';

/**
 * The saved activity lines under a finished task (D-083): pure logic of the
 * chat, tested without a browser. While the task is queued or running the
 * live card shows its lines (D-054); once it is settled, the last message of
 * the task gets a small "Mostra i passi (N)" button. The texts are in
 * italian.ts.
 */

/** A task in these states shows its live lines instead of the saved ones. */
const AT_WORK: readonly TaskStatus[] = ['inbox', 'ready', 'running'];

/** Where the button goes: the message id, with its task and the number of saved lines. */
export interface StepsAnchor {
  taskId: string;
  count: number;
}

/**
 * For each settled task with saved lines, the message that carries the
 * button: its last answer (Arianna's, the Coder's report or a system note),
 * or the user's message when the task wrote no answer (a failure). A task
 * whose status is unknown yet is left out, as one at work.
 */
export function stepsAnchors(
  messages: readonly Message[],
  tasks: Readonly<Record<string, Task | undefined>>,
  counts: Readonly<Record<string, number>>,
): Map<string, StepsAnchor> {
  const answer = new Map<string, string>();
  const question = new Map<string, string>();
  for (const message of messages) {
    if (message.taskId === null) continue;
    if (message.role === 'user') {
      if (!question.has(message.taskId)) question.set(message.taskId, message.id);
    } else {
      answer.set(message.taskId, message.id);
    }
  }
  const anchors = new Map<string, StepsAnchor>();
  for (const [taskId, count] of Object.entries(counts)) {
    const status = tasks[taskId]?.status;
    if (count <= 0 || status === undefined || AT_WORK.includes(status)) continue;
    const messageId = answer.get(taskId) ?? question.get(taskId);
    if (messageId !== undefined) anchors.set(messageId, { taskId, count });
  }
  return anchors;
}
