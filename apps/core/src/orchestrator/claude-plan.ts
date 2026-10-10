import { MAX_PLAN_CARDS, MIN_PLAN_CARDS, type DelegateTarget } from '@arianna/agents';
import { enabledCloudModels } from '@arianna/config';
import { prepareEmptyWorkspace, removeWorkspace, type ClaudeModel } from '@arianna/executors';
import { createContext, isAtMost, maxLabel, type Label } from '@arianna/policy';

import { runClaudeStep, type BriefFragment } from '../claude-step.ts';
import { DIRECT_MODELS, loadConversation, type Conversation } from '../conversations.ts';
import type { StepContext } from '../engine.ts';
import { postActivity } from '../reply.ts';
import type { RunUsage } from '../runs.ts';
import { canAnswerDirectly } from './claude-direct.ts';
import type { DelegateEnv } from './delegate.ts';
import { budgetOf } from './routing.ts';

/**
 * Claude writes the cards of `task.plan` in a work conversation (D-164). The
 * local model sees when a request is a large piece of work, but it does not
 * split a request said in a few words ("mi serve una landing"): there it
 * hands over only the title and the request, and Claude answers with the
 * cards as JSON. The code checks them as it checks the local model's
 * (card-plans.ts), and the user approves the plan in the chat as before.
 *
 * What Claude reads: the request the local model wrote, the title and who may
 * do a card (the user and the agents, with their descriptions, L1 by
 * declaration). Never the conversation itself. Everything passes the gateway
 * towards the cloud and is logged in gateway_log. No tool, an empty working
 * folder removed after the run, no session saved.
 */

/** One answer: the plan is one JSON object. */
const TIMEOUT_MS = 3 * 60_000;
const MAX_TURNS = 3;
/** When the binary gave no reset time for a quota refusal. */
const UNKNOWN_RESET_MS = 60 * 60_000;

/** What Claude reads before the request. */
export const PLANNER_PROMPT = [
  'You are the planner of Arianna, a personal assistant that runs on the user\'s own computer. The user asked for a piece of work in a work conversation; split it into cards that the user approves before anything starts.',
  `- Write ${String(MIN_PLAN_CARDS)} to ${String(MAX_PLAN_CARDS)} cards, in the order they are done. Each card is one piece of work for one assignee: a short title and a goal of one or two sentences, in Italian, concrete enough that the assignee can start without asking.`,
  '- "assignee" is "user" or one of the agents listed below, by its name: give an agent only what its description says it does; give the user what only the user can do (texts they said they write, choices, contents, accounts, approvals). Never invent an agent.',
  '- "blocked_by" lists the numbers of earlier cards this one must wait for (1 is the first card; [] when it waits for none). Never a later card.',
  '- Do not add cards nobody asked for (no deploy, marketing or analytics unless requested). Keep the details the user gave.',
  '- You have no tools and no files: you cannot look at the project. Write the plan from the request alone.',
  '- Answer with exactly one JSON object and nothing else, no code fence: {"title": "...", "cards": [{"title": "...", "goal": "...", "assignee": "...", "blocked_by": []}]}.',
].join('\n');

/**
 * The Claude model that writes the cards in this conversation, or undefined
 * when the local model writes them: only in a work conversation, while Claude
 * can run. The model the user chose for the conversation when it is a Claude
 * one, else Sonnet, else Opus, among those switched on (D-071).
 */
export function plannerModelOf(conversation: Pick<Conversation, 'mode' | 'model'> | undefined, enabled: readonly string[]): ClaudeModel | undefined {
  if (conversation?.mode !== 'work') return undefined;
  const on = DIRECT_MODELS.filter((model) => enabled.includes(model));
  return on.find((model) => model === conversation.model) ?? on[0];
}

/** The planner of a task's step: Claude in a work conversation within L1, the local model otherwise. */
export async function plannerFor(env: DelegateEnv, conversationId: string | null, label: Label): Promise<ClaudeModel | undefined> {
  if (conversationId === null || !isAtMost(label, 'L1') || !canAnswerDirectly(env)) return undefined;
  return plannerModelOf(await loadConversation(env.sql, conversationId), enabledCloudModels(env.settings().cloud));
}

export type WrittenPlan =
  /** Claude's cards, to check like the local model's; `label` is the highest of what went out and what came back. */
  | { kind: 'plan'; args: Record<string, unknown>; label: Label; usage: RunUsage }
  /** No plan: the reason is for the local model, as the result of its call. */
  | { kind: 'error'; reason: string; usage?: RunUsage }
  /** Claude is out of quota: the step runs again then. */
  | { kind: 'retry'; at: Date; reason: string; usage?: RunUsage };

