import { maxLabel, type Label } from '@arianna/policy';

import { loadApproval, type StoredApproval } from '../approvals.ts';
import type { Queryable, Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { answer } from './secretary.ts';
import { applyImProposal, IM_ACTION, IM_APPROVAL_LABEL, imProposalOf, type ImProposal, type ImToolEnv } from './im-tool.ts';
import type { Turn } from './turns.ts';

/**
 * The confirmation of `im.add` (D-167, P4b): when the step read more than the
 * target IM holds, the task waits for the user to confirm the exact title in
 * the web chat (an approval of kind `im`, decided there only). Once decided,
 * the next step writes the item (approved) and the answer, here, without the
 * model: the file is written by code with what the card showed.
 */

/** The result of a call that asked the user to confirm: what the model reads if the task ever runs again. */
export const WAITING_IM = 'waiting for the user to confirm the IM item in the chat';

/** Asks the user to confirm `proposal`, as the approval of the task at `step` (written with the step's turn, in its transaction). */
export async function requestIm(tx: Queryable, options: { taskId: string; step: number; label: Label; proposal: ImProposal }): Promise<string> {
  const label = maxLabel(options.label, IM_APPROVAL_LABEL);
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${options.taskId}, 'im', ${IM_ACTION}, ${tx.json({ ...options.proposal, step: options.step })}, ${label}::privacy_label)
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO approvals returned no row');
  return row.id;
}

/** The confirmation a task asked at `step`. */
export async function imApprovalAt(sql: Queryable, taskId: string, step: number): Promise<{ id: string; state: string } | undefined> {
  const [row] = await sql<{ id: string; state: string }[]>`
    SELECT id::text, state FROM approvals
    WHERE task_id = ${taskId} AND kind = 'im' AND (detail ->> 'step')::int = ${step}
    ORDER BY requested_at DESC LIMIT 1`;
  return row;
}

/** What the chat reads once the user decided: the item written, why not, or nothing written. */
export function imAnswerText(proposal: ImProposal, state: string, applied?: ReturnType<typeof applyImProposal>): string {
  if (state !== 'approved') return `Va bene, non scrivo «${proposal.title}» nell’IM-${String(proposal.number)} di ${proposal.project}.`;
  if (applied === undefined) return `Non ho scritto «${proposal.title}» nell’IM-${String(proposal.number)} di ${proposal.project}.`;
  if (applied.kind === 'done') return `${applied.text}.`;
  if (applied.kind === 'error') return `Non ho scritto «${proposal.title}» nell’IM-${String(proposal.number)} di ${proposal.project}: ${applied.error}.`;
  return `Non ho scritto «${proposal.title}» nell’IM-${String(proposal.number)} di ${proposal.project}.`;
}

/**
 * The answer once the user decided: an approved item is written now, with the
 * title the card showed. The answer carries what the task read and the label
 * of the IM, never the approval's own L2 (a work conversation holds L1).
 */
export async function imDecisionAnswer(sql: Sql, ctx: StepContext, env: ImToolEnv | undefined, decided: StoredApproval | undefined = ctx.approval): Promise<StepOutcome> {
  const { task, runId } = ctx;
  const proposal = decided === undefined ? undefined : imProposalOf(decided);
  if (decided === undefined || proposal === undefined) return { kind: 'wait-user', reason: 'the confirmation of the IM item is no longer readable', usage: { steps: 0 } };
  const applied = decided.state === 'approved' ? applyImProposal(env, proposal) : undefined;
  const label = maxLabel(task.effectiveLabel, proposal.imLabel, applied?.kind === 'done' ? applied.label : 'L0');
  return answer(sql, task, runId, imAnswerText(proposal, decided.state, applied), label);
}

/**
 * A step that already asked a confirmation (a crash after its turn): it waits
 * again while the confirmation is pending, or answers when it was decided
 * meanwhile. Undefined for any other turn.
 */
export async function imReplay(sql: Sql, ctx: StepContext, turn: Turn, env: ImToolEnv | undefined): Promise<StepOutcome | undefined> {
  if (turn.answer.action !== 'call' || turn.answer.tool !== 'im.add' || turn.result !== WAITING_IM) return undefined;
  const asked = await imApprovalAt(sql, ctx.task.id, turn.step);
  if (asked === undefined) return undefined;
  if (asked.state === 'pending') return { kind: 'confirm', approvalId: asked.id, usage: { steps: 0 } };
  if (asked.state === 'expired') return undefined;
  return imDecisionAnswer(sql, ctx, env, await loadApproval(sql, asked.id));
}
