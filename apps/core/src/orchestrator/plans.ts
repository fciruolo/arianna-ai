import { maxLabel, type Label } from '@arianna/policy';

import { loadApproval, type StoredApproval } from '../approvals.ts';
import { checkPlan, planAnswerText, planApprovalAt, planOf, requestPlan } from '../card-plans.ts';
import type { Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { openReply, type ActivityKind } from '../reply.ts';
import { recordTurn, type NewTurn, type Turn } from './turns.ts';

/**
 * `task.plan` for the orchestrator (I-13 tappa C3, D-159): the model proposes
 * cards, the code checks them and writes an approval of kind `plan` with the
 * step's turn, and the task waits for the user. Once decided, the answer is
 * written here from the approval, without the model: the cards themselves are
 * created with the decision (card-plans.ts, engine.ts).
 */
export const PLAN_TOOL = 'task.plan';

/** The result of the call that asked the user: what the model reads if the task ever runs again. */
export const WAITING_PLAN = 'waiting for the user to approve the plan in the chat';

export interface PlanCall {
  turn: Omit<NewTurn, 'label' | 'result' | 'messageId'>;
  /** What the step has read: the plan carries it. */
  label: Label;
  args: Record<string, unknown>;
  usage: { steps: number; tokensIn: number; tokensOut: number };
  /** Who may do a card: the user and the agents that can work now. */
  assignees: readonly string[];
}

export async function runPlanTool(sql: Sql, ctx: StepContext, call: PlanCall, show: (kind: ActivityKind, detail?: string) => Promise<void>): Promise<StepOutcome> {
  const { task, step } = ctx;
  const { turn, label, usage } = call;
  const checked = task.conversationId === null ? { error: 'a plan is proposed only in a conversation, where the user approves it' } : checkPlan(call.args, call.assignees);
  if ('error' in checked) {
    await recordTurn(sql, { ...turn, label, result: `error: ${PLAN_TOOL}: ${checked.error}` });
    // The activity line names the tool only: the error may quote the plan.
    await show('error', `${PLAN_TOOL}: not done, the model reads why`);
    return { kind: 'continue', usage };
  }
  // The turn and the approval together: after a crash the step finds both, or neither.
  const approvalId = await sql.begin(async (tx) => {
    await recordTurn(tx, { ...turn, label, result: WAITING_PLAN });
    return requestPlan(tx, { taskId: task.id, step, label, plan: checked });
  });
  // The number of cards only: their titles stay in the approval.
  await show('card', `${PLAN_TOOL} · ${String(checked.cards.length)}`);
  return { kind: 'confirm', approvalId, usage };
}

/** The answer once the user decided a plan: written here, from the approval, without the model. */
export async function planDecisionAnswer(sql: Sql, ctx: StepContext, decided: StoredApproval | undefined = ctx.approval): Promise<StepOutcome> {
  const { task, runId } = ctx;
  const plan = decided === undefined ? undefined : planOf(decided);
  if (decided === undefined || plan === undefined) return { kind: 'wait-user', reason: 'the plan is no longer readable', usage: { steps: 0 } };
  if (task.conversationId === null) return { kind: 'wait-user', reason: 'a plan is answered only in its conversation', usage: { steps: 0 } };
  const label = maxLabel(task.effectiveLabel, decided.label);
  const reply = await openReply(sql, task.id, { runId });
  const result = await reply.finish(planAnswerText(plan, decided.state), label);
  if (!result.stored) {
    return {
      kind: 'wait-user',
      reason: result.reason === 'blocked' ? 'the gateway blocked the answer' : 'the answer is above what the conversation may hold',
      usage: { steps: 0 },
    };
  }
  return { kind: 'answered', messageId: result.message.id, usage: { steps: 0 } };
}

/**
 * A step that already proposed a plan (a crash after its turn): it waits
 * again while the plan is pending, or answers when it was decided meanwhile.
 * Undefined for any other turn.
 */
export async function planReplay(sql: Sql, ctx: StepContext, turn: Turn): Promise<StepOutcome | undefined> {
  if (turn.answer.action !== 'call' || turn.answer.tool !== PLAN_TOOL || turn.result !== WAITING_PLAN) return undefined;
  const asked = await planApprovalAt(sql, ctx.task.id, turn.step);
  if (asked === undefined) return undefined;
  if (asked.state === 'pending') return { kind: 'confirm', approvalId: asked.id, usage: { steps: 0 } };
  if (asked.state === 'expired') return undefined;
  return planDecisionAnswer(sql, ctx, await loadApproval(sql, asked.id));
}
