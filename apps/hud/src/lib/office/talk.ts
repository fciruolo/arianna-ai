import type { Conversation, Label, RecentDelegation } from '../types.ts';

/**
 * "E · Parla con …" (D-106): which conversation of the chat opens. The
 * conversation an agent works on (a running delegation of the Coder);
 * otherwise, for Arianna, her most recent private conversation; for the
 * Coder (the user's choice, 2026-10-05) and when nothing else fits, a new
 * draft, as "Nuovo" (D-108): the conversation is born with its first message.
 * Only conversations of the list up to L2: one above is never named here.
 * This stays outside the canvas: the canvas never sees a conversation id.
 */
export type TalkTarget = { kind: 'conversation'; id: string } | { kind: 'draft'; mode: 'private' | 'work'; project?: string };

/** A running delegation reduced to who, where and in which conversation: never its title or brief. */
export interface RunningWork {
  agent: string;
  conversationId: string;
  repo: string | null;
}

export function runningWork(rows: readonly RecentDelegation[]): RunningWork[] {
  return rows
    .filter((row) => row.status === 'running' && row.conversationId !== null)
    .map((row) => ({ agent: row.agent, conversationId: row.conversationId ?? '', repo: row.repo }));
}

const VISIBLE: readonly Label[] = ['L0', 'L1', 'L2'];

type ConversationRef = Pick<Conversation, 'id' | 'mode' | 'origin' | 'archivedAt' | 'lastMessageAt' | 'createdAt' | 'effectiveLabel'>;

function when(conversation: ConversationRef): number {
  const time = Date.parse(conversation.lastMessageAt ?? conversation.createdAt);
  return Number.isNaN(time) ? 0 : time;
}

export function talkTarget(agent: string, work: readonly RunningWork[], conversations: readonly ConversationRef[], project?: string): TalkTarget {
  const usable = conversations.filter((item) => item.archivedAt === null && item.origin === 'user' && VISIBLE.includes(item.effectiveLabel));
  const known = new Set(usable.map((item) => item.id));
  const running = work.find((item) => item.agent === agent && known.has(item.conversationId));
  if (running !== undefined) return { kind: 'conversation', id: running.conversationId };
  if (agent === 'arianna') {
    const latest = usable.filter((item) => item.mode === 'private').sort((a, b) => when(b) - when(a))[0];
    return latest === undefined ? { kind: 'draft', mode: 'private' } : { kind: 'conversation', id: latest.id };
  }
  return project === undefined ? { kind: 'draft', mode: 'work' } : { kind: 'draft', mode: 'work', project };
}
