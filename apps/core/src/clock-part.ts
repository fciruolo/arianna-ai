/**
 * The date and time of now for the local model (D-311): one line written by
 * the code, at the end of the last message of each request (never in the
 * fixed prompt, so that the prefix cache of oMLX stays whole, D-075). The
 * model has no clock: without it, «che giorno è oggi?» had no answer.
 *
 * L0: it says nothing of the user beyond what any clock says; it passes the
 * gateway with the other parts of the request, with a source of its own.
 */
import type { TailPart } from './prompt-tail.ts';
import { dayText, systemTimeZone, wallOf } from './routine-schedule.ts';

export const CLOCK_SOURCE = 'arianna:clock';

/**
 * «Adesso: venerdì 23 ottobre 2026, 10:12:37 (Europe/Rome).», to the second of the request, in `timezone` (this
 * Mac's by default). The seconds cost nothing to the cache: the line is in the last message, never in the prefix.
 */
export function nowText(now: Date, timezone: string = systemTimeZone()): string {
  const wall = wallOf(now.getTime(), timezone);
  // Every zone in use is offset by whole minutes: the seconds are the same as in UTC.
  const seconds = now.getUTCSeconds();
  const clock = [wall.hour, wall.minute, seconds].map((part) => String(part).padStart(2, '0')).join(':');
  return `Adesso: ${dayText(now, timezone)}, ${clock} (${timezone}).`;
}

/** The line of now as a part of the request, for the gateway. */
export function clockPart(now: Date, timezone?: string): TailPart {
  return { text: nowText(now, timezone), label: 'L0', source: CLOCK_SOURCE };
}

/** The trailer of the last message: the lines of the character (D-224), then the time; the empty ones left out. */
export function joinTrailer(...pieces: readonly string[]): string {
  return pieces.filter((piece) => piece !== '').join('\n\n');
}

/**
 * `trailer` after the last message when it is the user's (as `chatMessages`
 * of packages/agents does): never into the system message, nor after an
 * answer of the model.
 */
export function withTrailer<T extends { role: string; content: string }>(messages: readonly T[], trailer: string): T[] {
  const list = [...messages];
  const last = list.at(-1);
  if (trailer !== '' && last?.role === 'user') list[list.length - 1] = { ...last, content: `${last.content}\n\n${trailer}` };
  return list;
}
