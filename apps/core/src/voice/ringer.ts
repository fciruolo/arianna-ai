import type { OutgoingRules } from '@arianna/config';

import type { Queryable, Sql } from '../db/client.ts';
import { ChatError } from '../conversations.ts';
import { appendEvent } from '../events.ts';
import { queueRoutineCall } from '../routines.ts';
import { loadTask } from '../tasks.ts';
import { CALL_COLUMNS, CallError, loadCall, writeNote, type Call } from './calls.ts';
import { AGENT_OFF_TEXT, FAILED_TEXT, mayCall, OUTGOING_TEXT, ROUTINE_NOTE_TEXT, startOfDay, type CallReason } from './outgoing.ts';

/**
 * A call of a routine (D-259) waits for the voice, or for a call in progress,
 * this long after its time; then it is skipped with a note, so a routine of
 * ten o'clock never rings at one when the voice comes back (D-110 g).
 */
export const ROUTINE_CALL_WAIT_MS = 10 * 60_000;

/**
 * The calls Arianna makes (D-066, choice 8): a task waiting for the user for
 * longer than `waiting_minutes`, a task the user asked to hear about when it
 * finishes, a call the user scheduled. Checked at an interval; one call at a
 * time; under the rules of `[voice.outgoing]`. A call rings in the chat (and
 * by Web Push when no chat is open); unanswered, or not allowed now, Arianna
 * writes in the conversation instead and does not insist.
 */
export interface RingerOptions {
  sql: Sql;
  rules: () => OutgoingRules;
  /** The voice can take a call now: otherwise nothing rings and the candidate waits. */
  voiceUp: () => boolean;
  /** Keeps the voice in place from the check of `voiceUp` to the row of the call (the switch of the core, D-071). */
  hold?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Web Push "Arianna ti chiama", read at each ring; undefined without [push] (or [voice.push] of an older file). */
  notify?: () => (() => Promise<void>) | undefined;
  /**
   * Whether the conversation's call can be answered now (D-158: in a direct
   * chat, by its agent; `Calls.check` with `answer`). Absent, every call may ring.
   */
  check?: (conversationId: string) => Promise<void>;
  /** How many pages hold the live feed now: with none, the push is the only way to ring. */
  clientsOnline: () => number;
  onError?: (error: unknown) => void;
  /** The clock of the rules (quiet hours, weekend, a scheduled time); waits and daily counts use the real time, as the database does. */
  now?: () => Date;
  intervalMs?: number;
}

export interface Ringer {
  /** One check now; the timer calls it at the interval. Resolves with the call that rang or was skipped. */
  tick(): Promise<Call | undefined>;
  stop(): void;
}

type Candidate = { kind: 'row'; call: Call } | { kind: 'waiting'; taskId: string; conversationId: string };

/** A conversation of the user, neither archived nor deleted nor incognito (alias c; D-136: Arianna never calls about one). */
// Nor a refresh of the Dashboard (D-248): it never asks the user anything.
const OPEN_CONVERSATION = "c.archived_at IS NULL AND c.purged_at IS NULL AND c.origin = 'user' AND NOT c.incognito AND c.dashboard_of IS NULL";

