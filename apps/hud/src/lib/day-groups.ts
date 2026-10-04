import type { Conversation } from './types.ts';

/** Sections of the conversation list, as on the mockup: today, yesterday, this week, earlier. */
export interface DayGroup {
  title: string;
  conversations: Conversation[];
}

const TITLES = ['Oggi', 'Ieri', 'Ultimi 7 giorni', 'Prima'] as const;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Keeps the order of the list (most recent first); empty sections are left out. */
export function groupByDay(conversations: readonly Conversation[], now: Date): DayGroup[] {
  const today = startOfDay(now);
  const day = 24 * 60 * 60 * 1000;
  const buckets: Conversation[][] = [[], [], [], []];
  for (const conversation of conversations) {
    const at = startOfDay(new Date(conversation.lastMessageAt ?? conversation.createdAt));
    // Calendar days, not 24-hour spans: a change of daylight saving time moves midnight by an hour.
    const daysAgo = Math.round((today - at) / day);
    const index = daysAgo <= 0 ? 0 : daysAgo === 1 ? 1 : daysAgo < 7 ? 2 : 3;
    buckets[index]?.push(conversation);
  }
  return TITLES.map((title, index) => ({ title, conversations: buckets[index] ?? [] })).filter((group) => group.conversations.length > 0);
}
