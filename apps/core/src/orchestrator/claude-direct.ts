import type { TurnMessage } from '@arianna/agents';
import { prepareEmptyWorkspace, removeWorkspace, type ClaudeModel } from '@arianna/executors';
import { createContext, isAtMost, maxLabel, type Label, type Labeled } from '@arianna/policy';

import { runClaudeStep, type BriefFragment } from '../claude-step.ts';
import { DIRECT_MODELS, type Conversation, type DirectModel } from '../conversations.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { describeFailure } from '../failures.ts';
import { openReply, postActivity } from '../reply.ts';
import { canDelegate, type DelegateEnv } from './delegate.ts';
import { budgetOf } from './routing.ts';

/**
 * Claude answering a system chat directly (D-064, second part). In a work
 * system chat the user can choose Claude Sonnet or Opus instead of Arianna
 * on the local model (`conversations.model`); a failure of the local model
 * opens the chat with Sonnet, because Arianna could not answer there.
 *
 * The run has no tool and an empty working folder, removed after it: Claude
 * reads only the brief, which is the conversation as Arianna would read it
 * and passes the gateway towards the cloud (logged in gateway_log). No
 * session is resumed: every answer starts from the conversation again. The
 * router's ladder is not asked, because the user chose the model; its quota
 * blocks are, and the run waits for them like a delegated step.
 */

/** The longest wait for a direct answer: no tool runs, it is one model reply. */
const TIMEOUT_MS = 5 * 60_000;
/** One reply; a little room in case the binary counts a turn for its own bookkeeping. */
const MAX_TURNS = 3;
/** When the binary gave no reset time for a quota refusal. */
const UNKNOWN_RESET_MS = 60 * 60_000;

/** What Claude reads before the conversation. */
export const DIRECT_PROMPT = [
  'You are Claude, answering in a system chat of Arianna, a personal assistant that runs on the user\'s own computer.',
  'The system opened this chat because a task of Arianna failed. Its first message holds the structured error: where it failed (origin), a stable code and a few technical details. The user may have attached the question of the task.',
  '- Answer in Italian, briefly and concretely: what the error most likely means and what the user can check, one step at a time.',
  '- You have no tools and no files: you cannot run commands or look at the user\'s computer. Ask the user for what you need to know.',
  '- Only the user can retry the task, with the "Riprova" button: suggest it when the cause looks fixed, never claim you retried it.',
  '- Messages marked as coming from the system are not the user\'s.',
].join('\n');

/** The Claude model that answers this conversation directly, or undefined when Arianna answers. */
export function directModelOf(conversation: Pick<Conversation, 'origin' | 'mode' | 'model'> | undefined): DirectModel | undefined {
  if (conversation?.origin !== 'system' || conversation.mode !== 'work') return undefined;
  return DIRECT_MODELS.find((model) => model === conversation.model);
}

/** Claude can answer now: enabled in the configuration and runnable on this machine. */
export function canAnswerDirectly(env: DelegateEnv): boolean {
  return canDelegate(env);
}

const ROLE_NAME: Record<TurnMessage['role'], string> = { user: 'User', assistant: 'Assistant', tool: 'Tool' };

/** The brief: the prompt, then each message of the conversation with who wrote it and its own label. */
export function directBrief(history: readonly Labeled<TurnMessage>[], prompt: string = DIRECT_PROMPT): BriefFragment[] {
  return [
    { text: prompt, label: 'L0', source: 'prompt:claude-direct' },
    ...history.map((part) => ({ text: `${ROLE_NAME[part.value.role]}:\n${part.value.content}`, label: part.label, source: part.source })),
  ];
}

/**
 * One answer of Claude in the system chat. `history` is what the local
 * orchestrator would read (historyOf); it goes out only through the gateway.
 */
