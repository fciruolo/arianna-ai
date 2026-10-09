import type { ToolId } from '@arianna/agents';
import { isAtMost, maxLabel, type Label } from '@arianna/policy';

import { loadApproval, type StoredApproval } from '../approvals.ts';
import { dayText, localDay, parseRange } from '../commitment-dates.ts';
import {
  COMMITMENT_LABEL,
  commitmentApprovalAt,
  commitmentLine,
  decisionText,
  findCommitment,
  lateCommitments,
  listCommitments,
  listText,
  proposalOf,
  proposeAdd,
  requestCommitment,
  type CommitmentProposal,
} from '../commitments.ts';
import type { Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { openReply, type ActivityKind } from '../reply.ts';
import type { Task } from '../tasks.ts';
import { recordTurn, type NewTurn, type Turn } from './turns.ts';

/**
 * The tools of the secretary (I-12, D-144), offered only in the secretary's
 * conversation. None of them lets the model write what the user reads about
 * a commitment: `commitment.list` writes the list in the chat from SQL and
 * ends the step; `commitment.add` and `commitment.done` compute the day or
 * find the commitment here, and the task waits for the user's confirmation
 * (an approval of kind `commitment`); once decided, the answer is written
 * here too (`decisionAnswer`). Everything stays at L2 at least, on this machine.
 */
export const SECRETARY_TOOLS = ['commitment.add', 'commitment.list', 'commitment.done'] as const satisfies readonly ToolId[];
export type SecretaryTool = (typeof SECRETARY_TOOLS)[number];

export function isSecretaryTool(tool: ToolId): tool is SecretaryTool {
  return (SECRETARY_TOOLS as readonly string[]).includes(tool);
}

/** The result of a call that asked the user to confirm: what the model reads if the task ever runs again. */
export const WAITING_CONFIRMATION = 'waiting for the user to confirm it in the chat';
const UNDELIVERED = 'error: the answer was not delivered';

export interface SecretaryCall {
  turn: Omit<NewTurn, 'label' | 'result' | 'messageId'>;
  /** What the step has read. */
  label: Label;
  tool: SecretaryTool;
  args: Record<string, unknown>;
  usage: { steps: number; tokensIn: number; tokensOut: number };
}

/** Writes `text` in the chat as the task's answer, written by the code. */
async function answer(sql: Sql, task: Task, runId: string, text: string, label: Label, record?: Omit<NewTurn, 'label' | 'result' | 'messageId'>, usage?: SecretaryCall['usage']): Promise<StepOutcome> {
  const extra = usage === undefined ? { usage: { steps: 0 } } : { usage };
  if (task.conversationId === null) return { kind: 'wait-user', reason: 'the secretary answers only in its conversation', ...extra };
  const reply = await openReply(sql, task.id, { runId });
  const result = await reply.finish(text, label);
  if (!result.stored) {
    if (record !== undefined) await recordTurn(sql, { ...record, label, result: `${UNDELIVERED} (${result.reason})` });
    return { kind: 'wait-user', reason: result.reason === 'blocked' ? 'the gateway blocked the answer' : 'the answer is above what the conversation may hold', ...extra };
  }
  if (record !== undefined) await recordTurn(sql, { ...record, label, messageId: result.message.id });
  return { kind: 'answered', messageId: result.message.id, ...extra };
}

export async function runSecretaryTool(sql: Sql, ctx: StepContext, call: SecretaryCall, show: (kind: ActivityKind, detail?: string) => Promise<void>): Promise<StepOutcome> {
  const { task, step, runId } = ctx;
  const { turn, tool, args, usage } = call;
  // A commitment is L2 at least: never in a task that may not hold it (the tools are offered only in the secretary's private conversation).
  const label = maxLabel(call.label, COMMITMENT_LABEL);
  const fail = async (error: string, errorLabel: Label = call.label): Promise<StepOutcome> => {
    await recordTurn(sql, { ...turn, label: errorLabel, result: `error: ${tool}: ${error}` });
    // The activity line names the tool only: the error may quote the user's words.
    await show('error', `${tool}: not done, the model reads why`);
    return { kind: 'continue', usage };
  };
  if (!isAtMost(COMMITMENT_LABEL, task.clearance)) return fail('the commitments are private: only the secretary’s conversation reads them');
  const today = localDay();

  if (tool === 'commitment.list') {
    const words = typeof args.day === 'string' ? args.day.trim() : '';
    const range = words === '' ? undefined : parseRange(words, today);
    if (words !== '' && range === undefined) {
      return fail(
        `the day '${words}' is not one the core can compute (today is ${dayText(today)}): call commitment.list again with words it reads ("oggi", "domani", a weekday, "questa settimana", "la settimana prossima", "i prossimi 7 giorni", "questo mese", "il mese prossimo") or without "day" for every open commitment; never ask the user today's date`,
      );
    }
    const items = await listCommitments(sql, range);
    const late = range !== undefined && range.from <= today && today <= range.to ? await lateCommitments(sql, today) : [];
    await show('tool', `${tool}${range === undefined ? '' : ` · ${range.from}`}`);
    // The list carries the highest label of what it shows.
    const listed = maxLabel(label, ...items.map((item) => item.label), ...late.map((item) => item.label));
    return answer(sql, task, runId, listText(items, range, today, late), listed, turn, usage);
  }

  let proposal: CommitmentProposal;
  if (tool === 'commitment.add') {
    const proposed = proposeAdd(args, today);
    if ('error' in proposed) return fail(proposed.error);
    proposal = proposed;
  } else {
    const which = typeof args.which === 'string' ? args.which : '';
    const open = await listCommitments(sql);
    if (open.length === 0) return fail('there are no open commitments: tell the user');
    const found = findCommitment(open, which);
    if ('none' in found) return fail(`no open commitment matches '${which}'. The open ones:\n${open.map(commitmentLine).join('\n')}\nCall again with the id of the one the user means, or ask the user.`, label);
    if ('several' in found) return fail(`more than one open commitment matches '${which}':\n${found.several.map(commitmentLine).join('\n')}\nCall again with the id of the one the user means, or ask the user.`, label);
    const item = found.found;
    proposal = { op: 'done', commitmentId: item.id, text: item.body, day: item.day, time: item.time, dayText: dayText(item.day) };
  }
  // The turn and the confirmation together: after a crash the step finds both, or neither.
  const approvalId = await sql.begin(async (tx) => {
    await recordTurn(tx, { ...turn, label, result: WAITING_CONFIRMATION });
    return requestCommitment(tx, { taskId: task.id, step, label, proposal });
  });
  // The day only: the text of a commitment never goes in an activity line.
  await show('tool', `${tool} · ${proposal.day}`);
  return { kind: 'confirm', approvalId, usage };
}

/** The answer once the user decided a confirmation: written here, from the approval, without the model. */
export async function decisionAnswer(sql: Sql, ctx: StepContext, decided: StoredApproval | undefined = ctx.approval): Promise<StepOutcome> {
  const { task, runId } = ctx;
  const proposal = decided === undefined ? undefined : proposalOf(decided);
  if (decided === undefined || proposal === undefined) return { kind: 'wait-user', reason: 'the confirmation of the secretary is no longer readable', usage: { steps: 0 } };
  const label = maxLabel(task.effectiveLabel, decided.label, COMMITMENT_LABEL);
  return answer(sql, task, runId, decisionText(proposal, decided.state), label);
}

/**
 * A step that already asked a confirmation (a crash after its turn): it waits
 * again while the confirmation is pending, or answers when it was decided
 * meanwhile. Undefined for any other turn.
 */
export async function secretaryReplay(sql: Sql, ctx: StepContext, turn: Turn): Promise<StepOutcome | undefined> {
  if (turn.answer.action !== 'call' || !isSecretaryTool(turn.answer.tool) || turn.result !== WAITING_CONFIRMATION) return undefined;
  const asked = await commitmentApprovalAt(sql, ctx.task.id, turn.step);
  if (asked === undefined) return undefined;
  if (asked.state === 'pending') return { kind: 'confirm', approvalId: asked.id, usage: { steps: 0 } };
  if (asked.state === 'expired') return undefined;
  return decisionAnswer(sql, ctx, await loadApproval(sql, asked.id));
}
