import type { Commitment } from './types.ts';

/**
 * The list of the secretary (I-12, D-144) beside its conversation: the open
 * commitments by day, the late ones first, and those of today already done.
 * Days are the core's local days ("YYYY-MM-DD"), compared as text.
 */
const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

function utc(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

function nextDay(day: string): string {
  const at = utc(day);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

/** "Oggi", "Domani", or "giovedì 15 ottobre" (with the year when it is not this one). */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'Oggi';
  if (day === nextDay(today)) return 'Domani';
  const at = utc(day);
  const year = day.slice(0, 4) === today.slice(0, 4) ? '' : ` ${day.slice(0, 4)}`;
  return `${WEEKDAYS[at.getUTCDay()] ?? ''} ${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? ''}${year}`;
}

export interface CommitmentGroup {
  /** "In ritardo", "Oggi", "Domani", "giovedì 15 ottobre". */
  title: string;
  late: boolean;
  items: Commitment[];
}

/** By day: the late open ones together first, then each day in order; the cancelled ones never. */
export function groupCommitments(items: readonly Commitment[], today: string): CommitmentGroup[] {
  const groups: CommitmentGroup[] = [];
  const late = items.filter((item) => item.status === 'open' && item.day < today);
  if (late.length > 0) groups.push({ title: 'In ritardo', late: true, items: late });
  for (const item of items) {
    if (item.status === 'cancelled' || item.day < today) continue;
    const title = dayLabel(item.day, today);
    const group = groups.find((entry) => !entry.late && entry.title === title);
    if (group === undefined) groups.push({ title, late: false, items: [item] });
    else group.items.push(item);
  }
  return groups;
}

/** How many are still to do: the open ones up to today, the late ones included. */
export function dueCount(items: readonly Commitment[], today: string): number {
  return items.filter((item) => item.status === 'open' && item.day <= today).length;
}

/** The line above the first message of the current session of the secretary (D-146). */
export const SESSION_LINE = 'Nuova sessione · Arianna ricorda solo da qui';

/**
 * Where the current session of the secretary begins (D-146): the index of the
 * first message written from its start on, `messages.length` when none is yet
 * (the line then closes the chat), -1 without a session or any message.
 */
export function sessionStart(messages: readonly { ts: string }[], sessionAt: string | null | undefined): number {
  if (sessionAt === null || sessionAt === undefined || messages.length === 0) return -1;
  const at = Date.parse(sessionAt);
  if (Number.isNaN(at)) return -1;
  const index = messages.findIndex((message) => Date.parse(message.ts) >= at);
  return index === -1 ? messages.length : index;
}
