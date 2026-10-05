/** When a message was sent, next to it in the chat (D-112). */
export interface MessageTime {
  /** Short, in the message's line: "07:31", "ieri 07:31", "3 ott 07:31", "3 ott 2025 07:31". */
  text: string;
  /** Full date and time, in the title shown with the pointer. */
  full: string;
}

const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'] as const;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The time of a message in the local time zone, shorter the closer it is to
 * today. Calendar days, not 24-hour spans, as in day-groups.ts. Undefined for
 * a timestamp that is not a date: nothing is shown.
 */
export function messageTime(ts: string, now: Date): MessageTime | undefined {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return undefined;
  const clock = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / (24 * 60 * 60 * 1000));
  const day = `${String(date.getDate())} ${MONTHS[date.getMonth()] ?? ''}`;
  const text =
    // A clock of the core slightly ahead of the browser's can date a message tomorrow: it is today's.
    daysAgo <= 0 ? clock
    : daysAgo === 1 ? `ieri ${clock}`
    : date.getFullYear() === now.getFullYear() ? `${day} ${clock}`
    : `${day} ${String(date.getFullYear())} ${clock}`;
  const full = date.toLocaleString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return { text, full };
}
