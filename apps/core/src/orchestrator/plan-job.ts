import { planArgs, type DelegateTarget } from '@arianna/agents';
import { LocalModelError, type LocalModel } from '@arianna/executors';
import { maxLabel, type Label } from '@arianna/policy';

import { addressedBrief } from '../addressed.ts';
import { checkPlan, requestPlan } from '../card-plans.ts';
import { PROJECT_NAME } from '../cardwall.ts';
import { CHAT_AGENT, loadConversation } from '../conversations.ts';
import type { Sql } from '../db/client.ts';
import { scheduleTask, type StepContext, type StepOutcome } from '../engine.ts';
import { appendEvent } from '../events.ts';
import { contextOf } from '../finance-mark.ts';
import { passGateway } from '../gateway.ts';
import { openReply } from '../reply.ts';
import { createTask, loadTask, type Task } from '../tasks.ts';
import { PLANNER_PROMPT, plannerBrief, plannerFor, writePlan } from './claude-plan.ts';
import type { DelegateEnv } from './delegate.ts';

/**
 * «/progetta <descrizione>» (I-13 tappa C5, D-235): the planning is a job of
 * its own on the cardwall. The message's step answers at once, without a
 * model, and puts on the wall the card «Piano: …», Arianna's, child of the
 * chat task, queued at once: it shows In corso while it works. Its step calls
 * the planner directly, never Arianna's model in between: Claude in a work
 * conversation within L1 (the project's `planner` may pick Opus, Sonnet or
 * the local model), the local model otherwise and always in a private
 * conversation. The plan is an approval of kind plan of the card: the chat
 * of «/progetta» shows it with the same buttons, and so does the card; the
 * decision closes the card in Fatto (card-plans.ts).
 */

/** The prefix of the title of a card «Piano». */
export const PLAN_CARD_PREFIX = 'Piano: ';
/** The longest description shown in the card's title. */
const TITLE_CHARS = 60;
/** The plan is one JSON object: room for 12 cards. */
const LOCAL_MAX_TOKENS = 6144;

/** The title of the card «Piano» of a description: its first line, cut. */
export function planCardTitle(brief: string): string {
  const first = brief.trim().split('\n', 1)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  const chars = Array.from(first);
  return `${PLAN_CARD_PREFIX}${chars.length <= TITLE_CHARS ? first : `${chars.slice(0, TITLE_CHARS - 1).join('')}…`}`;
}

/** What Arianna answers to «/progetta», written by the code. */
export function planRequestAnswer(cardTitle: string): string {
  return `Ho messo la pianificazione sul cardwall: card «${cardTitle}». Ti avviso quando è pronta.`;
}

/**
 * The step of the chat task of «/progetta»: the card «Piano» (once: a step
 * repeated after a crash finds it) and Arianna's line, without a model.
 */
