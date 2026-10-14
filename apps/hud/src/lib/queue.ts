/**
 * «Ferma» and the queue of messages in the chat (D-218, idea 4 of OpenWork,
 * D-093): what the page derives from the tasks and the messages it has.
 */
import type { Message, QueueView, Task } from './types.ts';

/** The line the core writes under a task the user stopped (STOPPED_TEXT of apps/core/src/chat-stop.ts). */
export const STOPPED_TEXT = 'Fermato da te.';

/** An answer of the conversation is at work: "Ferma" shows, a new message waits in the queue. */
export function isWorking(tasks: Record<string, Pick<Task, 'status'>>): boolean {
  return Object.values(tasks).some((task) => task.status === 'ready' || task.status === 'running');
}

/**
 * The failed tasks the user stopped with "Ferma": they read "fermato", not
 * "fallito". The line and the failure come in one transaction, so they share
 * the time; a task retried since then moved later, and a new failure is its own.
 */
export function stoppedTasks(
  messages: readonly Pick<Message, 'role' | 'body' | 'taskId' | 'ts'>[],
  tasks: Record<string, Pick<Task, 'status' | 'updatedAt'>>,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'system' || message.body !== STOPPED_TEXT || message.taskId === null) continue;
    const task = tasks[message.taskId];
    if (task?.status === 'failed' && (task.updatedAt === undefined || Date.parse(message.ts) >= Date.parse(task.updatedAt))) ids.add(message.taskId);
  }
  return ids;
}

/** Why the queued messages are still there, in one line above them. */
export function queueHint(queue: Pick<QueueView, 'paused'>, working: boolean, waitingDecision: boolean): string {
  if (queue.paused) return 'In pausa dopo «Ferma»: nessuno parte da solo.';
  if (waitingDecision) return 'Partono quando avrai deciso la richiesta qui sopra.';
  if (working) return 'Partono uno alla volta, appena finisce la risposta in corso.';
  return 'Partono fra un istante.';
}
