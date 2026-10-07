import {
  answerText,
  chatMessages,
  offerable,
  promptLabelOf,
  readAnswer,
  RESPONSE_SCHEMA_NAME,
  responseSchema,
  type Answer,
  type DelegateTarget,
  type LoadedAgent,
  type ReadAnswer,
  type ToolId,
  type TurnMessage,
} from '@arianna/agents';
import { enabledCloudModels, type AriannaConfig } from '@arianna/config';
import { LocalModelError, type ClaudeExecutor, type CodexExecutor, type LocalModel } from '@arianna/executors';
import { createContext, isAtMost, maxLabel, type Context, type Label, type Labeled, type LabelRules } from '@arianna/policy';

import { CHAT_AGENT, loadConversation, type DirectModel } from '../conversations.ts';
import type { Sql } from '../db/client.ts';
import type { RunSpec, StepContext, StepExecutor, StepOutcome } from '../engine.ts';
import { passGateway } from '../gateway.ts';
import { enterOnDelegation, isParticipant, nameLabelOf, participantsAt, participantsNote } from '../participants.ts';
import { openReply, postActivity, type ActivityKind } from '../reply.ts';
import { recordRouteDecision } from '../router-log.ts';
import type { Task } from '../tasks.ts';
import { canAnswerDirectly, directModelOf, runDirect } from './claude-direct.ts';
import {
  briefCeiling,
  delegateTargets,
  delegationRoute,
  isCloudRoute,
  directChatOf,
  NO_PROJECT,
  planDelegation,
  repoFor,
  runDelegation,
  runLocalDelegation,
  type DelegateEnv,
  type DelegationPlan,
} from './delegate.ts';
import { updateOffered, UPDATED } from './cards.ts';
import { createDelegation, loadDelegations, openDelegation, updateDelegation, type Delegation } from './delegations.ts';
import type { Kb } from './kb.ts';
import { conversationView, summaryMessage, writeMissingSummaries, type ConversationView, type SummarizeOutcome } from './summaries.ts';
import { isLocalTool, runTool, type LocalTool } from './tools.ts';
import { INCOGNITO_OFF_TOOLS, isIncognitoConversation } from '../incognito.ts';
import { runTrialChat, trialModelOf } from './trial-chat.ts';
import { loadTurns, recordTurn, type NewTurn, type Turn } from './turns.ts';

/**
 * The local orchestrator (task 1.10, D-053): one model call per engine step.
 * The model reads the conversation up to the message that started the task,
 * then the task's own turns, and answers with one action of the response
 * schema shared with the acceptance test (D-036, D-051, D-052). A tool call
 * or a plan continues the task; a reply, a question or a refusal is written
 * in the chat and ends it.
 *
 * The context is per task (docs/PRIVACY-POLICY-SPEC.md): a task reads its
 * conversation, never another task's turns. What the model reads passes the
 * gateway towards the local executor and is logged in gateway_log; the model
 * gets `decision.texts`. Every turn carries the highest label it read, and
 * the database raises the task's label to it.
 *
 * A `task.delegate` call opens a delegation (D-055): the next step of the
 * task runs on Claude Code (delegate.ts), and the step after reads its
 * report as the result of the call.
 *
 * In a work system chat where the user chose Claude (D-064, second part),
 * the whole step runs on Claude instead, without tools (claude-direct.ts).
 */
export const ORCHESTRATOR_EXECUTOR = 'local';
/** The model alias of the orchestrator role (docs/ROUTER-SPEC.md, planning and judgement). */
export const ORCHESTRATOR_MODEL = 'local-large';

/** Tools that end the step with a message in the chat instead of running. */
const CHAT_TOOLS: readonly ToolId[] = ['user.ask'];
const DELEGATE: ToolId = 'task.delegate';
const UPDATE: ToolId = 'task.update';
/** Longest message, tool result or turn shown to the model. */
const MAX_TEXT = 8_000;

export interface OrchestratorOptions {
  sql: Sql;
  agents: ReadonlyMap<string, LoadedAgent>;
  kb: Kb;
  /**
   * The local model of the current configuration, asked at every call: a
   * model changed for a role in arianna.toml applies at the next step (1.18).
   */
  model: () => LocalModel;
  /** The current configuration: cloud executors and projects for delegation. */
  settings: () => AriannaConfig;
  rules: LabelRules;
  /** The `claude -p` adapter, when `claude` is enabled and runs on this machine. */
  claude?: ClaudeExecutor;
  /** The `codex exec` adapter (D-140), when it runs on this machine; enabled or not is read at each step. */
  codex?: CodexExecutor;
  /** What Claude reads first when it answers a system chat directly (claude-direct.ts); for tests. */
  directPrompt?: string;
  /** Room for the thought and the answer. Default 2048 (D-052). */
  maxTokens?: number;
  /** The local model serving one catalog model, for its trial chat (D-142); without it a trial chat waits for the user. */
  trialModel?: (modelId: string) => LocalModel;
}

