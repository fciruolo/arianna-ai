import type { StoredApproval } from '../approvals.ts';
import type { Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { proposedRoutineId, ROUTINE_PROPOSE, routineAnswerText, WAITING_ROUTINE } from '../routine-proposals.ts';
import { isIsoDay } from '../routine-schedule.ts';
import { answer } from './secretary.ts';
import type { Turn } from './turns.ts';

/**
 * The steps of `routine.propose` around the user's decision (D-256), as
 * those of profile.propose: once the user decided (in the chat or on the page
 * «Routine»), the next step answers without the model, with a text written
 * by code from the routine as the database holds it; a step that proposed a
 * routine before a crash waits again while the approval is pending.
 */

interface RoutineRow {
  title: string;
  days: number[];
  at: string;
  timezone: string;
  status: string;
  nextRunAt: Date | null;
  channel: string;
}

/** The answer once the user decided a proposed routine. It carries what the task read only. */
export async function routineDecisionAnswer(sql: Sql, ctx: StepContext, decided: StoredApproval | undefined = ctx.approval): Promise<StepOutcome> {
  const id = decided === undefined ? undefined : proposedRoutineId(decided);
  if (decided === undefined || id === undefined) return { kind: 'wait-user', reason: 'the proposed routine is no longer readable', usage: { steps: 0 } };
  const [row] = await sql<RoutineRow[]>`
    SELECT title, days::int[] AS days, at, timezone, status, next_run_at AS "nextRunAt", channel FROM routines WHERE id = ${id}`;
  const routine = row === undefined ? undefined : { ...row, days: row.days.filter(isIsoDay) };
  return answer(sql, ctx.task, ctx.runId, routineAnswerText(routine, decided.state), ctx.task.effectiveLabel);
}

/** A step that proposed a routine before a crash: it waits again while pending, or answers once decided. */
export async function routineReplay(sql: Sql, ctx: StepContext, turn: Turn): Promise<StepOutcome | undefined> {
  if (turn.answer.action !== 'call' || turn.answer.tool !== ROUTINE_PROPOSE || turn.result !== WAITING_ROUTINE) return undefined;
  const [asked] = await sql<StoredApproval[]>`
    SELECT id::text, kind, action, detail, state FROM approvals
    WHERE task_id = ${ctx.task.id} AND kind = 'routine' AND (detail ->> 'step')::int = ${turn.step}
    ORDER BY requested_at DESC LIMIT 1`;
  if (asked === undefined) return undefined;
  if (asked.state === 'pending') return { kind: 'confirm', approvalId: asked.id, usage: { steps: 0 } };
  // Expired (the task was resumed): the step runs again from the model, as profile.propose's.
  if (asked.state === 'expired') return undefined;
  return routineDecisionAnswer(sql, ctx, asked);
}
