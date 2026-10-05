import type { Conversation } from './types.ts';

/** Sections of the conversation list, as on the mockup: today, yesterday, this week, earlier. */
export interface DayGroup {
  title: string;
  conversations: Conversation[];
}

/** The same sections for any list (the thoughts, D-090). */
export interface DaySection<T> {
  title: string;
  items: T[];
}

const TITLES = ['Oggi', 'Ieri', 'Ultimi 7 giorni', 'Prima'] as const;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Keeps the order of the list (most recent first); empty sections are left
 * out. An item without a valid date goes to "Prima".
 */
export function groupItemsByDay<T>(items: readonly T[], dateOf: (item: T) => string | null, now: Date): DaySection<T>[] {
  const today = startOfDay(now);
  const day = 24 * 60 * 60 * 1000;
  const buckets: T[][] = [[], [], [], []];
  for (const item of items) {
    const iso = dateOf(item);
    const date = iso === null ? undefined : new Date(iso);
    if (date === undefined || Number.isNaN(date.getTime())) {
      buckets[3]?.push(item);
      continue;
    }
    // Calendar days, not 24-hour spans: a change of daylight saving time moves midnight by an hour.
    const daysAgo = Math.round((today - startOfDay(date)) / day);
    const index = daysAgo <= 0 ? 0 : daysAgo === 1 ? 1 : daysAgo < 7 ? 2 : 3;
    buckets[index]?.push(item);
  }
  return TITLES.map((title, index) => ({ title, items: buckets[index] ?? [] })).filter((group) => group.items.length > 0);
}

/** Keeps the order of the list (most recent first); empty sections are left out. */
export function groupByDay(conversations: readonly Conversation[], now: Date): DayGroup[] {
  return groupItemsByDay(conversations, (conversation) => conversation.lastMessageAt ?? conversation.createdAt, now).map((group) => ({
    title: group.title,
    conversations: group.items,
  }));
}
