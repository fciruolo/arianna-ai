import { isAtMost, maxLabel, type Label } from '@arianna/policy';

import type { Queryable } from './db/client.ts';
import { appendEvent } from './events.ts';
import { daysText, isClock, isIsoDay, nextRun, systemTimeZone, whenText, type IsoDay } from './routine-schedule.ts';

/**
 * Routines proposed in the chat (D-110, tappa A2; D-256). The orchestrator's
 * tool `routine.propose` gives only closed fields: a title of one line, ISO
 * days, a time HH:MM, sources from the closed list of D-254 and the summary
 * on or off; the time zone is this Mac's, as in the form of the page. The
 * fields are checked here, by code, never trusted to the model: anything else
 * (a prompt, instructions, a channel other than the chat) is refused with an
 * error the model reads. Nothing runs: the core writes a routine `proposed`
 * (off, no next run, never approved) with its private conversation, hidden
 * from the list until it is approved, and an approval of kind `routine` that
 * the user decides in the web chat or on the page «Routine»: «Attiva» makes it
 * active with its next run, «Scarta» retires it.
 *
 * This module imports neither the engine nor routines.ts: the engine applies
 * the decision with it, and routines.ts re-exports what it shares.
 */

/**
 * `dashboard` (D-258) refreshes the tiles of the Dashboard at the routine's
 * time; from routine.propose it is always every tile (the model never chooses
 * tiles: their titles are the user's text, and the choice is the page's).
 */
export const ROUTINE_SOURCES = ['todo', 'waiting', 'cards', 'done-since', 'failed-since', 'notes', 'dashboard'] as const;
export type RoutineSource = (typeof ROUTINE_SOURCES)[number];
export const MAX_ROUTINE_TITLE = 80;
/** The prefix of the title of a routine's conversation. */
export const ROUTINE_CONVERSATION_PREFIX = 'Routine · ';

export function isRoutineSource(value: unknown): value is RoutineSource {
  return typeof value === 'string' && (ROUTINE_SOURCES as readonly string[]).includes(value);
}

export const ROUTINE_PROPOSE = 'routine.propose';
/** The result of a routine.propose call: the next step answers once the user decided. */
export const WAITING_ROUTINE = 'waiting for the user to approve the routine in the chat';

/** The fields a proposal may carry: closed, nothing else. */
const PROPOSAL_FIELDS = ['title', 'days', 'at', 'sources', 'summary', 'channel'];

/** A routine as the tool proposes it, checked. */
export interface RoutineProposal {
  title: string;
  days: IsoDay[];
  at: string;
  timezone: string;
  sources: RoutineSource[];
  summary: boolean;
  /**
   * In the chat, or in the chat and with a call (D-259): the model may propose
   * the call too, since the routine is born off and only the user's «Attiva»
   * starts it. The ceiling of what is said aloud and the second ring are not
   * the model's: the defaults (Privato, no second ring), changed on the page.
   */
  channel: 'chat' | 'call';
}

/** One line of title, as the page checks it: spaces and new lines collapsed, no other control characters, at most 80 characters. */
export function routineTitle(value: unknown): string | { error: string } {
  if (typeof value !== 'string') return { error: 'the title must be a string' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(value)) return { error: 'the title contains control characters' };
  const title = value.replace(/\s+/g, ' ').trim();
  if (title === '') return { error: 'the title is empty' };
  if (Array.from(title).length > MAX_ROUTINE_TITLE) return { error: `the title is longer than ${String(MAX_ROUTINE_TITLE)} characters: write a shorter name` };
  return title;
}

/**
 * The arguments of `routine.propose`, checked by code (D-256): only the closed
 * fields, the title of one line, ISO days, HH:MM (H:MM is padded), sources of
 * the closed list, the summary on by default. The time zone is this Mac's.
 */
