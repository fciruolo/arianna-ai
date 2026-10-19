/**
 * «Solo <giorno>» of the calendar (D-257): a routine dragged on one of its
 * days becomes two. The first loses that day; a second one is born, with the
 * same title, sources, summary, zone and state (active or paused), only on
 * the day of arrival and at the new time, in a new chat «Routine · <titolo>»
 * as a routine created from the page. One transaction: either both change or
 * neither. The events name ids only, never the title.
 */
import type { Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { loadRoutine, ROUTINE_CONVERSATION_PREFIX, RoutineError, type Routine, type RoutineStatus } from './routines.ts';
import { isClock, isIsoDay, nextRun, type IsoDay, type RoutineRule } from './routine-schedule.ts';

export interface SplitInput {
  /** The day the first routine gives up: one of its days, not its only one. */
  day: IsoDay;
  /** The day of the new routine (the column it was dropped on). */
  to: IsoDay;
  /** "HH:MM" of the new routine. */
  at: string;
}

/** What the calendar sends, checked: two ISO days and a clock, nothing else. */
export function parseSplitInput(body: Record<string, unknown>): SplitInput {
  const unknown = Object.keys(body).filter((key) => !['day', 'to', 'at'].includes(key));
  if (unknown.length > 0) throw new RoutineError('invalid', `unknown field(s): ${unknown.join(', ')}`);
  if (!isIsoDay(body.day)) throw new RoutineError('invalid', 'day must be 1-7');
  const to = body.to === undefined ? body.day : body.to;
  if (!isIsoDay(to)) throw new RoutineError('invalid', 'to must be 1-7');
  if (!isClock(body.at)) throw new RoutineError('invalid', 'at must be HH:MM');
  return { day: body.day, to, at: body.at };
}

/** The days the first routine keeps: all but `day`, which must be there and not alone. */
export function keptDays(days: readonly IsoDay[], day: IsoDay): IsoDay[] {
  if (!days.includes(day)) throw new RoutineError('invalid', 'the routine does not run on that day');
  const kept = [...new Set(days)].filter((value) => value !== day).sort((a, b) => a - b);
  if (kept.length === 0) throw new RoutineError('invalid', 'the routine runs on that day only: move it instead');
  return kept;
}

interface LockedRow {
  title: string;
  conversationId: string;
  days: number[];
  at: string;
  timezone: string;
  sources: string[];
  summary: boolean;
  status: RoutineStatus;
  pausedBy: 'user' | 'archived' | null;
  archived: boolean;
  purged: boolean;
}

function next(rule: RoutineRule, now: Date): Date {
  const found = nextRun(rule, now);
  if (found === undefined) throw new RoutineError('invalid', 'the routine cannot run');
  return found;
}

/** The split, atomic: the first routine (without `day`) and the new one. */
export async function splitRoutine(sql: Sql, id: string, input: SplitInput, now = new Date()): Promise<{ routine: Routine; created: Routine }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new RoutineError('not-found', 'routine not found');
  const createdId = await sql.begin(async (tx) => {
    await tx`SELECT 1 FROM routines WHERE id = ${id} FOR UPDATE`;
    const [row] = await tx<LockedRow[]>`
      SELECT r.title, r.conversation_id::text AS "conversationId", r.days::int[] AS days, r.at, r.timezone, r.sources, r.summary, r.status,
        r.paused_by AS "pausedBy", c.archived_at IS NOT NULL AS archived, c.purged_at IS NOT NULL AS purged
      FROM routines r JOIN conversations c ON c.id = r.conversation_id WHERE r.id = ${id}`;
    if (row === undefined || row.status === 'retired' || row.purged) throw new RoutineError('not-found', 'routine not found');
    if (row.status === 'proposed') throw new RoutineError('conflict', 'a proposed routine is approved first');
    if (row.archived || row.pausedBy === 'archived') throw new RoutineError('conflict', 'the chat of the routine is archived');
    const days = keptDays(row.days.filter(isIsoDay), input.day);
    const active = row.status === 'active';
    const keptRule: RoutineRule = { days, at: row.at, timezone: row.timezone };
    const newRule: RoutineRule = { days: [input.to], at: input.at, timezone: row.timezone };
    await tx`UPDATE routines SET days = ${days}::smallint[], next_run_at = ${active ? next(keptRule, now) : null} WHERE id = ${id}`;
    await appendEvent(tx, { kind: 'routine.updated', label: 'L0', payload: { routineId: id, conversationId: row.conversationId, fields: ['days'] } });
    const [conversation] = await tx<{ id: string }[]>`
      INSERT INTO conversations (mode, clearance, title) VALUES ('private', 'L2'::privacy_label, ${ROUTINE_CONVERSATION_PREFIX + row.title})
      RETURNING id::text`;
    if (conversation === undefined) throw new Error('INSERT INTO conversations returned no row');
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO routines (title, conversation_id, days, at, timezone, sources, summary, status, paused_by, next_run_at, approved_at)
      VALUES (${row.title}, ${conversation.id}, ${[input.to]}::smallint[], ${input.at}, ${row.timezone}, ${row.sources}::text[], ${row.summary},
        ${active ? 'active' : 'paused'}, ${active ? null : 'user'}, ${active ? next(newRule, now) : null}, now())
      RETURNING id::text`;
    if (created === undefined) throw new Error('INSERT INTO routines returned no row');
    await appendEvent(tx, { kind: 'conversation.created', label: 'L0', payload: { conversationId: conversation.id, mode: 'private', routine: true } });
    await appendEvent(tx, { kind: 'routine.created', label: 'L0', payload: { routineId: created.id, conversationId: conversation.id, splitFrom: id } });
    return created.id;
  });
  const [routine, created] = await Promise.all([loadRoutine(sql, id), loadRoutine(sql, createdId)]);
  if (routine === undefined || created === undefined) throw new RoutineError('not-found', 'routine not found');
  return { routine, created };
}