/**
 * The tools of a card the orchestrator can offer now: `task.delegate` only
 * when a cloud executor can take the step, `task.update` only when the
 * conversation had an open card to update when the task started (cards.ts,
 * fixed for the whole task). Without one the tool has no valid target, and a
 * local model would reach for it to move its own task instead of asking.
 * In an incognito conversation (D-136) none of INCOGNITO_OFF_TOOLS: what
 * they write would outlive the closing.
 */
export function orchestratorTools(agent: LoadedAgent, delegation = false, cards = false, incognito = false): ToolId[] {
  return offerable(agent.card.tools).filter(
    (tool) =>
      !(incognito && (INCOGNITO_OFF_TOOLS as readonly string[]).includes(tool)) &&
      ((isLocalTool(tool) && (tool !== UPDATE || cards)) || CHAT_TOOLS.includes(tool) || (delegation && tool === DELEGATE)),
  );
}

/** How a message of the system starts when the model reads it. */
export const SYSTEM_MESSAGE_MARK = '[Messaggio del sistema, non dell’utente]';

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut at ${String(MAX_TEXT)} characters]` : text;
}

/** How the model reads the outcome of a delegation at the step after it. */
function delegationResult(delegation: Delegation | undefined): { text: string; label: Label } {
  if (delegation === undefined) return { text: `error: ${DELEGATE}: the delegation was not recorded`, label: 'L0' };
  switch (delegation.status) {
    case 'ok':
      return { text: `${delegation.agent} (${delegation.executor ?? ''}/${delegation.model ?? ''}) reported:\n${clip(delegation.result ?? '')}`, label: delegation.resultLabel ?? delegation.label };
    case 'failed':
    case 'refused':
      return { text: delegation.result ?? `error: ${DELEGATE}: failed`, label: delegation.resultLabel ?? delegation.label };
    case 'pending':
    case 'running':
      return { text: `delegation to ${delegation.agent} in progress`, label: 'L0' };
  }
}

/** What the model reads, each part with its label: the conversation, then the task's turns. */
async function historyOf(
  sql: Sql,
  agents: ReadonlyMap<string, LoadedAgent>,
  task: Task,
  turns: readonly Turn[],
  delegations: readonly Delegation[],
  computed?: ConversationView,
): Promise<Labeled<TurnMessage>[]> {
  const history: Labeled<TurnMessage>[] = [];
  if (task.conversationId === null) {
    // A task without a conversation: its title and goal are the request.
    const content = [task.title, task.goal].filter((part) => part !== null && part !== '').join('\n\n');
    history.push({ value: { role: 'user', content }, label: task.label, source: `task:${task.id}` });
  } else {
    // Up to the message that started this task: later ones belong to other tasks.
    // The summary of what the anchor left behind first, then the messages from
    // the anchor (D-077). Reports of delegated steps are read from their
    // delegation, not as messages. Messages of the system (a system chat,
    // D-064) reach the model as the user's, marked: chat templates take one
    // system prompt, at the start.
    const view = computed ?? (await conversationView(sql, task.conversationId, task.id, MAX_TEXT));
    const summary = summaryMessage(view.pieces);
    if (summary !== undefined) history.push(summary);
    for (const row of view.messages) {
      const value: TurnMessage =
        row.role === 'system' ? { role: 'user', content: `${SYSTEM_MESSAGE_MARK}\n${clip(row.body)}` } : { role: row.role, content: clip(row.body) };
      history.push({ value, label: row.label, source: `message:${row.id}` });
    }
    // Who else is here (D-125): the agents that joined before this task, as a note of the system after
    // the chat, never in the system prompt. The same for every step of the task, so its prefix stays.
    const present = history.length === 0 ? [] : await participantsAt(sql, task.conversationId, task.createdAt);
    const note = participantsNote(present);
    if (note !== undefined) {
      const label = maxLabel(...present.map((name) => nameLabelOf(agents.get(name))));
      history.push({ value: { role: 'user', content: `${SYSTEM_MESSAGE_MARK}\n${note}` }, label, source: `participants:${task.conversationId}` });
    }
  }
  for (const turn of turns) {
    const source = `turn:${task.id}:${String(turn.step)}`;
    history.push({ value: { role: 'assistant', content: answerText(turn.answer) }, label: turn.label, source });
    if (turn.result !== null) {
      history.push({ value: { role: 'tool', content: clip(turn.result) }, label: turn.label, source });
    } else if (turn.answer.action === 'call' && turn.answer.tool === DELEGATE) {
      // A call that opened a delegation: its outcome is the result.
      const result = delegationResult(delegations.find((delegation) => delegation.step === turn.step));
      history.push({ value: { role: 'tool', content: result.text }, label: result.label, source: `delegation:${task.id}:${String(turn.step)}` });
    }
  }
  return history;
}

/** What separates two messages of the same role joined into one. */
export const JOIN_SEPARATOR = '\n\n';

/**
 * Consecutive messages of the same role joined into one (D-092): chat
 * templates that require user and assistant to alternate (Gemma) reject or
 * mangle two `user` messages in a row, as a system message, the summary
 * (D-077) and the user's question can be. `tool` results are never joined:
 * each is fenced on its own (chatMessages). The order stays; the joined
 * entry carries the highest label of its parts and their sources, `+`-separated.
 *
 * Deterministic and append-only for the prefix cache (D-075): the same
 * parts give the same bytes, and a part added at the end changes only the
 * last entry, and only when it has the same role, by appending
 * `JOIN_SEPARATOR` and its text: every byte before stays where it was.
 * An empty part adds no separator (its label and source still count).
 *
 * chatMessages (packages/agents/src/protocol.ts) sends a `tool` result as
 * `user`: a `tool` followed by a `user` would still be two user messages in
 * the template. It does not happen today: the task's turns (assistant, then
 * its result) always come after the messages of the chat.
 */
export function joinSameRole(parts: readonly Labeled<TurnMessage>[]): Labeled<TurnMessage>[] {
  const joined: Labeled<TurnMessage>[] = [];
  for (const part of parts) {
    const last = joined.at(-1);
    if (last !== undefined && last.value.role === part.value.role && part.value.role !== 'tool') {
      joined[joined.length - 1] = {
        value: { role: last.value.role, content: [last.value.content, part.value.content].filter((text) => text !== '').join(JOIN_SEPARATOR) },
        label: maxLabel(last.label, part.label),
        source: `${last.source}+${part.source}`,
      };
    } else {
      joined.push({ value: { ...part.value }, label: part.label, source: part.source });
    }
  }
  return joined;
}

/** The text a chat action writes for the user, or undefined for a call or a plan. */
function chatText(answer: Answer): string | undefined {
  switch (answer.action) {
    case 'reply':
      return answer.text;
    case 'refuse':
      return answer.reason;
    case 'call':
      return CHAT_TOOLS.includes(answer.tool) ? String(answer.arguments.question) : undefined;
    case 'plan':
      return undefined;
  }
}

// Shown to the model after its plan, so that the next step acts on it.
const PLAN_NOTED = 'Plan noted. Now carry out its first step with one tool call, or reply if nothing is left to do.';

export function createOrchestrator(options: OrchestratorOptions): StepExecutor {
  const { sql } = options;
  const env: DelegateEnv = {
    sql,
    agents: options.agents,
    settings: options.settings,
    rules: options.rules,
    model: options.model,
    ...(options.claude === undefined ? {} : { claude: options.claude }),
    ...(options.codex === undefined ? {} : { codex: options.codex }),
    ...(options.directPrompt === undefined ? {} : { directPrompt: options.directPrompt }),
  };
  /** What `plan` decided for a step with an open delegation, for its `run`. */
  const plans = new Map<string, DelegationPlan>();
  /** What `plan` decided about Claude answering directly (null: Arianna answers), for its `run`. */
  const directs = new Map<string, DirectModel | null>();
  const summaryEnv = { sql, model: options.model };
  const localSpec = (task: Task): RunSpec => ({ agent: task.assignee, executor: ORCHESTRATOR_EXECUTOR, locality: 'local', model: ORCHESTRATOR_MODEL });

  /** One line of activity in the chat (D-054); a task without a conversation shows none. Never fails the step. */
  async function show(task: Task, step: number, kind: ActivityKind, detail = ''): Promise<void> {
    if (task.conversationId === null) return;
    await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind, detail }).catch(() => undefined);
  }

  async function ask(
    tools: readonly ToolId[],
    prompt: string,
    history: readonly TurnMessage[],
    signal: AbortSignal,
    delegates: readonly DelegateTarget[],
  ): Promise<{ read: ReadAnswer | undefined; tokensIn: number; tokensOut: number }> {
    // Tokens of both calls count, the discarded one too.
    let tokensIn = 0;
    let tokensOut = 0;
    const call = async (thought: boolean) => {
      const result = await options.model().chat({
        model: ORCHESTRATOR_MODEL,
        messages: chatMessages(prompt, tools, history, thought, '', delegates),
        schema: { name: RESPONSE_SCHEMA_NAME, schema: responseSchema(tools, thought, delegates) },
        temperature: 0,
        maxTokens: options.maxTokens ?? 2048,
        signal,
      });
      tokensIn += result.usage?.promptTokens ?? 0;
      tokensOut += result.usage?.completionTokens ?? 0;
      return readAnswer(result.value, tools, thought, delegates);
    };
    let read: ReadAnswer | undefined;
    try {
      read = await call(true);
    } catch (error) {
      if (!(error instanceof LocalModelError) || error.kind !== 'bad-response') throw error;
    }
    // Not JSON, or outside the schema: once more without the thought (D-052).
    read ??= await call(false);
    return { read, tokensIn, tokensOut };
  }

  /**
   * The Claude model that answers this task directly: in a work system chat
   * where the user chose one, while Claude can run and what it would read
   * (the task and the chat) is within L1. `label` is that, for the run's
   * record. Otherwise Arianna answers on the local model.
   */
  async function directFor(task: Task): Promise<{ model: DirectModel; label: Label } | undefined> {
    if (task.conversationId === null || !canAnswerDirectly(env)) return undefined;
    const model = directModelOf(await loadConversation(sql, task.conversationId), enabledCloudModels(env.settings().cloud));
    if (model === undefined) return undefined;
    const history = await historyOf(sql, options.agents, task, [], []);
    const label = maxLabel(task.effectiveLabel, ...history.map((part) => part.label));
    return isAtMost(label, 'L1') ? { model, label } : undefined;
  }

  /**
   * The step that follows a `task.delegate` call: planned by the router, or
   * closed here. In the direct chat (D-111) the delegation was written with
   * the user's message, at the task's first step: no local step comes before it.
   */
  async function delegationPlanFor(task: Task, step: number, direct: boolean): Promise<DelegationPlan | undefined> {
    const delegation = await openDelegation(sql, task.id);
    if (delegation === undefined || (delegation.step >= step && !direct)) return undefined;
    return planDelegation(env, task, delegation);
  }

  /** The task is a message of the direct chat with its assignee (D-111). */
  async function isDirectChat(task: Task): Promise<boolean> {
    return task.assignee !== CHAT_AGENT && (await directChatOf(sql, task, task.assignee)) !== undefined;
  }

  /**
   * How a task of the direct chat ends (D-111): with the agent's message, or
   * waiting for the user with why the delegation ended without one. Nobody
   * else reads the result: the local model never runs in this chat.
   */
  async function directChatEnd(task: Task, outcome: StepOutcome): Promise<StepOutcome> {
    if (outcome.kind !== 'continue') return outcome;
    const usage = outcome.usage;
    const delegation = (await loadDelegations(sql, task.id)).at(-1);
    if (delegation?.status === 'ok' && delegation.messageId !== null) {
      return { kind: 'answered', messageId: delegation.messageId, ...(usage === undefined ? {} : { usage }) };
    }
    const why = (delegation?.result ?? 'the delegation did not end').replace(/^error: [^:]+: /, '');
    return { kind: 'wait-user', reason: `${task.assignee} could not answer: ${why}`, ...(usage === undefined ? {} : { usage }) };
  }

  /**
   * The model called `task.delegate`: the turn and the delegation are
   * written together. A brief above what the agent may read (L1 for the
   * cloud, the agent's clearance on the local model) asks the user's
   * declassification first; the next step runs the delegation (or reads why
   * it could not). Only an agent offered at this step is taken.
   */
  async function delegateCall(
    ctx: StepContext,
    turn: Omit<NewTurn, 'label' | 'result' | 'messageId'>,
    label: Label,
    args: Record<string, unknown>,
    usage: { steps: number; tokensIn: number; tokensOut: number },
    delegates: readonly DelegateTarget[],
  ): Promise<StepOutcome> {
    const { task, step } = ctx;
    const agentName = String(args.agent);
    const brief = String(args.brief).trim();
    const reason = typeof args.reason === 'string' ? args.reason.replace(/\s+/g, ' ').trim() : '';
    const target = options.agents.get(agentName);
    const where = target === undefined || !delegates.some((item) => item.name === agentName) ? undefined : delegationRoute(target.card);
    // Only a run on Claude Code or Codex works in a project folder.
    const conversation = isCloudRoute(where) && task.conversationId !== null ? await loadConversation(sql, task.conversationId) : undefined;
    const repo = isCloudRoute(where) ? repoFor(conversation?.workspace, options.settings().projects) : undefined;
    let error: string | undefined;
    if (target === undefined || where === undefined) error = `${agentName} does not take delegated steps`;
    else if (brief === '') error = 'the brief is empty';
    else if (reason === '') error = 'the reason is empty: say in one short line why you bring this agent in';
    else if (isCloudRoute(where) && repo === undefined) error = NO_PROJECT;
    if (error !== undefined || target === undefined) {
      const result = `error: ${DELEGATE}: ${error ?? ''}`;
      await recordTurn(sql, { ...turn, label, result });
      await show(task, step, 'error', error);
      return { kind: 'continue', usage };
    }
    // The agent joins the conversation with its first delegation there (D-125): the reason reaches the
    // chat as the model wrote it, through the gateway towards the web chat like an answer.
    const conversationId = task.conversationId;
    const shown = conversationId !== null && !(await isParticipant(sql, conversationId, agentName)) ? await reasonForChat(task, reason, label, ctx.runId) : undefined;
    await sql.begin(async (tx) => {
      await recordTurn(tx, { ...turn, label });
      const delegation = await createDelegation(tx, { taskId: task.id, step, agent: agentName, brief, label, ...(repo === undefined ? {} : { repo }) });
      if (conversationId === null) return;
      await enterOnDelegation(tx, {
        conversationId,
        taskId: task.id,
        delegationId: delegation.id,
        agent: agentName,
        reason: shown,
        reasonLabel: label,
        nameLabel: nameLabelOf(target),
      });
    });
    await show(task, step, 'delegate', agentName);
    // The brief carries what the step has read: above what the agent may read it leaves only as the text the user approves.
    const ceiling = briefCeiling(target.card);
    return isAtMost(label, ceiling) ? { kind: 'continue', usage } : { kind: 'declassify', text: brief, from: label, to: ceiling, usage };
  }

  /**
   * The reason of a delegation as the chat may show it: allowed by the gateway
   * towards the web chat (logged in gateway_log), else undefined and the line
   * says only who joins. Never above what the task may hold.
   */
  async function reasonForChat(task: Task, reason: string, label: Label, runId: string): Promise<string | undefined> {
    if (!isAtMost(label, task.clearance)) return undefined;
    const decision = await passGateway(sql, [{ value: reason, label, source: `task:${task.id}` }], createContext(task.clearance, label), { kind: 'channel', id: 'web' }, { taskId: task.id, runId });
    return decision.decision === 'allow' ? decision.texts[0] : undefined;
  }

  return {
    async plan(task: Task, step: number): Promise<RunSpec> {
      const key = `${task.id}:${String(step)}`;
      // The trial chat of a local model (D-142): that model answers, nothing else runs.
      const trial = await trialModelOf(sql, task.conversationId);
      if (trial !== undefined) return { agent: task.assignee, executor: 'local', locality: 'local', model: trial };
      const directChat = await isDirectChat(task);
      const planned = await delegationPlanFor(task, step, directChat);
      // Nothing left to run in the direct chat: the step only closes the task (directChatEnd). Its run row says
      // local and no model, as for a delegation closed without running: no model is called.
      if (planned === undefined && directChat) return { agent: task.assignee, executor: ORCHESTRATOR_EXECUTOR, locality: 'local' };
      if (planned === undefined) {
        const direct = await directFor(task);
        directs.set(key, direct?.model ?? null);
        // The run reads the task and the chat: their label, recorded with it.
        return direct === undefined
          ? localSpec(task)
          : { agent: task.assignee, executor: 'claude', locality: 'cloud', model: direct.model, effectiveLabel: direct.label };
      }
      plans.set(key, planned);
      // The delegated run reads only the brief (and the agent's prompt): that label, not the task's.
      if (planned.kind === 'cloud') return { agent: planned.delegation.agent, executor: planned.executor, locality: 'cloud', model: planned.model, effectiveLabel: planned.label };
      if (planned.kind === 'local') {
        const agent = options.agents.get(planned.delegation.agent);
        // An agent gone meanwhile: never lower than a user's prompt (the delegation fails anyway).
        const prompt: Label = agent === undefined ? 'L1' : promptLabelOf(agent);
        return { agent: planned.delegation.agent, executor: 'local', locality: 'local', model: planned.model, effectiveLabel: maxLabel(planned.label, prompt) };
      }
      return localSpec(task);
    },

    async run(ctx: StepContext): Promise<StepOutcome> {
      const { task, step, runId } = ctx;
      const key = `${task.id}:${String(step)}`;
      const trial = await trialModelOf(sql, task.conversationId);
      if (trial !== undefined) return runTrialChat(sql, ctx, trial, options.trialModel?.(trial));
      const directChat = await isDirectChat(task);
      const planned = plans.get(key) ?? (await delegationPlanFor(task, step, directChat));
      plans.delete(key);
      const plannedDirect = directs.get(key);
      directs.delete(key);
      if (planned !== undefined) {
        // The decision goes to router_decisions before anything acts on it.
        const decision = planned.kind === 'workspace' ? undefined : planned.decision;
        if (decision !== undefined) await recordRouteDecision(sql, decision, { taskId: task.id, runId, step });
        switch (planned.kind) {
          case 'cloud': {
            const outcome = await runDelegation(env, ctx, planned);
            return directChat ? directChatEnd(task, outcome) : outcome;
          }
          case 'local': {
            const outcome = await runLocalDelegation(env, ctx, planned);
            return directChat ? directChatEnd(task, outcome) : outcome;
          }
          case 'workspace':
            await show(task, step, 'wait', `workspace · ${planned.repo}`);
            return { kind: 'workspace', repo: planned.repo, files: planned.files, step: planned.delegation.step, agent: planned.delegation.agent };
          case 'budget':
            await show(task, step, 'wait', `budget · ${planned.model}`);
            return { kind: 'budget', executor: planned.executor, model: planned.model, step: planned.delegation.step };
          case 'retry': {
            // The cloud executor the agent's card names first: the one the user expects to see waiting.
            const card = options.agents.get(planned.delegation.agent)?.card;
            const waiting = card === undefined ? undefined : delegationRoute(card);
            await show(task, step, 'wait', `${isCloudRoute(waiting) ? waiting : 'claude'} · ${planned.at.toISOString()}`);
            return { kind: 'retry', at: planned.at, reason: planned.decision.reason };
          }
          case 'closed':
            // Nothing to run: the local step goes on, with the error as the result of the call.
            await updateDelegation(sql, planned.delegation.id, { status: planned.status, result: planned.result, resultLabel: planned.delegation.label });
            await show(task, step, 'error', planned.result.replace(/^error: [^:]+: /, ''));
            break;
        }
      }
      // The direct chat never reaches the local model (D-111).
      if (directChat) return directChatEnd(task, { kind: 'continue', usage: { steps: 0 } });

      const agent = options.agents.get(task.assignee);
      if (agent === undefined) return { kind: 'wait-user', reason: `no agent card for ${task.assignee}` };
      if (!agent.card.executors.includes('local')) return { kind: 'wait-user', reason: `${task.assignee} does not run on the local model` };

      // A chat task ends with one message of Arianna: if it is there, the task is
      // answered (a crash after the message, before the engine recorded the step).
      const [answered] = await sql<{ id: string }[]>`
        SELECT id::text FROM messages WHERE task_id = ${task.id} AND role = 'assistant' AND agent IS NULL ORDER BY id LIMIT 1`;
      if (answered !== undefined) return { kind: 'answered', messageId: answered.id };

      // Claude answers the system chat (D-064): what `plan` chose, so that the run matches its record.
      const direct = planned !== undefined ? undefined : plannedDirect === undefined ? (await directFor(task))?.model : (plannedDirect ?? undefined);
      if (direct !== undefined) {
        const history = await historyOf(sql, options.agents, task, [], []);
        if (history.length === 0) return { kind: 'wait-user', reason: 'the task has no request to work on' };
        return runDirect(env, ctx, direct, history);
      }

      const turns = await loadTurns(sql, task.id);
      const delegations = await loadDelegations(sql, task.id);
      // This step already completed before a crash or a lost lock: give the
      // same outcome again, without calling the model.
      const done = turns.find((turn) => turn.step === step);
      if (done !== undefined) {
        const ceilingOf = (name: string): Label => {
          const card = options.agents.get(name)?.card;
          return card === undefined ? 'L1' : briefCeiling(card);
        };
        return replay(task, done, delegations, turns, ceilingOf);
      }

      // The anchor jumped (D-077): at the first step of the task the local
      // model summarizes what it left behind, before the answer; the later
      // steps only read, so their prefix stays the one of the first.
      let view = task.conversationId === null ? undefined : await conversationView(sql, task.conversationId, task.id, MAX_TEXT);
      let summarized: SummarizeOutcome | undefined;
      if (view !== undefined && task.conversationId !== null && step === 1 && view.missing.length > 0) {
        summarized = await writeMissingSummaries(summaryEnv, task, { runId, signal: ctx.signal }, view);
        // Read again only when the pieces changed: ours, or another task's that came first.
        if (summarized.written > 0 || summarized.degraded === 'conflict') view = await conversationView(sql, task.conversationId, task.id, MAX_TEXT);
      }
      const history = await historyOf(sql, options.agents, task, turns, delegations, view);
      if (history.length === 0) return { kind: 'wait-user', reason: 'the task has no request to work on' };
      const label = maxLabel(task.effectiveLabel, ...history.map((part) => part.label));
      const context: Context = createContext(task.clearance, label);
      const decision = await passGateway(
        sql,
        history.map((part) => ({ value: part.value.content, label: part.label, source: part.source })),
        context,
        { kind: 'executor', id: ORCHESTRATOR_EXECUTOR, locality: 'local' },
        { taskId: task.id, runId },
      );
      if (decision.decision === 'block') return { kind: 'wait-user', reason: `the local model cannot read this task: ${decision.reason}` };
      if (decision.texts.length !== history.length) throw new Error('the gateway allowed a different number of texts');
      // Joined after the gateway (D-092): gateway_log keeps each part with its own source and label.
      const allowed = joinSameRole(history.map((part, index) => ({ ...part, value: { role: part.value.role, content: decision.texts[index] ?? '' } }))).map(
        (part) => part.value,
      );

      // The agents this step may delegate to (D-119, tappa T3): the Coder and the user's active ones.
      const delegates = delegateTargets(env, task.assignee);
      // In an incognito conversation nothing that outlives it is offered (D-136): no KB note, no card.
      const incognito = task.conversationId !== null && (await isIncognitoConversation(sql, task.conversationId));
      const tools = orchestratorTools(agent, delegates.length > 0, !incognito && (await updateOffered(sql, task)), incognito);
      await show(task, step, 'thinking');
      let asked;
      try {
        asked = await ask(tools, agent.prompt, allowed, ctx.signal, delegates);
      } catch (error) {
        if (error instanceof LocalModelError && error.kind === 'no-endpoint') {
          return { kind: 'wait-user', reason: 'no local model serves the orchestrator: assign one in [roles] (pnpm arianna:init)' };
        }
        if (error instanceof LocalModelError && error.kind === 'bad-response') {
          return { kind: 'wait-user', reason: INVALID_ANSWER };
        }
        // Down, stuck or cancelled: the engine retries the step, or stops it.
        throw error;
      }
      const usage = { steps: 1, tokensIn: asked.tokensIn + (summarized?.tokensIn ?? 0), tokensOut: asked.tokensOut + (summarized?.tokensOut ?? 0) };
      if (asked.read === undefined) return { kind: 'wait-user', reason: INVALID_ANSWER, usage };
      const { answer, thought } = asked.read;
      const turn = { taskId: task.id, step, runId, answer, ...(thought === undefined ? {} : { thought }) };

      const text = chatText(answer);
      if (text !== undefined) {
        if (task.conversationId === null) {
          // No chat to write in: the text stays in the turn, for the user to read on the card.
          await recordTurn(sql, { ...turn, label, result: NO_CONVERSATION });
          return { kind: 'done', evidence: [{ kind: 'turn', ref: String(step) }], usage };
        }
        const reply = await openReply(sql, task.id, { runId });
        const result = await reply.finish(text, label);
        if (!result.stored) {
          await recordTurn(sql, { ...turn, label, result: `${UNDELIVERED} (${result.reason})` });
          return { kind: 'wait-user', reason: undelivered(result.reason), usage };
        }
        await recordTurn(sql, { ...turn, label, messageId: result.message.id });
        return { kind: 'answered', messageId: result.message.id, usage };
      }

      if (answer.action === 'plan') {
        await recordTurn(sql, { ...turn, label, result: PLAN_NOTED });
        await show(task, step, 'plan', answer.steps.map((item, index) => `${String(index + 1)}. ${item}`).join(' · '));
        return { kind: 'continue', usage };
      }

      // A call: the schema allowed only offered tools, checked again here.
      if (answer.action !== 'call' || !tools.includes(answer.tool)) {
        return { kind: 'wait-user', reason: 'the local model asked for a tool it does not have', usage };
      }
      if (answer.tool === DELEGATE) return delegateCall(ctx, turn, label, answer.arguments, usage, delegates);
      if (!isLocalTool(answer.tool)) return { kind: 'wait-user', reason: 'the local model asked for a tool it does not have', usage };
      const tool = answer.tool;
      // The same call again is not run (D-076): the model reads where its
      // result already is; every third one the task waits for the user, and
      // after the user resumes it the count starts again.
      const earlier = earlierCall(turns, tool, answer.arguments);
      if (earlier !== undefined) {
        const waits = (stoppedRepeats(turns).length + 1) % MAX_REPEATS === 0;
        await recordTurn(sql, { ...turn, label, result: repeatedResult(tool, earlier, waits) });
        await show(task, step, 'error', `the same call as step ${String(earlier)}, not run again`);
        return waits ? { kind: 'wait-user', reason: REPEATING, usage } : { kind: 'continue', usage };
      }
      // The tool and its turn commit together: after a crash the step either
      // finds its turn or runs again with nothing done (a card is not created twice).
      const result = await sql.begin(async (tx) => {
        const ran = await runTool(tool, answer.arguments, { sql: tx, kb: options.kb, task, context, autonomy: agent.card.autonomy });
        await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: ran.text });
        return ran;
      });
      if (result.text.startsWith('error: ')) await show(task, step, 'error', result.text.replace(/^error: [^:]+: /, ''));
      else await show(task, step, TOOL_ACTIVITY[tool], toolDetail(tool, answer.arguments));
      return { kind: 'continue', usage };
    },
  };
}

const TOOL_ACTIVITY: Record<LocalTool, ActivityKind> = {
  'kb.search': 'search',
  'kb.read': 'read',
  'kb.write': 'write',
  'task.create': 'card',
  'task.update': 'card',
};

/** The argument that tells what the tool did: the query, the path, the card title, the card and its new status. */
function toolDetail(tool: LocalTool, args: Record<string, unknown>): string {
  if (tool === UPDATE) return `${String(args.task_id).slice(0, 8)} → ${String(args.status)}`;
  const field = tool === 'kb.search' ? 'query' : tool === 'task.create' ? 'title' : 'path';
  return String(args[field]);
}

const INVALID_ANSWER = 'the local model did not give a valid answer';
const REPEATING = 'the local model keeps repeating the same call';
/** Every this many repeated calls stopped in a task, it waits for the user (D-076). */
const MAX_REPEATS = 3;

function repeatedResult(tool: ToolId, step: number, waits: boolean): string {
  const next = waits ? 'The task now waits for the user.' : 'Take a different step, or reply with what you have.';
  return `error: ${tool}: the same call as step ${String(step)}, not run again: its result is above. ${next}`;
}

/**
 * The step of an earlier call of this task to `tool` with the same arguments,
 * in any key order (a default written out, like `limit`, makes another call:
 * a step more, never a call lost). A page written in the task can change what
 * a search or a read returns: those look only after the last write. An
 * update of a card looks only after the last update of the same card that
 * went through with other arguments (waiting, ready, waiting again); failed
 * updates never restart the count.
 */
export function earlierCall(turns: readonly Turn[], tool: ToolId, args: Record<string, unknown>): number | undefined {
  const key = canonical(args);
  const lastWrite =
    tool === 'kb.read' || tool === 'kb.search'
      ? turns.findLastIndex(wrotePage)
      : tool === UPDATE
        ? turns.findLastIndex((past) => canonical(past.answer.action === 'call' ? past.answer.arguments : null) !== key && updatedCard(past, args))
        : -1;
  return turns
    .slice(lastWrite + 1)
    .find((past) => past.answer.action === 'call' && past.answer.tool === tool && canonical(past.answer.arguments) === key)?.step;
}

/** Whether `turn` is a `task.update` that went through on the card `args` names (its id or a prefix of it). */
function updatedCard(turn: Turn, args: Record<string, unknown>): boolean {
  if (turn.answer.action !== 'call' || turn.answer.tool !== UPDATE || turn.result?.startsWith(`${UPDATED} `) !== true) return false;
  const card = turn.result.slice(UPDATED.length + 1).split(':')[0] ?? '';
  const named = String(args.task_id).trim().toLowerCase();
  return named !== '' && card.startsWith(named);
}

function wrotePage(turn: Turn): boolean {
  return turn.answer.action === 'call' && turn.answer.tool === 'kb.write' && turn.result?.startsWith('written ') === true;
}

/**
 * The repeated calls the core stopped in a task, in order, read from the
 * turns rather than from the text of their results; every MAX_REPEATS-th one
 * made the task wait.
 */
export function stoppedRepeats(turns: readonly Turn[]): { step: number; waits: boolean }[] {
  const stopped: { step: number; waits: boolean }[] = [];
  turns.forEach((past, index) => {
    if (past.answer.action !== 'call' || !isLocalTool(past.answer.tool)) return;
    if (earlierCall(turns.slice(0, index), past.answer.tool, past.answer.arguments) === undefined) return;
    stopped.push({ step: past.step, waits: (stopped.length + 1) % MAX_REPEATS === 0 });
  });
  return stopped;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const UNDELIVERED = 'error: the answer was not delivered';
const NO_CONVERSATION = 'answer for the user, kept here: the task has no conversation';

function undelivered(reason: string): string {
  return reason === 'blocked' ? 'the gateway blocked the answer' : 'the answer is above what the conversation may hold';
}

/** The outcome a completed step had, from its turn. */
/** `ceilingOf`: what a brief to that agent may carry without a declassification (`briefCeiling`); L1 for an agent no longer there. */
function replay(task: Task, turn: Turn, delegations: readonly Delegation[], turns: readonly Turn[], ceilingOf: (agent: string) => Label): StepOutcome {
  if (turn.messageId !== null) return { kind: 'answered', messageId: turn.messageId, usage: { steps: 0 } };
  if (stoppedRepeats(turns).some((stopped) => stopped.step === turn.step && stopped.waits)) {
    return { kind: 'wait-user', reason: REPEATING, usage: { steps: 0 } };
  }
  if (turn.result?.startsWith(UNDELIVERED) === true) {
    return { kind: 'wait-user', reason: undelivered(turn.result.includes('(blocked)') ? 'blocked' : 'above-clearance'), usage: { steps: 0 } };
  }
  if (turn.result === NO_CONVERSATION && task.conversationId === null) {
    return { kind: 'done', evidence: [{ kind: 'turn', ref: String(turn.step) }], usage: { steps: 0 } };
  }
  if (turn.answer.action === 'call' && turn.answer.tool === DELEGATE && turn.result === null) {
    // The declassification was asked and not yet decided: ask it again.
    const delegation = delegations.find((candidate) => candidate.step === turn.step);
    const ceiling = delegation === undefined ? 'L1' : ceilingOf(delegation.agent);
    if (delegation?.status === 'pending' && !isAtMost(delegation.label, ceiling)) {
      return { kind: 'declassify', text: delegation.brief, from: delegation.label, to: ceiling, usage: { steps: 0 } };
    }
  }
  return { kind: 'continue', usage: { steps: 0 } };
}