export function checkRoutineProposal(args: Record<string, unknown>, timezone = systemTimeZone()): RoutineProposal | { error: string } {
  const unknown = Object.keys(args).filter((key) => !PROPOSAL_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { error: `unknown field(s) ${unknown.join(', ')}: a routine has only title, days, at, sources, summary and channel, never a prompt or instructions of its own` };
  }
  if (args.channel !== undefined && args.channel !== 'chat' && args.channel !== 'call') {
    return { error: 'channel must be "chat" or "call" (a call on the voice of this Mac, with the report in the chat too): email, Telegram and the real phone are not available' };
  }
  const title = routineTitle(args.title);
  if (typeof title !== 'string') return title;
  const days = args.days;
  if (!Array.isArray(days) || days.length === 0 || !days.every(isIsoDay)) return { error: 'days must be a list of ISO days, 1 Monday to 7 Sunday' };
  const clock = typeof args.at === 'string' && /^\d:[0-5]\d$/.test(args.at.trim()) ? `0${args.at.trim()}` : args.at;
  if (!isClock(clock)) return { error: 'at must be a time HH:MM, 24 hours (alle 9: 09:00)' };
  const sources = args.sources;
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every(isRoutineSource)) {
    return { error: `sources must be some of ${ROUTINE_SOURCES.join(', ')}` };
  }
  if (args.summary !== undefined && typeof args.summary !== 'boolean') return { error: 'summary must be true or false' };
  const chosen = new Set<string>(sources);
  return {
    title,
    days: [...new Set(days)].sort((a, b) => a - b),
    at: clock,
    timezone,
    sources: ROUTINE_SOURCES.filter((source) => chosen.has(source)),
    summary: args.summary ?? true,
    channel: args.channel === 'call' ? 'call' : 'chat',
  };
}

/**
 * Where `routine.propose` is offered (D-256): only a private conversation of
 * the user with Arianna, open, never incognito (what it writes outlives the
 * closing), never the secretary's, a direct chat with a model, a trial, a side
 * thread or a dashboard. A work conversation does not offer it: a routine's
 * report is private (L2) and is born in a private conversation of its own.
 */
export async function routineProposalAllowed(sql: Queryable, conversationId: string | null): Promise<boolean> {
  if (conversationId === null) return false;
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT true AS ok FROM conversations
    WHERE id = ${conversationId} AND mode = 'private' AND clearance = 'L2'::privacy_label AND origin = 'user'
      AND purged_at IS NULL AND archived_at IS NULL AND NOT incognito AND NOT secretary AND agent IS NULL
      AND trial_model IS NULL AND side_of IS NULL AND dashboard_of IS NULL AND workspace IS NULL`;
  return row?.ok === true;
}

/** The highest label a proposal is written from: the routine's conversation is private (L2). */
export const PROPOSAL_CEILING: Label = 'L2';

export function proposalLabelOk(label: Label): boolean {
  return isAtMost(label, PROPOSAL_CEILING);
}

/**
 * Writes the proposal with the step's turn, in its transaction: the routine
 * `proposed` with its private conversation, and the approval (L2 at least,
 * as the conversation that holds the title). The event names ids only.
 */
export async function writeRoutineProposal(
  tx: Queryable,
  options: { taskId: string; step: number; label: Label; proposal: RoutineProposal },
): Promise<{ approvalId: string; routineId: string }> {
  const { proposal } = options;
  const [conversation] = await tx<{ id: string }[]>`
    INSERT INTO conversations (mode, clearance, title) VALUES ('private', 'L2'::privacy_label, ${ROUTINE_CONVERSATION_PREFIX + proposal.title})
    RETURNING id::text`;
  if (conversation === undefined) throw new Error('INSERT INTO conversations returned no row');
  const [routine] = await tx<{ id: string }[]>`
    INSERT INTO routines (title, conversation_id, days, at, timezone, sources, summary, channel, status)
    VALUES (${proposal.title}, ${conversation.id}, ${proposal.days}::smallint[], ${proposal.at}, ${proposal.timezone}, ${proposal.sources}::text[], ${proposal.summary}, ${proposal.channel}, 'proposed')
    RETURNING id::text`;
  if (routine === undefined) throw new Error('INSERT INTO routines returned no row');
  const detail = { routineId: routine.id, title: proposal.title, days: proposal.days, at: proposal.at, timezone: proposal.timezone, sources: proposal.sources, summary: proposal.summary, channel: proposal.channel, step: options.step };
  const [approval] = await tx<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${options.taskId}, 'routine', ${ROUTINE_PROPOSE}, ${tx.json(detail)}, ${maxLabel(options.label, PROPOSAL_CEILING)}::privacy_label)
    RETURNING id::text`;
  if (approval === undefined) throw new Error('INSERT INTO approvals returned no row');
  await appendEvent(tx, {
    kind: 'routine.proposed',
    taskId: options.taskId,
    label: 'L0',
    payload: { routineId: routine.id, conversationId: conversation.id, approvalId: approval.id },
  });
  return { approvalId: approval.id, routineId: routine.id };
}