export async function planRequestStep(sql: Sql, ctx: StepContext): Promise<StepOutcome> {
  const { task, runId } = ctx;
  if (task.conversationId === null) return { kind: 'wait-user', reason: 'a plan is asked only in a conversation', usage: { steps: 0 } };
  const [message] = await sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${task.id} AND role = 'user' ORDER BY id LIMIT 1`;
  const brief = message === undefined ? undefined : addressedBrief(message.body);
  if (brief === undefined || brief === '') return { kind: 'wait-user', reason: 'the request has no work to plan', usage: { steps: 0 } };
  const conversation = await loadConversation(sql, task.conversationId);
  const container = conversation?.workspace?.split(':')[0];
  const project = container !== undefined && PROJECT_NAME.test(container) ? container : undefined;
  // What the card holds: the user's words, at the label of the message.
  const label = maxLabel(task.label, task.effectiveLabel);
  const card = await sql.begin(async (tx) => {
    const [found] = await tx<{ id: string; title: string }[]>`SELECT id::text, title FROM tasks WHERE parent_id = ${task.id} AND planning = 'card'`;
    if (found !== undefined) return found;
    const created = await createTask(tx, {
      title: planCardTitle(brief),
      goal: brief,
      parentId: task.id,
      label,
      clearance: task.clearance,
      effectiveLabel: label,
      assignee: CHAT_AGENT,
      status: 'ready',
      ...(project === undefined ? {} : { project }),
    });
    await tx`UPDATE tasks SET planning = 'card' WHERE id = ${created.id}`;
    if (!(await scheduleTask(tx, created.id))) throw new Error(`card ${created.id} already has an active step job`);
    await appendEvent(tx, { kind: 'card.changed', taskId: created.id, label: 'L0', payload: { created: true, planning: true } });
    return { id: created.id, title: created.title };
  });
  const reply = await openReply(sql, task.id, { runId });
  const result = await reply.finish(planRequestAnswer(card.title), label);
  if (!result.stored) {
    return { kind: 'wait-user', reason: result.reason === 'blocked' ? 'the gateway blocked the answer' : 'the answer is above what the conversation may hold', usage: { steps: 0 } };
  }
  return { kind: 'answered', messageId: result.message.id, usage: { steps: 0 } };
}

export interface PlanCardDeps {
  env: DelegateEnv;
  /** The orchestrator's local model and its alias, for a plan written on this machine. */
  model: () => LocalModel;
  localAlias: string;
  localExecutor: string;
  /** Who may do a card besides the user: the agents Arianna may delegate to now. */
  delegates: readonly DelegateTarget[];
}

/**
 * The step of a card «Piano»: the plan, written by the planner and checked
 * as `task.plan`'s, becomes an approval of kind plan of the card, and the
 * card waits for the user's decision. A plan already asked: wait for it
 * again; decided before the card waited (a race of a moment): the card goes
 * to Da verificare with the approval as its evidence.
 */
export async function planCardStep(deps: PlanCardDeps, ctx: StepContext): Promise<StepOutcome> {
  const { env, delegates } = deps;
  const { sql } = env;
  const { task, step } = ctx;
  const [asked] = await sql<{ id: string; state: string }[]>`
    SELECT id::text, state FROM approvals WHERE task_id = ${task.id} AND kind = 'plan' ORDER BY requested_at DESC, id DESC LIMIT 1`;
  if (asked?.state === 'pending') return { kind: 'confirm', approvalId: asked.id, usage: { steps: 0 } };
  if (asked?.state === 'approved' || asked?.state === 'rejected') return { kind: 'done', evidence: [{ kind: 'approval', ref: asked.id }], usage: { steps: 0 } };

  const request = task.goal?.trim() ?? '';
  if (request === '') return { kind: 'wait-user', reason: 'the card has no work to plan', usage: { steps: 0 } };
  const title = task.title.startsWith(PLAN_CARD_PREFIX) ? task.title.slice(PLAN_CARD_PREFIX.length) : task.title;
  const parent = task.parentId === null ? undefined : await loadTask(sql, task.parentId);
  const label = maxLabel(task.label, task.effectiveLabel);
  const assignees = ['user', ...delegates.map((target) => target.name)];
  // Claude only in a work conversation within L1, while it can run (plannerFor); the project's key picks the model.
  const model = await plannerFor(env, parent?.conversationId ?? null, label);

  let args: Record<string, unknown>;
  let planLabel: Label;
  let usage: { steps: number; tokensIn?: number; tokensOut?: number; cost?: number };
  if (model !== undefined) {
    const written = await writePlan(env, ctx, { title, request, label, agents: delegates, model });
    const spent = { steps: 1, tokensIn: written.usage?.tokensIn ?? 0, tokensOut: written.usage?.tokensOut ?? 0, ...(written.usage?.cost === undefined ? {} : { cost: written.usage.cost }) };
    if (written.kind === 'retry') return { kind: 'retry', at: written.at, reason: written.reason, usage: spent };
    if (written.kind === 'error') return { kind: 'wait-user', reason: `the plan was not written: ${written.reason}`, usage: spent };
    args = written.args;
    planLabel = written.label;
    usage = spent;
  } else {
    const local = await localPlan(deps, ctx, task, { title, request, label, assignees });
    if (local.kind === 'wait') return { kind: 'wait-user', reason: local.reason, usage: local.usage };
    args = local.args;
    planLabel = label;
    usage = local.usage;
  }
  const checked = checkPlan(args, assignees);
  if ('error' in checked) return { kind: 'wait-user', reason: `the planner wrote an invalid plan: ${checked.error}`, usage };
  const approvalId = await sql.begin((tx) => requestPlan(tx, { taskId: task.id, step, label: planLabel, plan: checked }));
  return { kind: 'confirm', approvalId, usage };
}

type LocalPlan =
  | { kind: 'plan'; args: Record<string, unknown>; usage: { steps: number; tokensIn: number; tokensOut: number } }
  | { kind: 'wait'; reason: string; usage: { steps: number } };

/** The plan written on this machine: the planner's brief through the gateway, the cards in the schema of `task.plan`. */
async function localPlan(
  deps: PlanCardDeps,
  ctx: StepContext,
  task: Task,
  input: { title: string; request: string; label: Label; assignees: readonly string[] },
): Promise<LocalPlan> {
  const { env } = deps;
  const brief = plannerBrief({ title: input.title, request: input.request, label: input.label, agents: deps.delegates }, PLANNER_PROMPT);
  const decision = await passGateway(
    env.sql,
    brief.map((part) => ({ value: part.text, label: part.label, source: part.source })),
    // The agents' descriptions are L1 by declaration: the run reads at least that.
    contextOf(task, maxLabel(input.label, 'L1')),
    { kind: 'executor', id: deps.localExecutor, locality: 'local' },
    { taskId: task.id, runId: ctx.runId },
  );
  if (decision.decision === 'block') return { kind: 'wait', reason: `the local model cannot read this request: ${decision.reason}`, usage: { steps: 0 } };
  const [prompt = '', ...rest] = decision.texts;
  try {
    const result = await deps.model().chat({
      model: deps.localAlias,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: rest.join('\n\n') },
      ],
      schema: { name: 'task_plan', schema: planArgs(input.assignees) },
      temperature: 0,
      maxTokens: LOCAL_MAX_TOKENS,
      signal: ctx.signal,
    });
    const usage = { steps: 1, tokensIn: result.usage?.promptTokens ?? 0, tokensOut: result.usage?.completionTokens ?? 0 };
    const value = result.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'wait', reason: 'the local model gave no plan', usage };
    return { kind: 'plan', args: value as Record<string, unknown>, usage };
  } catch (error) {
    if (error instanceof LocalModelError && error.kind === 'no-endpoint') {
      return { kind: 'wait', reason: 'no local model serves the orchestrator: assign one in [roles] (pnpm arianna:init)', usage: { steps: 0 } };
    }
    if (error instanceof LocalModelError && error.kind === 'bad-response') return { kind: 'wait', reason: 'the local model gave no plan', usage: { steps: 1 } };
    // Down, stuck or cancelled: the engine retries the step, or stops it.
    throw error;
  }
}
