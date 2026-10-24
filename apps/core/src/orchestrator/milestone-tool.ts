import { maxLabel } from '@arianna/policy';

import type { StoredApproval } from '../approvals.ts';
import type { Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { MILESTONE_PLAN_KIND, MILESTONE_PROPOSE, milestoneAnswerText, milestoneProposalOf, proposalAnswerOf, WAITING_MILESTONE } from '../milestone-proposals.ts';
import { answer } from './secretary.ts';
import type { Turn } from './turns.ts';

/**
 * The steps of `milestone.propose` around the user's decision (D-313,
 * seguito 2), as those of routine.propose: once the user decided in the chat,
 * the next step answers without the model, with a text written by code from
 * the approval and the milestone the decision created; a step that proposed a
 * milestone before a crash waits again while the approval is pending.
 */

/** The answer once the user decided a proposed milestone. */
export async function milestoneDecisionAnswer(sql: Sql, ctx: StepContext, decided: StoredApproval | undefined = ctx.approval): Promise<StepOutcome> {
  const proposal = decided === undefined ? undefined : milestoneProposalOf(decided);
  if (decided === undefined || proposal === undefined) return { kind: 'wait-user', reason: 'the proposed milestone is no longer readable', usage: { steps: 0 } };
  const outcome = decided.state === 'approved' ? await proposalAnswerOf(sql, decided.id, proposal) : 'failed';
  // The text carries the title and the cards of the approval: at its label, never below what the task read.
  return answer(sql, ctx.task, ctx.runId, milestoneAnswerText(proposal, decided.state, outcome), maxLabel(ctx.task.effectiveLabel, decided.label));
}

/** A step that proposed a milestone before a crash: it waits again while pending, or answers once decided. */
export async function milestoneReplay(sql: Sql, ctx: StepContext, turn: Turn): Promise<StepOutcome | undefined> {
  if (turn.answer.action !== 'call' || turn.answer.tool !== MILESTONE_PROPOSE || turn.result !== WAITING_MILESTONE) return undefined;
  const [asked] = await sql<StoredApproval[]>`
    SELECT id::text, kind, action, detail, label, state FROM approvals
    WHERE task_id = ${ctx.task.id} AND kind = ${MILESTONE_PLAN_KIND} AND (detail ->> 'step')::int = ${turn.step}
    ORDER BY requested_at DESC LIMIT 1`;
  if (asked === undefined) return undefined;
  if (asked.state === 'pending') return { kind: 'confirm', approvalId: asked.id, usage: { steps: 0 } };
  // Expired (the task was resumed): the step runs again from the model, as routine.propose's.
  if (asked.state === 'expired') return undefined;
  return milestoneDecisionAnswer(sql, ctx, asked);
}
