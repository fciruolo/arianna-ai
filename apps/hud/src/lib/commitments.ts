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

/**
 * How a closed commitment of today reads in the list (D-151): a short tag and
 * the reason when the user gave one; undefined for an open or cancelled one.
 */
export function closedText(item: Pick<Commitment, 'status' | 'reason'>): { tag: string; reason: string | null } | undefined {
  const tag = item.status === 'done' ? 'Fatto' : item.status === 'not_done' ? 'Non fatto' : item.status === 'postponed' ? 'Rinviato' : undefined;
  if (tag === undefined) return undefined;
  const reason = item.status !== 'done' && typeof item.reason === 'string' && item.reason.trim() !== '' ? item.reason.trim() : null;
  return { tag, reason };
}

/** "rinviato da giovedì 15 ottobre" under an open commitment born from a postponement (D-151), else undefined. */
export function postponedText(item: Pick<Commitment, 'status' | 'postponedFrom'>, today: string): string | undefined {
  if (item.status !== 'open' || typeof item.postponedFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.postponedFrom)) return undefined;
  const label = dayLabel(item.postponedFrom, today);
  return `rinviato da ${label === 'Oggi' || label === 'Domani' ? label.toLowerCase() : label}`;
}

/** One line of the end-of-day report the secretary asks to confirm (D-151). */
export interface ReportEntry {
  commitmentId: string;
  text: string;
  dayText: string;
  time: string | null;
  outcome: 'done' | 'not_done' | 'postponed';
  reason: string | null;
  /** Only for a postponement: the new day as the core computed it. */
  to?: { dayText: string; time: string | null };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function reportEntry(raw: unknown): ReportEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { commitmentId, text, dayText, time, outcome: rawOutcome, reason, toDayText, toTime } = raw as Record<string, unknown>;
  const outcome = (['done', 'not_done', 'postponed'] as const).find((name) => name === rawOutcome);
  if (outcome === undefined || typeof commitmentId !== 'string' || typeof text !== 'string' || text.trim() === '' || typeof dayText !== 'string') return undefined;
  const entry: ReportEntry = { commitmentId, text, dayText, time: nullableString(time), outcome, reason: nullableString(reason) };
  if (outcome === 'postponed') {
    // A postponement without its new day cannot be checked: the line is dropped.
    if (typeof toDayText !== 'string' || toDayText.trim() === '') return undefined;
    entry.to = { dayText: toDayText, time: nullableString(toTime) };
  }
  return entry;
}

/** The valid lines of a report approval's detail (`op: 'report'`, D-151); the malformed ones are left out, none at all for another detail. */
export function reportEntries(detail: Record<string, unknown>): ReportEntry[] {
  if (detail.op !== 'report' || !Array.isArray(detail.entries)) return [];
  return detail.entries.map(reportEntry).filter((entry) => entry !== undefined);
}

/** The outcome of a report line in words: "Fatto", "Non fatto", "Rinviato a venerdì 16 ottobre, alle 10:00". */
export function outcomeText(entry: ReportEntry): string {
  if (entry.outcome === 'done') return 'Fatto';
  if (entry.outcome === 'not_done') return 'Non fatto';
  const to = entry.to;
  return to === undefined ? 'Rinviato' : `Rinviato a ${to.dayText}${to.time === null ? '' : `, alle ${to.time}`}`;
}
