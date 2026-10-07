import type { Conversation } from './types.ts';

/**
 * Small decisions of the left bar (D-097), pure so that they are tested.
 */

/** The pinned conversations (latest pin on top, as the core sends them) and the others, order kept. */
export function splitPinned(conversations: readonly Conversation[]): { pinned: Conversation[]; others: Conversation[] } {
  const pinned = conversations.filter((conversation) => conversation.pinnedAt !== null);
  const others = conversations.filter((conversation) => conversation.pinnedAt === null);
  pinned.sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? ''));
  return { pinned, others };
}

/**
 * Where "Chiama" calls Arianna: in the private conversation open in the chat,
 * or in a new private one (a work conversation, an archived one, a system
 * chat or another page get a new private conversation).
 */
export function callTarget(open: Pick<Conversation, 'id' | 'mode' | 'archivedAt' | 'origin' | 'incognito'> | undefined, onChat: boolean): { here: string } | 'new' {
  if (open === undefined || !onChat) return 'new';
  // Never in an incognito conversation (D-136): a call has its own trace, and the core refuses it there.
  if (open.mode !== 'private' || open.archivedAt !== null || open.origin === 'system' || open.incognito === true) return 'new';
  return { here: open.id };
}

/** "1 attivo", "3 attivi", "nessuno attivo". */
export function activeText(count: number): string {
  if (count <= 0) return 'nessuno attivo';
  return `${String(count)} ${count === 1 ? 'attivo' : 'attivi'}`;
}
