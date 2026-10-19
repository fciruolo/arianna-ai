import { daysText, SOURCE_TEXT, type IsoDay, type RoutineSource } from './routines.ts';

// The card of a routine Arianna proposes in the chat (D-110, tappa A2; D-256):
// title, days and time, what goes in the report. Nothing runs before «Attiva»;
// «Scarta» removes the proposal. The same two buttons are on the page «Routine».

export const ROUTINE_YES = 'Attiva';
export const ROUTINE_NO = 'Scarta';
export const ROUTINE_NOTE =
  'Il resoconto lo scrive il codice, nella chat della routine; niente esce verso il cloud. La cambi, la metti in pausa o la togli nella pagina Routine.';

export interface RoutineProposalCard {
  title: string;
  /** "lun e gio alle 09:00". */
  when: string;
  /** The time zone, when it is not this Mac's. */
  zone: string | null;
  sources: string[];
  summary: boolean;
}

const SOURCES: readonly RoutineSource[] = ['todo', 'waiting', 'cards', 'done-since', 'failed-since', 'notes'];

function isDay(value: unknown): value is IsoDay {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;
}

function isSource(value: unknown): value is RoutineSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value);
}

/** The card of a `routine.propose` approval (kind `routine`), or undefined when it is not a whole one. */
export function routineProposal(approval: { kind: string; detail: Record<string, unknown> }, ownZone?: string): RoutineProposalCard | undefined {
  if (approval.kind !== 'routine') return undefined;
  const { title, days, at, timezone, sources, summary } = approval.detail;
  if (typeof title !== 'string' || typeof at !== 'string' || !Array.isArray(days) || !Array.isArray(sources)) return undefined;
  const validDays = days.filter(isDay);
  const validSources = sources.filter(isSource);
  if (validDays.length === 0 || validSources.length === 0) return undefined;
  return {
    title,
    when: `${daysText(validDays)} alle ${at}`,
    zone: typeof timezone === 'string' && timezone !== ownZone ? timezone : null,
    sources: validSources.map((source) => SOURCE_TEXT[source]),
    summary: summary !== false,
  };
}
