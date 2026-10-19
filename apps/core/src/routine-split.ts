/**
 * «Solo <giorno>» of the calendar (D-257): a routine dragged on one of its
 * days becomes two. The first loses that day; a second one is born, with the
 * same title, sources (the tiles of the Dashboard too, D-258), summary, zone
 * and state (active or paused), only on the day of arrival and at the new time, in a new chat «Routine · <titolo>»
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
}

/** What «Annulla» sends: the id of the routine split off. The days to give back are the core's, never the page's. */
export function parseUnsplitInput(body: Record<string, unknown>): UnsplitInput {
  const unknown = Object.keys(body).filter((key) => key !== 'created');
  if (unknown.length > 0) throw new RoutineError('invalid', `unknown field(s): ${unknown.join(', ')}`);
  if (typeof body.created !== 'string' || !UUID.test(body.created)) throw new RoutineError('invalid', 'created must be the id of a routine');
  return { created: body.created };
}

/** The days given back: those of the routine now plus those the split took (from the event), in order. */
export function daysBack(current: readonly IsoDay[], given: readonly unknown[]): IsoDay[] {
  return [...new Set([...current, ...given.filter(isIsoDay)])].sort((a, b) => a - b);
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
      INSERT INTO routines (title, conversation_id, days, at, timezone, sources, dashboard_tiles, summary, channel, voice_max_label, retry_minutes, status, paused_by, next_run_at, approved_at)
      VALUES (${row.title}, ${conversation.id}, ${[input.to]}::smallint[], ${input.at}, ${row.timezone}, ${row.sources}::text[],
        (SELECT dashboard_tiles FROM routines WHERE id = ${id}), ${row.summary},
        ${row.channel}, ${row.voiceMaxLabel}::privacy_label, ${row.retryMinutes}, 'active', NULL, ${next(newRule, now)}, now())
      RETURNING id::text`;
    if (created === undefined) throw new Error('INSERT INTO routines returned no row');
    // A routine is born active (routines_proposal_guard, D-256): from a paused one it is paused at once, in the same transaction.
    if (!active) await tx`UPDATE routines SET status = 'paused', paused_by = 'user', next_run_at = NULL WHERE id = ${created.id}`;
    await appendEvent(tx, { kind: 'conversation.created', label: 'L0', payload: { conversationId: conversation.id, mode: 'private', routine: true } });
    // The day given up, as a number only: «Annulla» gives back exactly this, never what the page sends.
    await appendEvent(tx, { kind: 'routine.created', label: 'L0', payload: { routineId: created.id, conversationId: conversation.id, splitFrom: id, splitDays: [input.day] } });
    return created.id;
  });
  const [routine, created] = await Promise.all([loadRoutine(sql, id), loadRoutine(sql, createdId)]);
  if (routine === undefined || created === undefined) throw new RoutineError('not-found', 'routine not found');
  return { routine, created };
}

/**
 * «Annulla» of a split, atomic: the routine born from the split of `id` is
 * removed (its chat archived) and the first gets back the day it gave up, as
 * written in the event of the split. Refused (409) when `created` is `id` or
 * was not split from it, when the first routine changed after the split, and
 * when the routine split off changed or already ran (its chat has reports
 * then, and removing it would not be a plain «Annulla»). The two routines are
 * locked in the order of their ids, as every other transaction would.
 */
export async function unsplitRoutine(sql: Sql, id: string, input: UnsplitInput, now = new Date()): Promise<Routine> {
  if (input.created === id) throw new RoutineError('conflict', 'a routine is not split from itself');
  await sql.begin(async (tx) => {
    const rows = new Map<string, RoutineRow>();
    for (const key of [id, input.created].sort()) rows.set(key, key === id ? await lockWithChat(tx, key) : await lockRoutine(tx, key));
    const row = rows.get(id);
    const born = rows.get(input.created);
    if (row === undefined || born === undefined) throw new RoutineError('not-found', 'routine not found');
    const [origin] = await tx<{ eventId: string; splitDays: unknown }[]>`
      SELECT id::text AS "eventId", payload->'splitDays' AS "splitDays" FROM events
      WHERE kind = 'routine.created' AND payload->>'routineId' = ${input.created} AND payload->>'splitFrom' = ${id}
      ORDER BY id LIMIT 1`;
    if (origin === undefined || !Array.isArray(origin.splitDays)) throw new RoutineError('conflict', 'that routine was not split from this one');
    // Any change of either routine after the split (the split's own events come before or with it).
    const [later] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events
      WHERE id > ${origin.eventId}::bigint AND kind LIKE 'routine.%'
        AND ((kind = 'routine.updated' AND payload->>'routineId' = ${id}) OR (payload->>'routineId' = ${input.created} AND kind <> 'routine.created'))`;
    if ((later?.n ?? 0) > 0) throw new RoutineError('conflict', 'one of the two routines changed after the split: change them from the page');
    const [ran] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM routine_runs WHERE routine_id = ${input.created}`;
    if ((ran?.n ?? 0) > 0) throw new RoutineError('conflict', 'the routine split off already ran: remove it from the page');
    const days = daysBack(row.days.filter(isIsoDay), origin.splitDays as unknown[]);
    const rule: RoutineRule = { days, at: row.at, timezone: row.timezone };
    const nextRunAt = row.status === 'active' ? (dueOrNext(rule, row.nextRunAt, now) ?? next(rule, now)) : null;
    await tx`UPDATE routines SET days = ${days}::smallint[], next_run_at = ${nextRunAt} WHERE id = ${id}`;
    await appendEvent(tx, { kind: 'routine.updated', label: 'L0', payload: { routineId: id, conversationId: row.conversationId, fields: ['days'] } });
    await tx`UPDATE routines SET status = 'retired', paused_by = NULL, next_run_at = NULL WHERE id = ${input.created}`;
    await appendEvent(tx, { kind: 'routine.retired', label: 'L0', payload: { routineId: input.created, conversationId: born.conversationId, by: 'unsplit' } });
    const archived = await tx`UPDATE conversations SET archived_at = now() WHERE id = ${born.conversationId} AND archived_at IS NULL AND purged_at IS NULL RETURNING id`;
    if (archived.length > 0) await appendEvent(tx, { kind: 'conversation.archived', label: 'L0', payload: { conversationId: born.conversationId, archived: true } });
  });
  const routine = await loadRoutine(sql, id);
  if (routine === undefined) throw new RoutineError('not-found', 'routine not found');
  return routine;
}
