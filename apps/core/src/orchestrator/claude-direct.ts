import type { TurnMessage } from '@arianna/agents';
import { openConversationWorkspace, prepareEmptyWorkspace, removeWorkspace, type ClaudeModel, type CodexModel, type PreparedWorkspace } from '@arianna/executors';
import { isAtMost, maxLabel, type Label, type Labeled } from '@arianna/policy';

import { CHARACTER_CHAT_PROMPT, CHARACTER_CHAT_PROMPT_SOURCE, characterChatNames } from '../character-chat.ts';
import { contextOf } from '../finance-mark.ts';
import { runClaudeStep, type BriefFragment, type ClaudeStepResult } from '../claude-step.ts';
import { runCodexStep, type CodexStepResult } from '../codex-step.ts';
import { CLAUDE_CHAT_AGENT, CODEX_CHAT_AGENT, CODEX_CHAT_MODELS, DIRECT_MODELS, seriesCharacterOf, type CodexChatModel, type Conversation, type DirectModel } from '../conversations.ts';
import type { Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { chatCharacterPart, chatLinesPart, type TailPart } from '../prompt-tail.ts';
import { setRunContext, type RunUsage } from '../runs.ts';
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
 *
 * ChatGPT without a project (D-212, `conversations.agent = 'codex'`) takes
 * the same chain on `codex exec`: its own fixed prompt (CODEX_CHAT_PROMPT),
 * the folder of the conversation as an empty repository opened read only
 * (Codex keeps its shell, which no option removes: in that folder, without
 * network and with ARIANNA_HOME and the home closed, it has nothing to read
 * of the user's, and at most CODEX_CHAT_COMMANDS commands run before the run
 * stops), the session of the latest answer resumed by id. Both plain chats
 * record how full the session is after each answer (`runs.context_tokens`),
 * for the context indicator.
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
 * What ChatGPT reads first in the plain chat with the user (D-212): ours, L0,
 * like CHAT_PROMPT. Codex keeps a shell no option turns off: the prompt asks
 * it not to use it, and the run stops after CODEX_CHAT_COMMANDS commands.
 */
export const CODEX_CHAT_PROMPT = [
  "You are ChatGPT, in a plain chat with the user inside Arianna, a personal assistant that runs on the user's own computer. The user chose to talk with you directly: Arianna is not in between.",
  '- Answer in the language of the user, as in a chat: clearly and concretely.',
  '- Do not run commands and do not change files: your folder is empty and read only, and you have no internet. Answer from what you know, and ask the user for what you need to know.',
  '- This is a work conversation that goes to the cloud: never ask for personal data, passwords or other credentials. For private matters, suggest a private conversation with the local model.',
].join('\n');

/** The model of the plain chat with ChatGPT when the user chose none (D-212): the one the router pairs with Sonnet. */
export const CODEX_CHAT_DEFAULT_MODEL: CodexChatModel = 'sol';
/** Commands of Codex in one answer of the plain chat before the run stops (D-212): it should run none. */
export const CODEX_CHAT_COMMANDS = 2;

/** Who answers a conversation directly, on which model (D-064, D-111 tappa B, D-212). */
export type DirectTarget = { executor: 'claude'; model: DirectModel } | { executor: 'codex'; model: CodexChatModel };

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

/** The plain chat with ChatGPT the user opened (D-212): work, no project. */
export function isPlainCodexChat(conversation: Pick<Conversation, 'origin' | 'mode' | 'agent' | 'workspace'> | undefined): boolean {
  return conversation?.origin === 'user' && conversation.mode === 'work' && conversation.agent === CODEX_CHAT_AGENT && conversation.workspace === null;
}

/**
 * Who answers this conversation directly, or undefined when Arianna answers
 * (or nobody, in a plain chat whose model is off): Claude in a system chat or
 * in the plain chat with Claude (`directModelOf`), ChatGPT in the plain chat
 * with ChatGPT (D-212), Sol when no model is chosen, while that alias is on.
 */
export function directTargetOf(
  conversation: Pick<Conversation, 'origin' | 'mode' | 'model' | 'agent' | 'workspace'> | undefined,
  enabled: readonly string[],
): DirectTarget | undefined {
  if (isPlainCodexChat(conversation)) {
    const wanted = conversation?.model ?? CODEX_CHAT_DEFAULT_MODEL;
    const model = CODEX_CHAT_MODELS.find((entry) => entry === wanted && enabled.includes(entry));
    return model === undefined ? undefined : { executor: 'codex', model };
  }
  const model = directModelOf(conversation, enabled);
  return model === undefined ? undefined : { executor: 'claude', model };
}

/** The plain chat with Claude the user opened (D-111, tappa B): work, no project. */
export function isPlainClaudeChat(conversation: Pick<Conversation, 'origin' | 'mode' | 'agent' | 'workspace'> | undefined): boolean {
  return conversation?.origin === 'user' && conversation.mode === 'work' && conversation.agent === CLAUDE_CHAT_AGENT && conversation.workspace === null;
}

/**
 * The session of the plain chat to continue (D-111, tappa B; D-212 for
 * ChatGPT, by `executor`): the one of the run that wrote the latest answer in this conversation, after the
 * line of «Nuova sessione» when there is one. Undefined at the first message.
 */
export async function plainChatSession(sql: Sql, conversationId: string, taskId: string, executor: DirectTarget['executor'] = 'claude'): Promise<string | undefined> {
  const [row] = await sql<{ sessionRef: string }[]>`
    SELECT r.session_ref AS "sessionRef" FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE t.conversation_id = ${conversationId} AND t.id <> ${taskId} AND r.executor = ${executor} AND r.status = 'ok' AND r.session_ref IS NOT NULL
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
 * exchanges that Claude (or ChatGPT, D-212) answered, oldest first, within the caps (the most
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

/** Claude (or `executor`, D-212) can answer now: enabled in the configuration and runnable on this machine. */
export function canAnswerDirectly(env: DelegateEnv, executor: DirectTarget['executor'] = 'claude'): boolean {
  return availableCloud(env).includes(executor);
}

const ROLE_NAME: Record<TurnMessage['role'], string> = { user: 'User', assistant: 'Assistant', tool: 'Tool' };

/** The brief: the prompt, then each message of the conversation with who wrote it and its own label. */
export function directBrief(history: readonly Labeled<TurnMessage>[], prompt: string = DIRECT_PROMPT, source = 'prompt:claude-direct'): BriefFragment[] {
  return [
    { text: prompt, label: 'L0', source },
    ...history.map((part) => ({ text: `${ROLE_NAME[part.value.role]}:\n${part.value.content}`, label: part.label, source: part.source })),
  ];
}

/** What a chat with a person of the series adds to the brief (D-225, tappa B). */
export interface CharacterBrief {
  /** The block of the character, after the prompt: only in a new start of the session. */
  role: TailPart;
  /** The real lines drawn for this message, after it: in a new start and in a resumed session alike. */
  lines: TailPart | undefined;
}

/**
 * The brief of a chat with a person of the series (D-225, tappa B): a new
 * start reads the prompt, the block of the character, the exchanges and the
 * lines; a resumed session only the new message and the lines, since the
 * prompt and the block are already in it.
 */
export function characterBrief(fragments: readonly BriefFragment[], character: CharacterBrief, resumed: boolean): BriefFragment[] {
  const lines = character.lines === undefined ? [] : [{ text: character.lines.text, label: character.lines.label, source: character.lines.source }];
  if (resumed) return [...fragments, ...lines];
  const [prompt, ...rest] = fragments;
  const role = { text: character.role.text, label: character.role.label, source: character.role.source };
  return [...(prompt === undefined ? [] : [prompt]), role, ...rest, ...lines];
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
  model: DirectModel | CodexChatModel,
  history: readonly Labeled<TurnMessage>[],
  /** The plain chat with Claude (D-111, tappa B) or ChatGPT (D-212): its prompt, its folder, its session. */
  plain = false,
  /** Who answers (D-212): ChatGPT only in its plain chat. */
  executor: DirectTarget['executor'] = 'claude',
): Promise<StepOutcome> {
  const { task, step, runId } = ctx;
  const { sql } = env;
  const claude = env.claude;
  const codex = env.codex;
  if (executor === 'claude' && claude === undefined) throw new Error('claude is not available');
  if (executor === 'codex' && codex === undefined) throw new Error('codex is not available');
  if (executor === 'codex' && !plain) throw new Error('codex answers only its plain chat');
  if (executor === 'claude' ? !(DIRECT_MODELS as readonly string[]).includes(model) : !(CODEX_CHAT_MODELS as readonly string[]).includes(model)) {
    throw new Error(`${model} is not a model of ${executor}`);
  }
  if (task.conversationId === null) return { kind: 'wait-user', reason: 'Claude answers only in a system chat' };
  const conversationId = task.conversationId;

  const label: Label = maxLabel(task.effectiveLabel, ...history.map((part) => part.label));
  if (!isAtMost(label, 'L1')) {
    return { kind: 'wait-user', reason: plain ? `the conversation holds ${label}: Claude cannot read it` : `the system chat holds ${label}: Claude cannot read it, choose Arianna to answer` };
  }

  // Waiting out a quota refusal: the same step runs again then, like a delegated one.
  const block = (await budgetOf(sql)).blocked.find((entry) => entry.executor === executor && (entry.model === undefined || entry.model === model));
  if (block !== undefined) {
    const at = block.until === undefined ? new Date(Date.now() + UNKNOWN_RESET_MS) : new Date(block.until);
    await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind: 'wait', detail: `${executor} · ${at.toISOString()}` }).catch(() => undefined);
    return { kind: 'retry', at, reason: `${executor} is out of quota` };
  }

  const data = env.settings().paths.data;
  const folder = { data, runId };
  // The empty folder of the interrupted run this step resumes (a crash, a lost lock): nothing else removes it.
  if (ctx.resume !== undefined && !plain) await removeWorkspace({ data, runId: ctx.resume.runId }).catch(() => undefined);
  // The plain chat keeps one folder for the whole conversation: Claude Code finds its sessions per folder.
  // Codex runs only inside a repository: the folder is an empty one of its own (D-212).
  const workspace: PreparedWorkspace = plain ? await openConversationWorkspace({ data, conversationId, repository: executor === 'codex' }) : await prepareEmptyWorkspace(folder);
  // A chat with a person of the series (D-225, tappa B): the plain chat with Claude, played by that character.
  const seriesCharacter = plain && executor === 'claude' ? await seriesCharacterOf(sql, conversationId) : undefined;
  let character: CharacterBrief | undefined;
  if (seriesCharacter !== undefined) {
    const role = chatCharacterPart(env.settings(), seriesCharacter, task.clearance, true);
    if (role === undefined) return { kind: 'wait-user', reason: 'the character of this conversation is no longer one of the people of the series' };
    character = { role, lines: chatLinesPart(env.settings(), seriesCharacter, task.clearance, conversationId) };
  }
  const prompt = executor === 'codex' ? (env.codexChatPrompt ?? CODEX_CHAT_PROMPT) : character !== undefined ? (env.characterChatPrompt ?? CHARACTER_CHAT_PROMPT) : plain ? (env.chatPrompt ?? CHAT_PROMPT) : env.directPrompt;
  const session = plain ? await plainChatSession(sql, conversationId, task.id, executor) : undefined;
  const message = session === undefined ? undefined : await messageOf(sql, task.id);
  // A new start of the plain chat reads only the exchanges Claude answered (plainChatHistory); a system chat the whole chat.
  const opening = async (): Promise<BriefFragment[]> => {
    const brief = directBrief(plain ? await plainChatHistory(sql, conversationId, task.id) : history, prompt, character === undefined ? undefined : CHARACTER_CHAT_PROMPT_SOURCE);
    return character === undefined ? brief : characterBrief(brief, character, false);
  };
  // In this brief alone the names of the series of the character are no person for the second scanner (D-225).
  const names = seriesCharacter === undefined ? undefined : characterChatNames(seriesCharacter);
  /** What the failed resume used: it counts even when the new start is blocked. */
  let lost: RunUsage | undefined;
  try {
    await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind: 'thinking', detail: `${executor}/${model}` }).catch(() => undefined);
    const reply = await openReply(sql, task.id, { runId, model });
    let streamed = 0;
    // A system chat never resumes: the folder of an interrupted run is gone, and the brief carries the whole conversation.
    // The plain chat resumes the session of its latest answer only, by name: never the one of an interrupted run.
    const fresh: StepContext = { task, step, runId, signal: ctx.signal, setSessionRef: (ref) => ctx.setSessionRef(ref), ...(ctx.approval === undefined ? {} : { approval: ctx.approval }) };
    const onText = async (text: string): Promise<void> => {
      await reply.delta(`${streamed === 0 ? '' : '\n\n'}${text}`);
      streamed += 1;
    };
    const attempt = (brief: readonly BriefFragment[], sessionRef: string | null): Promise<ClaudeStepResult | CodexStepResult> => {
      // A resumed session holds what the conversation held before: within L1 too, checked above.
      const common = { context: contextOf(task, label), brief, workspace, timeoutMs: TIMEOUT_MS, sessionRef };
      if (executor === 'codex' && codex !== undefined) {
        return runCodexStep(sql, codex, fresh, {
          ...common,
          model: model as CodexModel,
          // Nothing to change in the empty folder: the sandbox opens it read only.
          access: 'read',
          maxTurns: CODEX_CHAT_COMMANDS,
          summary: `plain chat answered by codex/${model}`,
          onEvent: async (event) => {
            if (event.type === 'text') await onText(event.text);
          },
        });
      }
      if (claude === undefined) throw new Error('claude is not available');
      return runClaudeStep(sql, claude, fresh, {
        ...common,
        model: model as DirectModel satisfies ClaudeModel,
        tools: [],
        maxTurns: MAX_TURNS,
        ...(names === undefined ? {} : { names }),
        summary: character !== undefined ? `character chat answered by claude/${model}` : plain ? `plain chat answered by claude/${model}` : `system chat answered by claude/${model}`,
        onEvent: async (event) => {
          if (event.type === 'text') await onText(event.text);
        },
      });
    };
    // Resumed: only the new message of the user leaves; the prompt and what came before are already in the session.
    const resumed = message === undefined ? [] : character === undefined ? [message] : characterBrief([message], character, true);
    let result: ClaudeStepResult | CodexStepResult = session !== undefined && message !== undefined ? await attempt(resumed, session) : await attempt(await opening(), null);
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
        // How full the session is now (D-212): the context indicator of the plain chats. Only a number.
        const context = result.result.usage.context;
        if (plain && context !== undefined) await setRunContext(sql, runId, context).catch(() => undefined);
        if (text === '') return { kind: 'wait-user', reason: `${executor === 'codex' ? 'ChatGPT' : 'Claude'} gave no answer`, usage: result.usage };
        const saved = await reply.finish(text, maxLabel(label, result.result.label));
        if (!saved.stored) {
          const why = saved.reason === 'blocked' ? 'the gateway blocked the answer' : 'the answer is above what the conversation may hold';
          return { kind: 'wait-user', reason: why, usage: result.usage };
        }
        return { kind: 'answered', messageId: saved.message.id, usage: result.usage };
      }
      case 'blocked':
        return { kind: 'wait-user', reason: `the gateway refused the conversation for ${executor === 'codex' ? 'ChatGPT' : 'Claude'}: ${result.decision.reason}`, ...(lost === undefined ? {} : { usage: lost }) };
      case 'quota': {
        const at = result.resetsAt !== undefined && result.resetsAt.getTime() > Date.now() ? result.resetsAt : new Date(Date.now() + UNKNOWN_RESET_MS);
        await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind: 'wait', detail: `${executor} · ${at.toISOString()}` }).catch(() => undefined);
        return { kind: 'retry', at, reason: result.overage ? `${executor} is on paid extra usage` : `${executor} is out of quota`, usage: result.usage };
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