/** The routine an approval of kind `routine` names, or undefined. */
export function proposedRoutineId(approval: { kind: string; detail: Record<string, unknown> }): string | undefined {
  if (approval.kind !== 'routine') return undefined;
  const id = approval.detail.routineId;
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : undefined;
}

/**
 * The user's decision on a proposed routine, in the caller's transaction
 * (the engine's decision, or the page): approved, it becomes active with
 * its next run from now and approved_at; rejected, it is retired. A routine
 * no longer proposed (decided already, or gone) is left as it is.
 * Returns what happened.
 */
export async function decideRoutineProposal(
  tx: Queryable,
  routineId: string,
  state: 'approved' | 'rejected',
  approvalId: string | null,
  now = new Date(),
): Promise<'activated' | 'discarded' | 'none'> {
  const [row] = await tx<{ status: string; conversationId: string; days: number[]; at: string; timezone: string }[]>`
    SELECT status, conversation_id::text AS "conversationId", days::int[] AS days, at, timezone FROM routines WHERE id = ${routineId} FOR UPDATE`;
  if (row?.status !== 'proposed') return 'none';
  const via = approvalId === null ? {} : { approvalId };
  if (state === 'rejected') {
    await tx`UPDATE routines SET status = 'retired', paused_by = NULL, next_run_at = NULL WHERE id = ${routineId}`;
    await appendEvent(tx, { kind: 'routine.retired', label: 'L0', payload: { routineId, conversationId: row.conversationId, by: 'discarded', ...via } });
    return 'discarded';
  }
  const next = nextRun({ days: row.days.filter(isIsoDay), at: row.at, timezone: row.timezone }, now);
  if (next === undefined) throw new Error('the proposed routine cannot run');
  await tx`UPDATE routines SET status = 'active', paused_by = NULL, next_run_at = ${next}, approved_at = now() WHERE id = ${routineId}`;
  await appendEvent(tx, { kind: 'routine.approved', label: 'L0', payload: { routineId, conversationId: row.conversationId, ...via } });
  return 'activated';
}

/** What the chat reads once the user decided a proposed routine, written by code. */
export function routineAnswerText(
  routine: { title: string; days: readonly IsoDay[]; at: string; timezone: string; status: string; nextRunAt: Date | null; channel?: string } | undefined,
  state: string,
): string {
  if (state !== 'approved') return 'Va bene: la routine non parte. Se cambi idea, chiedimela di nuovo o creala nella pagina Routine.';
  if (routine?.status !== 'active' || routine.nextRunAt === null) return 'Non sono riuscita ad attivare la routine: guardala nella pagina Routine.';
  const call = routine.channel === 'call' ? ', e a quell’ora ti chiamo' : '';
  return `Fatto: la routine «${routine.title}» è attiva, ${daysText(routine.days)} alle ${routine.at}. Il primo resoconto arriva ${whenText(routine.nextRunAt, routine.timezone)}, nella sua chat «${ROUTINE_CONVERSATION_PREFIX}${routine.title}»${call}. La cambi o la metti in pausa nella pagina Routine.`;
}
