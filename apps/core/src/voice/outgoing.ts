import type { OutgoingRules } from '@arianna/config';

/**
 * When Arianna may call (D-066, choices 8 and 9; docs/SPEC.md "Quando ti
 * chiama"), pure: quiet hours in local time, no calls at the weekend, a
 * maximum per day. A call the user scheduled skips quiet hours and the
 * weekend, but counts in the maximum.
 */
export type CallReason = 'waiting' | 'task-done' | 'scheduled';
export type CallVerdict = { ok: true } | { ok: false; reason: 'quiet-hours' | 'daily-limit' };

function minutes(clock: string): number {
  const [hours = '0', mins = '0'] = clock.split(':');
  return Number(hours) * 60 + Number(mins);
}

/** Inside the quiet hours at `now` (local time)? `from` after `to` spans midnight; equal means none. */
export function inQuietHours(now: Date, from: string, to: string): boolean {
  const start = minutes(from);
  const end = minutes(to);
  if (start === end) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  return start < end ? at >= start && at < end : at >= start || at < end;
}

export function isWeekend(now: Date): boolean {
  return now.getDay() === 0 || now.getDay() === 6;
}

/** The start of the local day of `now`: calls are counted from here. */
export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function mayCall(now: Date, rules: OutgoingRules, callsToday: number, reason: CallReason): CallVerdict {
  if (callsToday >= rules.maxPerDay) return { ok: false, reason: 'daily-limit' };
  if (reason === 'scheduled') return { ok: true };
  if (inQuietHours(now, rules.quietFrom, rules.quietTo) || (rules.quietWeekend && isWeekend(now))) return { ok: false, reason: 'quiet-hours' };
  return { ok: true };
}

/** For a task the user asked to hear about that failed: never "it is finished". */
export const FAILED_TEXT = {
  greeting: 'Ciao, sono Arianna. Ti chiamo, come mi avevi chiesto: il lavoro non è riuscito, trovi l’errore in chat.',
  missed: 'Ti ho cercato al telefono, come mi avevi chiesto: il lavoro non è riuscito, trovi l’errore qui.',
  skipped: 'Il lavoro non è riuscito; non era il momento di chiamarti, l’errore è qui.',
} as const;

/**
 * A call of a direct chat whose agent cannot answer now (D-158): it does not
 * ring, and this is written instead. No name: the note is L0.
 */
export const AGENT_OFF_TEXT = 'Volevo chiamarti, ma l’agente di questa chat adesso non può rispondere al telefono: te lo scrivo qui.';

/** What Arianna says first when the user answers, and what she writes when they do not. */
export const OUTGOING_TEXT: Record<CallReason, { greeting: string; missed: string; skipped: string }> = {
  waiting: {
    greeting: 'Ciao, sono Arianna. Ti chiamo perché un lavoro aspetta una tua risposta da un po’.',
    missed: 'Ti ho cercato al telefono: un lavoro di questa conversazione aspetta una tua risposta.',
    skipped: 'Volevo chiamarti perché un lavoro aspetta una tua risposta, ma non era il momento: te lo scrivo qui.',
  },
  'task-done': {
    greeting: 'Ciao, sono Arianna. Ti chiamo, come mi avevi chiesto: il lavoro è finito.',
    missed: 'Ti ho cercato al telefono, come mi avevi chiesto: il lavoro è finito, trovi il risultato qui.',
    skipped: 'Il lavoro è finito; non era il momento di chiamarti, il risultato è qui.',
  },
  scheduled: {
    greeting: 'Ciao, sono Arianna. È l’ora della chiamata che mi avevi chiesto.',
    missed: 'Ti ho cercato all’ora che mi avevi chiesto, ma non hai risposto.',
    skipped: 'Era l’ora della chiamata che mi avevi chiesto, ma oggi ho già chiamato il massimo di volte.',
  },
};
