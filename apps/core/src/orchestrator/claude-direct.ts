import type { TurnMessage } from '@arianna/agents';
import { openConversationWorkspace, prepareEmptyWorkspace, removeWorkspace, type ClaudeModel, type PreparedWorkspace } from '@arianna/executors';
import { isAtMost, maxLabel, type Label, type Labeled } from '@arianna/policy';

import { contextOf } from '../finance-mark.ts';
import { runClaudeStep, type BriefFragment, type ClaudeStepResult } from '../claude-step.ts';
import { CLAUDE_CHAT_AGENT, DIRECT_MODELS, type Conversation, type DirectModel } from '../conversations.ts';
import type { Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import type { RunUsage } from '../runs.ts';
import { describeFailure } from '../failures.ts';
import { openReply, postActivity } from '../reply.ts';
import { addUsage, availableCloud, sessionLost, type DelegateEnv } from './delegate.ts';
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
 *
 * The same chain answers the plain chat with Claude that the user opens
 * from "+ Nuovo" (D-111, tappa B: `conversations.agent = 'claude'`, a work
 * conversation without a project): its own fixed prompt (CHAT_PROMPT), no
 * tool, and an empty folder of the conversation that stays between the
 * messages, so that the next message resumes the session of the latest
 * answer with `--resume` and only the new message leaves. When that session
 * is gone the run starts again once with the whole conversation, as a
 * system chat does at every answer.
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

/**
 * What Claude reads first in the plain chat with the user (D-111, tappa B):
 * ours, L0. A conversation of work, so nothing private should be in it; the
 * line on personal data is a reminder to the model, not a control (the
 * scanner at saving and the gateway at the exit are).
 */
export const CHAT_PROMPT = [
  "You are Claude, in a plain chat with the user inside Arianna, a personal assistant that runs on the user's own computer. The user chose to talk with you directly: Arianna is not in between.",
  '- Answer in the language of the user, as in a chat: clearly and concretely.',
  "- You have no tools, no files and no internet: you cannot run commands, read the user's computer or open links. Ask the user for what you need to know.",
  '- This is a work conversation that goes to the cloud: never ask for personal data, passwords or other credentials. For private matters, suggest a private conversation with the local model.',
].join('\n');

/** The model of the plain chat with Claude when the user chose none (D-111, tappa B). */
export const CHAT_DEFAULT_MODEL: DirectModel = 'sonnet';

/**
 * The Claude model that answers this conversation directly, or undefined when
 * Arianna answers: also when the user turned that model off in
 * `[cloud.models]` (`enabled`, D-071). A work system chat with Sonnet or
 * Opus chosen (D-064), or the plain chat with Claude the user opened (D-111,
 * tappa B), Sonnet when no model is chosen; never another user conversation.
 */
export function directModelOf(
  conversation: Pick<Conversation, 'origin' | 'mode' | 'model' | 'agent' | 'workspace'> | undefined,
  enabled: readonly string[],
): DirectModel | undefined {
  if (conversation === undefined || conversation.mode !== 'work') return undefined;
  if (conversation.origin === 'user') {
    if (!isPlainClaudeChat(conversation)) return undefined;
    const wanted = conversation.model ?? CHAT_DEFAULT_MODEL;
    return DIRECT_MODELS.find((model) => model === wanted && enabled.includes(model));
  }
  return DIRECT_MODELS.find((model) => model === conversation.model && enabled.includes(model));
}

/** The plain chat with Claude the user opened (D-111, tappa B): work, no project. */
export function isPlainClaudeChat(conversation: Pick<Conversation, 'origin' | 'mode' | 'agent' | 'workspace'> | undefined): boolean {
  return conversation?.origin === 'user' && conversation.mode === 'work' && conversation.agent === CLAUDE_CHAT_AGENT && conversation.workspace === null;
}

/**
 * The session of the plain chat to continue (D-111, tappa B): the one of the
 * run that wrote the latest answer of Claude in this conversation, after the
 * line of «Nuova sessione» when there is one. Undefined at the first message.
 */
export async function plainChatSession(sql: Sql, conversationId: string, taskId: string): Promise<string | undefined> {
  const [row] = await sql<{ sessionRef: string }[]>`
    SELECT r.session_ref AS "sessionRef" FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE t.conversation_id = ${conversationId} AND t.id <> ${taskId} AND r.executor = 'claude' AND r.status = 'ok' AND r.session_ref IS NOT NULL
        AND EXISTS (SELECT FROM messages m WHERE m.task_id = t.id AND m.role = 'assistant' AND m.model IS NOT NULL)
        AND r.started_at >= coalesce((SELECT c.direct_session_at FROM conversations c WHERE c.id = ${conversationId}), '-infinity'::timestamptz)
      ORDER BY r.started_at DESC, r.id DESC LIMIT 1`;
  return row?.sessionRef;
}

/** At most this many earlier exchanges, and characters, in a new start of the plain chat (as the fallback of the Coder, D-111b). */
export const PLAIN_HISTORY_EXCHANGES = 10;
export const PLAIN_HISTORY_CHARS = 12_000;

/**
 * What a new start of the plain chat reads (D-111, tappa B): the earlier
 * exchanges that Claude answered, oldest first, within the caps (the most
 * recent kept), then the user's message of this task. A message the gateway
 * blocked, or whose run failed, has no answer and never enters, as in the
 * fallback of the Coder (D-111b): the resumed session never saw it either.
 */
export async function plainChatHistory(sql: Sql, conversationId: string, taskId: string): Promise<Labeled<TurnMessage>[]> {
  const rows = await sql<{ id: string; taskId: string; role: 'user' | 'assistant'; body: string; label: Label }[]>`
    SELECT m.id::text, m.task_id::text AS "taskId", m.role, m.body, m.label FROM messages m
      WHERE m.conversation_id = ${conversationId} AND m.task_id IS NOT NULL AND m.task_id <> ${taskId}
        AND ((m.role = 'user') OR (m.role = 'assistant' AND m.model IS NOT NULL))
        AND EXISTS (SELECT FROM messages a WHERE a.task_id = m.task_id AND a.role = 'assistant' AND a.model IS NOT NULL)
        AND m.ts >= coalesce((SELECT c.direct_session_at FROM conversations c WHERE c.id = ${conversationId}), '-infinity'::timestamptz)
      ORDER BY m.id`;
  const byTask = new Map<string, Labeled<TurnMessage>[]>();
  for (const row of rows) {
    const exchange = byTask.get(row.taskId) ?? [];
    exchange.push({ value: { role: row.role, content: row.body }, label: row.label, source: `message:${row.id}` });
    byTask.set(row.taskId, exchange);
  }
  const kept: Labeled<TurnMessage>[][] = [];
  let chars = 0;
  for (const exchange of [...byTask.values()].reverse()) {
    const size = exchange.reduce((sum, part) => sum + part.value.content.length, 0);
    if (kept.length >= PLAIN_HISTORY_EXCHANGES || chars + size > PLAIN_HISTORY_CHARS) break;
    kept.push(exchange);
    chars += size;
  }
  const current = await messageOf(sql, taskId);
  const now: Labeled<TurnMessage>[] = current === undefined ? [] : [{ value: { role: 'user', content: current.text }, label: current.label, source: current.source }];
  return [...kept.reverse().flat(), ...now];
}

/** The user's message of the task: the only text that leaves when the session is resumed. */
async function messageOf(sql: Sql, taskId: string): Promise<BriefFragment | undefined> {
  const [row] = await sql<{ id: string; body: string; label: Label }[]>`
    SELECT id::text, body, label FROM messages WHERE task_id = ${taskId} AND role = 'user' ORDER BY id LIMIT 1`;
  return row === undefined ? undefined : { text: row.body, label: row.label, source: `message:${row.id}` };
}

/** Claude can answer now: enabled in the configuration and runnable on this machine. */
export function canAnswerDirectly(env: DelegateEnv): boolean {
  return availableCloud(env).includes('claude');
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
 * Same-role messages are not joined here (D-092): the brief is one prompt
 * of `Role:` fragments, not a chat template that requires alternation.
 */
export async function runDirect(
  env: DelegateEnv,
  ctx: StepContext,
  model: DirectModel,
  history: readonly Labeled<TurnMessage>[],
  /** The plain chat with Claude (D-111, tappa B): its prompt, its folder, its session. */
  plain = false,
): Promise<StepOutcome> {
  const { task, step, runId } = ctx;
  const { sql } = env;
  const claude = env.claude;
  if (claude === undefined) throw new Error('claude is not available');
  if (task.conversationId === null) return { kind: 'wait-user', reason: 'Claude answers only in a system chat' };
  const conversationId = task.conversationId;

  const label: Label = maxLabel(task.effectiveLabel, ...history.map((part) => part.label));
  if (!isAtMost(label, 'L1')) {
    return { kind: 'wait-user', reason: plain ? `the conversation holds ${label}: Claude cannot read it` : `the system chat holds ${label}: Claude cannot read it, choose Arianna to answer` };
  }

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
  if (ctx.resume !== undefined && !plain) await removeWorkspace({ data, runId: ctx.resume.runId }).catch(() => undefined);
  // The plain chat keeps one folder for the whole conversation: Claude Code finds its sessions per folder.
  const workspace: PreparedWorkspace = plain ? await openConversationWorkspace({ data, conversationId }) : await prepareEmptyWorkspace(folder);
  const prompt = plain ? (env.chatPrompt ?? CHAT_PROMPT) : env.directPrompt;
  const session = plain ? await plainChatSession(sql, conversationId, task.id) : undefined;
  const message = session === undefined ? undefined : await messageOf(sql, task.id);
  // A new start of the plain chat reads only the exchanges Claude answered (plainChatHistory); a system chat the whole chat.
  const opening = async (): Promise<BriefFragment[]> => directBrief(plain ? await plainChatHistory(sql, conversationId, task.id) : history, prompt);
  /** What the failed resume used: it counts even when the new start is blocked. */
  let lost: RunUsage | undefined;
  try {
    await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind: 'thinking', detail: `claude/${model}` }).catch(() => undefined);
    const reply = await openReply(sql, task.id, { runId, model });
    let streamed = 0;
    // A system chat never resumes: the folder of an interrupted run is gone, and the brief carries the whole conversation.
    // The plain chat resumes the session of its latest answer only, by name: never the one of an interrupted run.
    const fresh: StepContext = { task, step, runId, signal: ctx.signal, setSessionRef: (ref) => ctx.setSessionRef(ref), ...(ctx.approval === undefined ? {} : { approval: ctx.approval }) };
    const attempt = (brief: readonly BriefFragment[], sessionRef: string | null): Promise<ClaudeStepResult> =>
      runClaudeStep(sql, claude, fresh, {
        // A resumed session holds what the conversation held before: within L1 too, checked above.
        context: contextOf(task, label),
        brief,
        workspace,
        model: model satisfies ClaudeModel,
        tools: [],
        maxTurns: MAX_TURNS,
        timeoutMs: TIMEOUT_MS,
        summary: plain ? `plain chat answered by claude/${model}` : `system chat answered by claude/${model}`,
        sessionRef,
        onEvent: async (event) => {
          if (event.type !== 'text') return;
          await reply.delta(`${streamed === 0 ? '' : '\n\n'}${event.text}`);
          streamed += 1;
        },
      });
    // Resumed: only the new message of the user leaves; the prompt and what came before are already in the session.
    let result: ClaudeStepResult = session !== undefined && message !== undefined ? await attempt([message], session) : await attempt(await opening(), null);
    // The session is gone (another machine, expired, refused): one new start with the exchanges answered so far.
    if (session !== undefined && result.kind === 'failed' && sessionLost(result.error)) {
      lost = result.usage;
      streamed = 0;
      result = await attempt(await opening(), null);
      if (result.kind !== 'blocked') result = { ...result, usage: addUsage(lost, result.usage) };
    }
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
        return { kind: 'wait-user', reason: `the gateway refused the conversation for Claude: ${result.decision.reason}`, ...(lost === undefined ? {} : { usage: lost }) };
      case 'quota': {
        const at = result.resetsAt !== undefined && result.resetsAt.getTime() > Date.now() ? result.resetsAt : new Date(Date.now() + UNKNOWN_RESET_MS);
        await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind: 'wait', detail: `claude · ${at.toISOString()}` }).catch(() => undefined);
        return { kind: 'retry', at, reason: result.overage ? 'claude is on paid extra usage' : 'claude is out of quota', usage: result.usage };
      }
      case 'failed':
        return { kind: 'failed', reason: result.reason, failure: describeFailure(result.error), usage: result.usage };
    }
    const unknownKind: never = result;
    throw new Error(`unknown result of a direct answer: ${JSON.stringify(unknownKind)}`);
  } finally {
    // The folder of the plain chat stays for the next message; it goes with the conversation (chatFolderGone in main.ts).
    if (!plain) await removeWorkspace(folder).catch(() => undefined);
  }
}
