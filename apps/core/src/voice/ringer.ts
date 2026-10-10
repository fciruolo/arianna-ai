import type { OutgoingRules } from '@arianna/config';

import type { Queryable, Sql } from '../db/client.ts';
import { ChatError } from '../conversations.ts';
import { appendEvent } from '../events.ts';
import { loadTask } from '../tasks.ts';
import { CALL_COLUMNS, CallError, loadCall, writeNote, type Call } from './calls.ts';
import { AGENT_OFF_TEXT, FAILED_TEXT, mayCall, OUTGOING_TEXT, startOfDay, type CallReason } from './outgoing.ts';

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
  /** Web Push "Arianna ti chiama", read at each ring; undefined without [voice.push]. */
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
const OPEN_CONVERSATION = "c.archived_at IS NULL AND c.purged_at IS NULL AND c.origin = 'user' AND NOT c.incognito";

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
      const changed = await tx<{ conversationId: string; reason: CallReason; failed: boolean }[]>`
        UPDATE calls SET status = 'missed', end_reason = 'no-answer', ended_at = now()
        WHERE id = ${callId} AND status = 'ringing'
        RETURNING conversation_id::text AS "conversationId", reason,
          EXISTS (SELECT FROM tasks t WHERE t.id = calls.task_id AND t.status = 'failed') AS failed`;
      for (const row of changed) {
        await appendEvent(tx, { kind: 'call.ended', label: 'L0', payload: { callId, conversationId: row.conversationId, status: 'missed', reason: 'no-answer' } });
      }
      return changed;
    });
    for (const row of rows) await writeNote(sql, row.conversationId, row.reason === 'task-done' && row.failed ? FAILED_TEXT.missed : OUTGOING_TEXT[row.reason].missed, callId);
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
      const allowed = mayCall(at, rules, count, reason);
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
        await writeNote(sql, call.conversationId, agentOff ? AGENT_OFF_TEXT : failed ? FAILED_TEXT.skipped : OUTGOING_TEXT[reason].skipped, call.id);
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