export interface PlanRequest {
  title: string;
  request: string;
  /** What the step has read: the request carries it. */
  label: Label;
  /** The agents a card may go to, besides the user. */
  agents: readonly DelegateTarget[];
  model: ClaudeModel;
}

/** The brief: the prompt, the agents, then the request with the label of what the step has read. */
export function plannerBrief(input: Pick<PlanRequest, 'title' | 'request' | 'label' | 'agents'>, prompt: string = PLANNER_PROMPT): BriefFragment[] {
  const agents = input.agents.length === 0 ? 'none: every card is the user\'s' : input.agents.map((agent) => `- ${agent.name}: ${agent.description}`).join('\n');
  return [
    { text: prompt, label: 'L0', source: 'prompt:claude-plan' },
    { text: `Agents that can work now:\n${agents}`, label: 'L1', source: 'agents:delegates' },
    { text: `Title: ${input.title}\nRequest:\n${input.request}`, label: input.label, source: 'plan:request' },
  ];
}

/**
 * The plan in Claude's answer: the one JSON object it wrote (a code fence
 * around it is tolerated), or undefined. Checked afterwards by checkPlan.
 */
export function planInAnswer(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Claude writes the cards of one request (D-164). */
export async function writePlan(env: DelegateEnv, ctx: StepContext, input: PlanRequest): Promise<WrittenPlan> {
  const { task, step, runId } = ctx;
  const { sql } = env;
  const claude = env.claude;
  if (claude === undefined) return { kind: 'error', reason: 'the planner is not available now' };
  if (!isAtMost(input.label, 'L1')) return { kind: 'error', reason: `the request holds ${input.label}: the planner cannot read it` };
  const conversationId = task.conversationId;
  const activity = async (kind: 'thinking' | 'wait', detail: string) => {
    if (conversationId === null) return;
    await postActivity(sql, { conversationId, taskId: task.id, step, kind, detail }).catch(() => undefined);
  };

  const block = (await budgetOf(sql)).blocked.find((entry) => entry.executor === 'claude' && (entry.model === undefined || entry.model === input.model));
  if (block !== undefined) {
    const at = block.until === undefined ? new Date(Date.now() + UNKNOWN_RESET_MS) : new Date(block.until);
    await activity('wait', `claude · ${at.toISOString()}`);
    return { kind: 'retry', at, reason: 'claude is out of quota' };
  }

  const data = env.settings().paths.data;
  const folder = { data, runId };
  if (ctx.resume !== undefined) await removeWorkspace({ data, runId: ctx.resume.runId }).catch(() => undefined);
  const workspace = await prepareEmptyWorkspace(folder);
  try {
    await activity('thinking', `claude/${input.model}`);
    // Never resumed, nothing saved: the brief is the whole request.
    const fresh: StepContext = { task, step, runId, signal: ctx.signal, setSessionRef: () => Promise.resolve() };
    const result = await runClaudeStep(sql, claude, fresh, {
      // The agents' descriptions are L1 by declaration: the run reads at least that.
      context: createContext(task.clearance, maxLabel(input.label, 'L1')),
      brief: plannerBrief(input, env.plannerPrompt),
      workspace,
      model: input.model,
      tools: [],
      maxTurns: MAX_TURNS,
      timeoutMs: TIMEOUT_MS,
      summary: `cards of a plan written by claude/${input.model}`,
      sessionRef: null,
      persistSession: false,
    });
    switch (result.kind) {
      case 'answer': {
        const args = planInAnswer(result.result.text);
        if (args === undefined) return { kind: 'error', reason: 'the planner gave no plan', usage: result.usage };
        return { kind: 'plan', args, label: maxLabel(input.label, 'L1', result.result.label), usage: result.usage };
      }
      case 'blocked':
        return { kind: 'error', reason: `the gateway kept the request from the planner: ${result.decision.reason}` };
      case 'quota': {
        const at = result.resetsAt !== undefined && result.resetsAt.getTime() > Date.now() ? result.resetsAt : new Date(Date.now() + UNKNOWN_RESET_MS);
        await activity('wait', `claude · ${at.toISOString()}`);
        return { kind: 'retry', at, reason: result.overage ? 'claude is on paid extra usage' : 'claude is out of quota', usage: result.usage };
      }
      case 'failed':
        return { kind: 'error', reason: `the planner failed (${result.reason})`, usage: result.usage };
    }
  } finally {
    await removeWorkspace(folder).catch(() => undefined);
  }
}
