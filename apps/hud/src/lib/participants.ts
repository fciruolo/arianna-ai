import { agentName } from './italian.ts';
import { EXECUTOR_TEXT } from './labels.ts';
import type { AgentStatus, Message, Participant } from './types.ts';
import type { Pose } from './sprites.ts';

/**
 * The agents in the conversation as colleagues (D-125): the participant bar
 * in the head of the chat, and the lines of the system that tell who joined
 * and who left.
 */

/**
 * A line of the system about the work of a task ("Arianna aggiunge Coder…",
 * "Coder è stato aggiunto", "Hai tolto…", "Attesa chiusa"): a system message
 * with its task, shown as an event of the chat, small and centred, not as a
 * message. A system message without a task (a system chat, D-064) stays a message.
 */
export function isEventLine(message: Pick<Message, 'role' | 'taskId'>): boolean {
  return message.role === 'system' && message.taskId !== null;
}

/**
 * The line that says why Arianna brings an agent in ("Arianna aggiunge
 * traduttore: …", written by the core in `addingLine`): a little more in view
 * than the other events (user's request, 2026-10-05).
 */
export function isAddingLine(message: Pick<Message, 'role' | 'taskId' | 'body'>): boolean {
  return isEventLine(message) && message.body.startsWith('Arianna aggiunge ');
}

/** Where the agent works, as the bar writes it under its name. */
export function executorText(participant: Pick<Participant, 'executor'>): string {
  if (participant.executor === null) return 'non più attivo';
  return EXECUTOR_TEXT[participant.executor] ?? participant.executor;
}

/** What the button that takes the agent out says to a screen reader and on hover. */
export function removeText(participant: Pick<Participant, 'agent'>): string {
  return `Togli ${agentName(participant.agent)} dalla conversazione`;
}

/** The list without `agent`: the bar updates at the click, the live feed confirms it. */
export function withoutParticipant(participants: readonly Participant[], agent: string): Participant[] {
  return participants.filter((participant) => participant.agent !== agent);
}

/** The pose of a participant in the bar: at work while the core says it works, otherwise still. */
export function participantPose(agent: string, agents: readonly Pick<AgentStatus, 'id' | 'state'>[] | undefined): Pose {
  const state = agents?.find((item) => item.id === agent)?.state;
  return state === 'working' ? 'working' : state === 'thinking' ? 'thinking' : 'idle';
}