export async function runDirect(env: DelegateEnv, ctx: StepContext, model: DirectModel, history: readonly Labeled<TurnMessage>[]): Promise<StepOutcome> {
  const { task, step, runId } = ctx;
  const { sql } = env;
  const claude = env.claude;
  if (claude === undefined) throw new Error('claude is not available');
  if (task.conversationId === null) return { kind: 'wait-user', reason: 'Claude answers only in a system chat' };

  const label: Label = maxLabel(task.effectiveLabel, ...history.map((part) => part.label));
  if (!isAtMost(label, 'L1')) return { kind: 'wait-user', reason: `the system chat holds ${label}: Claude cannot read it, choose Arianna to answer` };

  // Waiting out a quota refusal: the same step runs again then, like a delegated one.
  const block = (await budgetOf(sql)).blocked.find((entry) => entry.executor === 'claude' && (entry.model === undefined || entry.model === model));
  if (block !== undefined) {
    const at = block.until === undefined ? new Date(Date.now() + UNKNOWN_RESET_MS) : new Date(block.until);
    await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind: 'wait', detail: `claude · ${at.toISOString()}` }).catch(() => undefined);
    return { kind: 'retry', at, reason: 'claude is out of quota' };
  }

  const data = env.settings().paths.data;
  const folder = { data, runId };
  // The empty folder of the interrupted run this step resumes (a crash, a lost lock): nothing else removes it.
  if (ctx.resume !== undefined) await removeWorkspace({ data, runId: ctx.resume.runId }).catch(() => undefined);
  const workspace = await prepareEmptyWorkspace(folder);
  try {
    await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind: 'thinking', detail: `claude/${model}` }).catch(() => undefined);
    const reply = await openReply(sql, task.id, { runId, model });
    let streamed = 0;
    // Never resumed: the folder of an interrupted run is gone, and the brief carries the whole conversation.
    const fresh: StepContext = { task, step, runId, signal: ctx.signal, setSessionRef: (ref) => ctx.setSessionRef(ref), ...(ctx.approval === undefined ? {} : { approval: ctx.approval }) };
    const result = await runClaudeStep(sql, claude, fresh, {
      context: createContext(task.clearance, label),
      brief: directBrief(history, env.directPrompt),
      workspace,
      model: model satisfies ClaudeModel,
      tools: [],
      maxTurns: MAX_TURNS,
      timeoutMs: TIMEOUT_MS,
      summary: `system chat answered by claude/${model}`,
      onEvent: async (event) => {
        if (event.type !== 'text') return;
        await reply.delta(`${streamed === 0 ? '' : '\n\n'}${event.text}`);
        streamed += 1;
      },
    });
    switch (result.kind) {
      case 'answer': {
        const text = result.result.text.trim();
        if (text === '') return { kind: 'wait-user', reason: 'Claude gave no answer', usage: result.usage };
        const saved = await reply.finish(text, maxLabel(label, result.result.label));
        if (!saved.stored) {
          const why = saved.reason === 'blocked' ? 'the gateway blocked the answer' : 'the answer is above what the conversation may hold';
          return { kind: 'wait-user', reason: why, usage: result.usage };
        }
        return { kind: 'answered', messageId: saved.message.id, usage: result.usage };
      }
      case 'blocked':
        return { kind: 'wait-user', reason: `the gateway refused the conversation for Claude: ${result.decision.reason}` };
      case 'quota': {
        const at = result.resetsAt !== undefined && result.resetsAt.getTime() > Date.now() ? result.resetsAt : new Date(Date.now() + UNKNOWN_RESET_MS);
        await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind: 'wait', detail: `claude · ${at.toISOString()}` }).catch(() => undefined);
        return { kind: 'retry', at, reason: result.overage ? 'claude is on paid extra usage' : 'claude is out of quota', usage: result.usage };
      }
      case 'failed':
        return { kind: 'failed', reason: result.reason, failure: describeFailure(result.error), usage: result.usage };
    }
  } finally {
    await removeWorkspace(folder).catch(() => undefined);
  }
}