async function nextCandidate(sql: Queryable, now: Date, waitingMinutes: number, due: Date): Promise<Candidate | undefined> {
  // A call the user scheduled, now due.
  const [scheduled] = await sql.unsafe<Call[]>(
    `SELECT ${CALL_COLUMNS} FROM calls WHERE id = (
       SELECT k.id FROM calls k JOIN conversations c ON c.id = k.conversation_id
       WHERE k.status = 'scheduled' AND k.reason = 'scheduled' AND k.scheduled_at <= $1 AND ${OPEN_CONVERSATION}
       ORDER BY k.scheduled_at LIMIT 1)`,
    [due],
  );
  if (scheduled !== undefined) return { kind: 'row', call: scheduled };
  // A routine's call (D-259), at its time by the real clock (the run wrote it with now()), of a routine still active.
  const [routine] = await sql.unsafe<Call[]>(
    `SELECT ${CALL_COLUMNS} FROM calls WHERE id = (
       SELECT k.id FROM calls k JOIN conversations c ON c.id = k.conversation_id
         JOIN routine_runs x ON x.id = k.routine_run_id JOIN routines r ON r.id = x.routine_id
       WHERE k.status = 'scheduled' AND k.reason = 'routine' AND k.scheduled_at <= now() AND r.status = 'active' AND r.channel = 'call'
         AND (k.routine_attempt = 1 OR r.retry_minutes IS NOT NULL) AND ${OPEN_CONVERSATION}
       ORDER BY k.scheduled_at LIMIT 1)`,
  );
  if (routine !== undefined) return { kind: 'row', call: routine };
  // A task the user asked to hear about, now finished (or failed).
  const [done] = await sql.unsafe<Call[]>(
    `SELECT ${CALL_COLUMNS} FROM calls WHERE id = (
       SELECT k.id FROM calls k JOIN tasks t ON t.id = k.task_id JOIN conversations c ON c.id = k.conversation_id
       WHERE k.status = 'scheduled' AND k.reason = 'task-done' AND t.status IN ('done', 'failed') AND ${OPEN_CONVERSATION}
       ORDER BY t.updated_at LIMIT 1)`,
  );
  if (done !== undefined) return { kind: 'row', call: done };
  // A task waiting for the user for too long, not called about since it started waiting.
  // The wait starts when the task moved to waiting_user (its event); updated_at moves for other reasons too.
  const [waiting] = await sql<{ taskId: string; conversationId: string }[]>`
    SELECT w.id::text AS "taskId", w.conversation_id::text AS "conversationId" FROM (
      SELECT t.id, t.conversation_id, coalesce(
        (SELECT max(e.ts) FROM events e WHERE e.task_id = t.id AND e.kind = 'task.status' AND e.payload ->> 'to' = 'waiting_user'),
        t.updated_at) AS since
      FROM tasks t JOIN conversations c ON c.id = t.conversation_id
      WHERE t.status = 'waiting_user' AND ${sql.unsafe(OPEN_CONVERSATION)}
    ) w
    WHERE w.since <= ${new Date(now.getTime() - waitingMinutes * 60_000)}
      AND NOT EXISTS (SELECT FROM calls k WHERE k.task_id = w.id AND k.reason = 'waiting' AND k.created_at >= w.since)
    ORDER BY w.since LIMIT 1`;
  if (waiting !== undefined) return { kind: 'waiting', ...waiting };
  return undefined;
}

