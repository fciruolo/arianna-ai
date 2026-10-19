/**
 * «Solo <giorno>» of the calendar (D-257): a routine dragged on one of its
 * days becomes two. The first loses that day; a second one is born, with the
 * same title, sources, summary, zone and state (active or paused), only on
 * the day of arrival and at the new time, in a new chat «Routine · <titolo>»
 * as a routine created from the page. One transaction: either both change or
 * neither. Its «Annulla» (`unsplitRoutine`) is one transaction too. The
 * events name ids only, never the title.
 */
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { loadRoutine, lockRoutine, ROUTINE_CONVERSATION_PREFIX, RoutineError, UUID, type Routine, type RoutineRow } from './routines.ts';
import { dueOrNext, isClock, isIsoDay, nextRun, type IsoDay, type RoutineRule } from './routine-schedule.ts';

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

export interface UnsplitInput {
  /** The routine born from the split, to remove. */
  created: string;
  /** Days and time of the first routine before the split, to give back. */
  days: IsoDay[];
  at: string;
}

export function parseUnsplitInput(body: Record<string, unknown>): UnsplitInput {
  const unknown = Object.keys(body).filter((key) => !['created', 'days', 'at'].includes(key));
  if (unknown.length > 0) throw new RoutineError('invalid', `unknown field(s): ${unknown.join(', ')}`);
  if (typeof body.created !== 'string' || !UUID.test(body.created)) throw new RoutineError('invalid', 'created must be the id of a routine');
  if (!Array.isArray(body.days) || body.days.length === 0 || !body.days.every(isIsoDay)) throw new RoutineError('invalid', 'days must be a list of 1-7');
  if (!isClock(body.at)) throw new RoutineError('invalid', 'at must be HH:MM');
  return { created: body.created, days: [...new Set(body.days)].sort((a, b) => a - b), at: body.at };
}

/**
 * Whether the first routine is still as the split left it: the days given
 * back are its days plus exactly one, at the same time. Anything else is a
 * change made after the split, which «Annulla» must not undo.
 */
export function leftBySplit(current: { days: readonly IsoDay[]; at: string }, before: { days: readonly IsoDay[]; at: string }): boolean {
  if (current.at !== before.at) return false;
  const now = new Set(current.days);
  const back = new Set(before.days);
  if (![...now].every((day) => back.has(day))) return false;
  return back.size === now.size + 1;
}

function next(rule: RoutineRule, now: Date): Date {
  const found = nextRun(rule, now);
  if (found === undefined) throw new RoutineError('invalid', 'the routine cannot run');
  return found;
}

/** The routine locked, then its conversation held (FOR SHARE) so an archive or an erase waits for us. */
async function lockWithChat(tx: Queryable, id: string): Promise<RoutineRow> {
  const row = await lockRoutine(tx, id);
  await tx`SELECT 1 FROM conversations WHERE id = ${row.conversationId} FOR SHARE`;
  const [chat] = await tx<{ archived: boolean; purged: boolean }[]>`
    SELECT archived_at IS NOT NULL AS archived, purged_at IS NOT NULL AS purged FROM conversations WHERE id = ${row.conversationId}`;
  if (chat === undefined || chat.purged) throw new RoutineError('not-found', 'routine not found');
  if (chat.archived || row.pausedBy === 'archived') throw new RoutineError('conflict', 'the chat of the routine is archived: resume the routine first');
  return row;
}

/** The split, atomic: the first routine (without `day`) and the new one. */
export async function splitRoutine(sql: Sql, id: string, input: SplitInput, now = new Date()): Promise<{ routine: Routine; created: Routine }> {
  const createdId = await sql.begin(async (tx) => {
    const row = await lockWithChat(tx, id);
    if (row.status === 'proposed') throw new RoutineError('conflict', 'a proposed routine is approved first');
    const days = keptDays(row.days.filter(isIsoDay), input.day);
    const active = row.status === 'active';
    const keptRule: RoutineRule = { days, at: row.at, timezone: row.timezone };
    const newRule: RoutineRule = { days: [input.to], at: input.at, timezone: row.timezone };
    // A run due and not yet taken by the ticker stays when it is still a time of the days kept.
    const kept = active ? (dueOrNext(keptRule, row.nextRunAt, now) ?? next(keptRule, now)) : null;
    await tx`UPDATE routines SET days = ${days}::smallint[], next_run_at = ${kept} WHERE id = ${id}`;
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

/**
 * «Annulla» of a split, atomic: the routine born from the split of `id` is
 * removed (its chat archived, with nothing in it but what the routine wrote)
 * and the first gets back its days and time. Refused (409) when `created` was
 * not split from `id`, or when the first routine changed after the split.
 */
export async function unsplitRoutine(sql: Sql, id: string, input: UnsplitInput, now = new Date()): Promise<Routine> {
  await sql.begin(async (tx) => {
    const row = await lockWithChat(tx, id);
    const born = await lockRoutine(tx, input.created);
    const [origin] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events
      WHERE kind = 'routine.created' AND payload->>'routineId' = ${input.created} AND payload->>'splitFrom' = ${id}`;
    if ((origin?.n ?? 0) === 0) throw new RoutineError('conflict', 'that routine was not split from this one');
    if (!leftBySplit({ days: row.days.filter(isIsoDay), at: row.at }, input)) {
      throw new RoutineError('conflict', 'the routine changed after it was split: change it from the page');
    }
    const rule: RoutineRule = { days: input.days, at: input.at, timezone: row.timezone };
    const nextRunAt = row.status === 'active' ? (dueOrNext(rule, row.nextRunAt, now) ?? next(rule, now)) : null;
    await tx`UPDATE routines SET days = ${input.days}::smallint[], at = ${input.at}, next_run_at = ${nextRunAt} WHERE id = ${id}`;
    await appendEvent(tx, { kind: 'routine.updated', label: 'L0', payload: { routineId: id, conversationId: row.conversationId, fields: ['at', 'days'] } });
    await tx`UPDATE routines SET status = 'retired', paused_by = NULL, next_run_at = NULL WHERE id = ${input.created}`;
    await appendEvent(tx, { kind: 'routine.retired', label: 'L0', payload: { routineId: input.created, conversationId: born.conversationId, by: 'unsplit' } });
    const archived = await tx`UPDATE conversations SET archived_at = now() WHERE id = ${born.conversationId} AND archived_at IS NULL AND purged_at IS NULL RETURNING id`;
    if (archived.length > 0) await appendEvent(tx, { kind: 'conversation.archived', label: 'L0', payload: { conversationId: born.conversationId, archived: true } });
  });
  const routine = await loadRoutine(sql, id);
  if (routine === undefined) throw new RoutineError('not-found', 'routine not found');
  return routine;
}
