import type { SecretaryConfig } from '@arianna/config';
import { isAtMost, maxLabel, type Label } from '@arianna/policy';

import { dayText } from './commitment-dates.ts';
import { COMMITMENT_LABEL, lateCommitments, listCommitments, secretaryConversationId, type Commitment } from './commitments.ts';
import { createDailyTicker, fireOnce, type DailySchedule, type DailyTicker } from './daily-ticker.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';

/**
 * The reminders of the secretary (I-12 tappa S2, D-149): at the three
 * moments of `[secretary]` the core writes, as a message of Arianna in the
 * secretary's conversation, the commitments still to do. The text is written
 * here from SQL, never by a model; nothing is written when there is nothing
 * to say. Each moment runs once per day (an event `schedule.fired`), also
 * across a restart. The message event carries `reminder` (the moment), so the
 * notifier sends a notice of kind `reminder`: a fixed sentence, never the
 * text of a commitment.
 */
export const MOMENTS = ['morning', 'afternoon', 'evening'] as const;
export type Moment = (typeof MOMENTS)[number];

/** The name of the secretary's schedule in the events `schedule.fired`. */
export const SECRETARY_SCHEDULE = 'secretary';

export function isMoment(value: string): value is Moment {
  return (MOMENTS as readonly string[]).includes(value);
}

export function secretarySchedule(config: SecretaryConfig): DailySchedule {
  return {
    enabled: config.enabled,
    slots: MOMENTS.map((key) => ({ key, time: config[key] })),
    days: config.days,
  };
}

function line(item: Commitment, withDay: boolean): string {
  const when = [withDay ? dayText(item.day) : '', item.time ?? ''].filter((part) => part !== '').join(', ');
  // A commitment postponed here from another day says so (D-151).
  const from = item.postponedFrom === null ? '' : ` (rinviato da ${dayText(item.postponedFrom)})`;
  return `- ${when === '' ? '' : `${when} · `}${item.body}${from}`;
}

/**
 * The message of a moment, or undefined when there is nothing to say.
 * `today`: the open commitments of the day; `late`: the open ones of the
 * days before (not in the evening, which reports on the day only).
 */
export function reminderText(moment: Moment, day: string, today: readonly Commitment[], late: readonly Commitment[]): string | undefined {
  const shownLate = moment === 'evening' ? [] : late;
  if (today.length === 0 && shownLate.length === 0) return undefined;
  const lines: string[] = [];
  if (moment === 'morning') lines.push(`Buongiorno. Il promemoria di oggi, ${dayText(day)}.`);
  else if (moment === 'afternoon') lines.push('Promemoria del pomeriggio.');
  else lines.push(`Resoconto di fine giornata, ${dayText(day)}.`);
  // The morning starts from what was postponed to today (D-151).
  const postponed = moment === 'morning' ? today.filter((item) => item.postponedFrom !== null) : [];
  const rest = today.filter((item) => !postponed.includes(item));
  if (postponed.length > 0) {
    lines.push('', 'Rinviati a oggi:');
    for (const item of postponed) lines.push(line(item, false));
  }
  if (rest.length > 0) {
    lines.push('', moment === 'morning' ? (postponed.length > 0 ? 'Il resto di oggi:' : 'Da fare oggi:') : moment === 'afternoon' ? 'Di oggi ancora aperti:' : 'Di oggi non risultano fatti:');
    for (const item of rest) lines.push(line(item, false));
  }
  if (shownLate.length > 0) {
    lines.push('', 'Ancora da fare dai giorni scorsi:');
    for (const item of shownLate) lines.push(line(item, true));
  }
  if (moment === 'evening') lines.push('', 'Per ciascuno dimmi com’è andata: fatto, non fatto o da rinviare (a quale giorno), e perché. Annoto tutto con una sola conferma.');
  return lines.join('\n');
}

/** The secretary's conversation and its clearance, created when missing, without opening a session (D-146: only a click does). */
async function secretaryConversation(tx: Queryable): Promise<{ id: string; clearance: Label }> {
  const id = await secretaryConversationId(tx);
  const [row] = await tx<{ clearance: Label }[]>`SELECT clearance FROM conversations WHERE id = ${id}`;
  if (row === undefined) throw new Error('the secretary conversation is missing');
  return { id, clearance: row.clearance };
}

/** What one moment did: wrote a message, had nothing to say, or had already run today. */
export type ReminderOutcome = 'written' | 'empty' | 'already';

/**
 * The moment `moment` of `day`, once: the lists from SQL, the message of
 * Arianna (L2 at least, never above the conversation's clearance) and its
 * event with `reminder`, which the notifier turns into a notice.
 */
export async function fireReminder(sql: Sql, day: string, moment: Moment): Promise<ReminderOutcome> {
  let outcome: ReminderOutcome = 'already';
  await fireOnce(sql, { schedule: SECRETARY_SCHEDULE, day, slot: moment }, async (tx) => {
    const today = (await listCommitments(tx, { from: day, to: day })).filter((item) => item.status === 'open');
    const late = moment === 'evening' ? [] : await lateCommitments(tx, day);
    const conversation = (today.length > 0 || late.length > 0) ? await secretaryConversation(tx) : undefined;
    // A commitment above what the conversation may hold is left out (none is, today: both are L2).
    const fits = (item: Commitment): boolean => conversation !== undefined && isAtMost(item.label, conversation.clearance);
    const text = reminderText(moment, day, today.filter(fits), late.filter(fits));
    if (conversation === undefined || text === undefined) {
      outcome = 'empty';
      return { written: false };
    }
    const label = maxLabel(COMMITMENT_LABEL, ...today.filter(fits).map((item) => item.label), ...late.filter(fits).map((item) => item.label));
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO messages (conversation_id, role, channel, label, body)
      VALUES (${conversation.id}, 'assistant', 'web', ${label}::privacy_label, ${text})
      RETURNING id::text`;
    if (row === undefined) throw new Error('INSERT INTO messages returned no row');
    await appendEvent(tx, { kind: 'message.created', label: 'L0', payload: { conversationId: conversation.id, messageId: row.id, role: 'assistant', reminder: moment } });
    outcome = 'written';
    return { written: true };
  });
  return outcome;
}

/** The ticker of the secretary, on `[secretary]` as it is at each tick. */
export function createSecretaryTicker(options: {
  sql: Sql;
  settings: () => SecretaryConfig;
  now?: () => Date;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): DailyTicker {
  return createDailyTicker({
    schedule: () => secretarySchedule(options.settings()),
    fire: async (day, key) => {
      if (isMoment(key)) await fireReminder(options.sql, day, key);
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}