export function createRinger(options: RingerOptions): Ringer {
  const { sql } = options;
  const now = options.now ?? (() => new Date());
  const timers = new Set<NodeJS.Timeout>();
  let running = false;

  async function missIfUnanswered(callId: string): Promise<void> {
    const rows = await sql.begin(async (tx) => {
      const changed = await tx<{ conversationId: string; reason: CallReason; failed: boolean; runId: string | null; attempt: number | null }[]>`
        UPDATE calls SET status = 'missed', end_reason = 'no-answer', ended_at = now()
        WHERE id = ${callId} AND status = 'ringing'
        RETURNING conversation_id::text AS "conversationId", reason,
          EXISTS (SELECT FROM tasks t WHERE t.id = calls.task_id AND t.status = 'failed') AS failed,
          routine_run_id::text AS "runId", routine_attempt AS attempt`;
      const notes: { conversationId: string; text: string }[] = [];
      for (const row of changed) {
        await appendEvent(tx, { kind: 'call.ended', label: 'L0', payload: { callId, conversationId: row.conversationId, status: 'missed', reason: 'no-answer' } });
        if (row.reason === 'routine') {
          notes.push({ conversationId: row.conversationId, text: await routineMissed(tx, row.conversationId, row.runId, row.attempt) });
          continue;
        }
        notes.push({ conversationId: row.conversationId, text: row.reason === 'task-done' && row.failed ? FAILED_TEXT.missed : OUTGOING_TEXT[row.reason].missed });
      }
      return notes;
    });
    for (const note of rows) await writeNote(sql, note.conversationId, note.text, callId);
  }

  /**
   * A first call of a routine not answered (D-259): one second ring after
   * `retry_minutes`, when the routine asks and is still active (D-110,
   * risposta 6), in the same transaction; the note says so. Declined with
   * «Rifiuta», never: the user said no.
   */
  async function routineMissed(tx: Queryable, conversationId: string, runId: string | null, attempt: number | null): Promise<string> {
    if (runId === null || attempt !== 1) return attempt === 2 ? ROUTINE_NOTE_TEXT.retryMissed : OUTGOING_TEXT.routine.missed;
    const [routine] = await tx<{ id: string; minutes: number | null }[]>`
      SELECT r.id::text, r.retry_minutes AS minutes FROM routine_runs x JOIN routines r ON r.id = x.routine_id
      WHERE x.id = ${runId} AND r.status = 'active'`;
    if (routine?.minutes === null || routine === undefined) return OUTGOING_TEXT.routine.missed;
    const queued = await queueRoutineCall(tx, { routineId: routine.id, conversationId, runId, attempt: 2, at: new Date(Date.now() + routine.minutes * 60_000) });
    return queued === undefined ? OUTGOING_TEXT.routine.missed : ROUTINE_NOTE_TEXT.retry(routine.minutes);
  }

  /**
   * The calls of routines that cannot ring any more (D-259): waited past
   * ROUTINE_CALL_WAIT_MS (the voice not ready, another call in progress) are
   * skipped with a note; those of a routine no longer active, or of a chat
   * archived or deleted, are cancelled without one. Before the voice check: a
   * voice that never comes up still leaves the note.
   */
  async function settleRoutineCalls(): Promise<void> {
    const rows = await sql.begin(async (tx) => {
      // Cancelled: the routine no longer active or no longer with the call, a second ring no longer asked, the chat closed.
      const changed = await tx<{ id: string; conversationId: string; endReason: 'expired' | 'cancelled' }[]>`
        UPDATE calls k SET status = 'skipped', ended_at = now(),
          end_reason = CASE WHEN r.status <> 'active' OR r.channel <> 'call' OR (k.routine_attempt = 2 AND r.retry_minutes IS NULL)
            OR c.archived_at IS NOT NULL OR c.purged_at IS NOT NULL THEN 'cancelled' ELSE 'expired' END
        FROM routine_runs x, routines r, conversations c
        WHERE k.routine_run_id = x.id AND r.id = x.routine_id AND c.id = k.conversation_id
          AND k.status = 'scheduled' AND k.reason = 'routine'
          AND (r.status <> 'active' OR r.channel <> 'call' OR (k.routine_attempt = 2 AND r.retry_minutes IS NULL)
               OR c.archived_at IS NOT NULL OR c.purged_at IS NOT NULL
               OR k.scheduled_at < now() - make_interval(secs => ${ROUTINE_CALL_WAIT_MS / 1000}))
        RETURNING k.id::text, k.conversation_id::text AS "conversationId", k.end_reason AS "endReason"`;
      for (const row of changed) {
        await appendEvent(tx, { kind: 'call.ended', label: 'L0', payload: { callId: row.id, conversationId: row.conversationId, status: 'skipped', reason: row.endReason } });
      }
      return changed;
    });
    for (const row of rows) if (row.endReason === 'expired') await writeNote(sql, row.conversationId, ROUTINE_NOTE_TEXT.expired, row.id);
  }

  async function refusedByAgent(conversationId: string): Promise<boolean | 'later'> {
    if (options.check === undefined) return false;
    try {
      await options.check(conversationId);
      return false;
    } catch (error) {
      if (error instanceof CallError && error.code === 'agent-off') return true;
      if (error instanceof CallError && error.code === 'not-ready') return 'later';
      throw error;
    }
  }

  async function tick(): Promise<Call | undefined> {
    if (running) return undefined;
    return options.hold === undefined ? ring() : options.hold(ring);
  }

  async function ring(): Promise<Call | undefined> {
    running = true;
    try {
      const rules = options.rules();
      const at = now();
      const real = new Date();
      await settleRoutineCalls();
      // The voice cannot take a call now (starting, failed, not installed): nothing rings, the candidate waits.
      if (!options.voiceUp()) return undefined;
      // One call at a time: wait for the one in progress.
      const [live] = await sql`SELECT 1 FROM calls WHERE status IN ('ringing', 'connecting', 'active')`;
      if (live !== undefined) return undefined;
      const candidate = await nextCandidate(sql, real, rules.waitingMinutes, at);
      if (candidate === undefined) return undefined;
      const reason: CallReason = candidate.kind === 'waiting' ? 'waiting' : (candidate.call.reason ?? 'scheduled');
      // The agent of a direct chat that cannot answer (D-158): skipped, as answering would refuse it.
      // No local model for it just now (the router waits) is not a refusal: the call waits for the next check.
      const agentOff = await refusedByAgent(candidate.kind === 'waiting' ? candidate.conversationId : candidate.call.conversationId);
      if (agentOff === 'later') return undefined;
      // Counted by when they rang (answered, missed or failed alike), not by when they were scheduled.
      const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM calls WHERE rang_at >= ${startOfDay(real)}`;
      // A routine's second ring, and its call late after the Mac was off, keep the quiet hours (D-110, risposte 6 e 7).
      const quiet = reason === 'routine' && candidate.kind === 'row' && (await routineKeepsQuiet(sql, candidate.call));
      const allowed = mayCall(at, rules, count, reason, { quiet });
      // With no page open and no push, nobody can hear it ring: Arianna writes at once.
      const notify = options.notify?.();
      const deaf = allowed.ok && options.clientsOnline() === 0 && notify === undefined;
      const verdict: { ok: true } | { ok: false; reason: 'quiet-hours' | 'daily-limit' | 'no-answer' | 'agent-off' } = agentOff
        ? { ok: false, reason: 'agent-off' }
        : deaf
          ? { ok: false, reason: 'no-answer' }
          : allowed;
      const task = candidate.kind === 'waiting' ? undefined : candidate.call.taskId === null ? undefined : await loadTask(sql, candidate.call.taskId);
      const failed = reason === 'task-done' && task?.status === 'failed';

      let call: Call | undefined;
      try {
        call = await sql.begin(async (tx) => {
          const status = verdict.ok ? 'ringing' : 'skipped';
          const endReason = verdict.ok ? null : verdict.reason;
          const [row] =
            candidate.kind === 'waiting'
              ? await tx.unsafe<Call[]>(
                  `INSERT INTO calls (conversation_id, direction, reason, task_id, status, end_reason, ended_at, rang_at)
                   VALUES ($1, 'out', 'waiting', $2, $3, $4, CASE WHEN $3 = 'skipped' THEN now() END, CASE WHEN $3 = 'ringing' THEN now() END)
                   RETURNING ${CALL_COLUMNS}`,
                  [candidate.conversationId, candidate.taskId, status, endReason],
                )
              : await tx.unsafe<Call[]>(
                  `UPDATE calls SET status = $2, end_reason = $3, ended_at = CASE WHEN $2 = 'skipped' THEN now() END,
                     rang_at = CASE WHEN $2 = 'ringing' THEN now() END
                   WHERE id = $1 AND status = 'scheduled' RETURNING ${CALL_COLUMNS}`,
                  [candidate.call.id, status, endReason],
                );
          if (row === undefined) return undefined;
          await appendEvent(tx, {
            kind: verdict.ok ? 'call.ringing' : 'call.ended',
            label: 'L0',
            // L0: never the agent of a direct chat (a user's agent is named at L1, D-125); the chat reads it from the conversation.
            payload: { callId: row.id, conversationId: row.conversationId, reason, ...(verdict.ok ? {} : { status: 'skipped', endReason: verdict.reason }) },
          });
          return row;
        });
      } catch (error) {
        // Another call started meanwhile (one live call at a time): try again at the next tick.
        if ((error as { code?: unknown }).code === '23505') return undefined;
        throw error;
      }
      if (call === undefined) return undefined;

      if (!verdict.ok) {
        // Nobody could hear it ring (no page, no push): as a call not answered, the second ring too.
        const deafRoutine = reason === 'routine' && verdict.reason === 'no-answer';
        const text = deafRoutine
          ? await sql.begin((tx) => routineMissed(tx, call.conversationId, call.routineRunId, call.routineAttempt))
          : reason === 'routine'
            ? verdict.reason === 'quiet-hours'
              ? ROUTINE_NOTE_TEXT.quiet
              : OUTGOING_TEXT.routine.skipped
            : agentOff
              ? AGENT_OFF_TEXT
              : failed
                ? FAILED_TEXT.skipped
                : OUTGOING_TEXT[reason].skipped;
        await writeNote(sql, call.conversationId, text, call.id);
        return call;
      }
      // No chat open: the push is the only way to ring.
      if (options.clientsOnline() === 0 && notify !== undefined) await notify().catch((error: unknown) => options.onError?.(error));
      const callId = call.id;
      const timer = setTimeout(() => {
        timers.delete(timer);
        missIfUnanswered(callId).catch((error: unknown) => options.onError?.(error));
      }, rules.ringSeconds * 1000);
      timers.add(timer);
      return call;
    } finally {
      running = false;
    }
  }

  const interval = setInterval(() => {
    tick().catch((error: unknown) => options.onError?.(error));
  }, options.intervalMs ?? 30_000);
  interval.unref();

  return {
    tick,
    stop() {
      clearInterval(interval);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** The second ring of a routine, or its call after a run late: Arianna's choice, under the quiet hours. */
async function routineKeepsQuiet(sql: Queryable, call: Call): Promise<boolean> {
  if (call.routineAttempt === 2) return true;
  if (call.routineRunId === null) return false;
  const [run] = await sql<{ late: boolean }[]>`SELECT reason = 'late' AS late FROM routine_runs WHERE id = ${call.routineRunId}`;
  return run?.late === true;
}

/**
 * Whether the conversation may have calls (D-158): in a direct chat, its agent
 * must answer them (`Calls.check`). Throws the refusal.
 */
export type CallCheck = (conversationId: string) => Promise<void>;

/** The user schedules a call: within a week, in the future. */
export async function scheduleCall(sql: Sql, conversationId: string, at: Date, now: Date = new Date(), check?: CallCheck): Promise<Call> {
  if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime() - 60_000 || at.getTime() > now.getTime() + 7 * 86_400_000) {
    throw new ScheduleError('the time must be within the next seven days');
  }
  await check?.(conversationId);
  return sql.begin(async (tx) => {
    const [conversation] = await tx<{ archived: boolean; incognito: boolean }[]>`
      SELECT archived_at IS NOT NULL AS archived, incognito FROM conversations WHERE id = ${conversationId} AND purged_at IS NULL AND origin = 'user'`;
    if (conversation === undefined) throw new ScheduleError('no such conversation of the user');
    // An incognito conversation has no calls (D-136): a ChatError, the same 409 `incognito` as every refusal of an incognito.
    if (conversation.incognito) throw new ChatError('incognito', 'incognito');
    if (conversation.archived) throw new ScheduleError('the conversation is archived');
    const [row] = await tx.unsafe<Call[]>(
      `INSERT INTO calls (conversation_id, direction, reason, status, scheduled_at) VALUES ($1, 'out', 'scheduled', 'scheduled', $2) RETURNING ${CALL_COLUMNS}`,
      [conversationId, at],
    );
    if (row === undefined) throw new Error('INSERT INTO calls returned no row');
    await appendEvent(tx, { kind: 'call.scheduled', label: 'L0', payload: { callId: row.id, conversationId, reason: 'scheduled' } });
    return row;
  });
}

/** "Chiamami quando finisci": a call waiting for the task to end (once per task). */
export async function callWhenDone(sql: Sql, taskId: string, check?: CallCheck): Promise<Call> {
  const task = await loadTask(sql, taskId);
  if (task?.conversationId === null || task === undefined) throw new ScheduleError('no such task in a conversation');
  if (task.status === 'done' || task.status === 'failed') throw new ScheduleError('the task is already over');
  const [open] = await sql<{ incognito: boolean }[]>`
    SELECT incognito FROM conversations WHERE id = ${task.conversationId} AND archived_at IS NULL AND purged_at IS NULL AND origin = 'user'`;
  if (open === undefined) throw new ScheduleError('the conversation is archived, deleted or a system chat');
  if (open.incognito) throw new ChatError('incognito', 'incognito');
  await check?.(task.conversationId);
  return sql.begin(async (tx) => {
    const [existing] = await tx.unsafe<Call[]>(`SELECT ${CALL_COLUMNS} FROM calls WHERE task_id = $1 AND reason = 'task-done' AND status = 'scheduled'`, [taskId]);
    if (existing !== undefined) return existing;
    const [row] = await tx.unsafe<Call[]>(
      `INSERT INTO calls (conversation_id, direction, reason, task_id, status, scheduled_at) VALUES ($1, 'out', 'task-done', $2, 'scheduled', now()) RETURNING ${CALL_COLUMNS}`,
      [task.conversationId, taskId],
    );
    if (row === undefined) throw new Error('INSERT INTO calls returned no row');
    await appendEvent(tx, { kind: 'call.scheduled', label: 'L0', taskId, payload: { callId: row.id, conversationId: row.conversationId, reason: 'task-done' } });
    return row;
  });
}

/** The user cancels a scheduled call. */
export async function cancelCall(sql: Sql, callId: string): Promise<Call> {
  const call = await loadCall(sql, callId);
  if (call?.status !== 'scheduled') throw new ScheduleError('only a scheduled call can be cancelled');
  return sql.begin(async (tx) => {
    const [row] = await tx.unsafe<Call[]>(
      `UPDATE calls SET status = 'skipped', end_reason = 'cancelled', ended_at = now() WHERE id = $1 AND status = 'scheduled' RETURNING ${CALL_COLUMNS}`,
      [callId],
    );
    if (row === undefined) throw new ScheduleError('only a scheduled call can be cancelled');
    await appendEvent(tx, { kind: 'call.ended', label: 'L0', payload: { callId, conversationId: row.conversationId, status: 'skipped', reason: 'cancelled' } });
    return row;
  });
}

export class ScheduleError extends Error {
  override name = 'ScheduleError';
}
