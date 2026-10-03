import {
  answerText,
  chatMessages,
  offerable,
  readAnswer,
  RESPONSE_SCHEMA_NAME,
  responseSchema,
  type Answer,
  type LoadedAgent,
  type ReadAnswer,
  type ToolId,
  type TurnMessage,
} from '@arianna/agents';
import { LocalModelError, type LocalModel } from '@arianna/executors';
import { createContext, maxLabel, type Context, type Label, type Labeled } from '@arianna/policy';

import type { Sql } from '../db/client.ts';
import type { RunSpec, StepContext, StepExecutor, StepOutcome } from '../engine.ts';
import { passGateway } from '../gateway.ts';
import { openReply } from '../reply.ts';
import type { Task } from '../tasks.ts';
import type { Kb } from './kb.ts';
import { isLocalTool, runTool } from './tools.ts';
import { loadTurns, recordTurn, type Turn } from './turns.ts';

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
 */
export const ORCHESTRATOR_EXECUTOR = 'local';
/** The model alias of the orchestrator role (docs/ROUTER-SPEC.md, planning and judgement). */
export const ORCHESTRATOR_MODEL = 'local-large';

/** Tools that end the step with a message in the chat instead of running. */
const CHAT_TOOLS: readonly ToolId[] = ['user.ask'];
/** Messages of the conversation the model reads before the task's turns. */
const HISTORY_MESSAGES = 20;
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
  /** Room for the thought and the answer. Default 2048 (D-052). */
  maxTokens?: number;
}

/** The tools of a card the orchestrator can offer now. */
export function orchestratorTools(agent: LoadedAgent): ToolId[] {
  return offerable(agent.card.tools).filter((tool) => isLocalTool(tool) || CHAT_TOOLS.includes(tool));
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut at ${String(MAX_TEXT)} characters]` : text;
}

/** What the model reads, each part with its label: the conversation, then the task's turns. */
async function historyOf(sql: Sql, task: Task, turns: readonly Turn[]): Promise<Labeled<TurnMessage>[]> {
  const history: Labeled<TurnMessage>[] = [];
  if (task.conversationId === null) {
    // A task without a conversation: its title and goal are the request.
    const content = [task.title, task.goal].filter((part) => part !== null && part !== '').join('\n\n');
    history.push({ value: { role: 'user', content }, label: task.label, source: `task:${task.id}` });
  } else {
    // Up to the message that started this task: later ones belong to other tasks.
    const rows = await sql<{ id: string; role: 'user' | 'assistant'; body: string; label: Label }[]>`
      SELECT * FROM (
        SELECT id::text, role, body, label FROM messages
        WHERE conversation_id = ${task.conversationId} AND role IN ('user', 'assistant')
          AND id <= (SELECT max(id) FROM messages WHERE task_id = ${task.id} AND role = 'user')
        ORDER BY messages.id DESC LIMIT ${HISTORY_MESSAGES}
      ) recent ORDER BY recent.id::bigint`;
    for (const row of rows) {
      history.push({ value: { role: row.role, content: clip(row.body) }, label: row.label, source: `message:${row.id}` });
    }
  }
  for (const turn of turns) {
    const source = `turn:${task.id}:${String(turn.step)}`;
    history.push({ value: { role: 'assistant', content: answerText(turn.answer) }, label: turn.label, source });
    if (turn.result !== null) history.push({ value: { role: 'tool', content: clip(turn.result) }, label: turn.label, source });
  }
  return history;
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

  async function ask(
    tools: readonly ToolId[],
    prompt: string,
    history: readonly TurnMessage[],
    signal: AbortSignal,
  ): Promise<{ read: ReadAnswer | undefined; tokensIn: number; tokensOut: number }> {
    // Tokens of both calls count, the discarded one too.
    let tokensIn = 0;
    let tokensOut = 0;
    const call = async (thought: boolean) => {
      const result = await options.model().chat({
        model: ORCHESTRATOR_MODEL,
        messages: chatMessages(prompt, tools, history, thought),
        schema: { name: RESPONSE_SCHEMA_NAME, schema: responseSchema(tools, thought) },
        temperature: 0,
        maxTokens: options.maxTokens ?? 2048,
        signal,
      });
      tokensIn += result.usage?.promptTokens ?? 0;
      tokensOut += result.usage?.completionTokens ?? 0;
      return readAnswer(result.value, tools, thought);
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

  return {
    plan(task: Task): RunSpec {
      return { agent: task.assignee, executor: ORCHESTRATOR_EXECUTOR, locality: 'local', model: ORCHESTRATOR_MODEL };
    },

    async run(ctx: StepContext): Promise<StepOutcome> {
      const { task, step, runId } = ctx;
      const agent = options.agents.get(task.assignee);
      if (agent === undefined) return { kind: 'wait-user', reason: `no agent card for ${task.assignee}` };
      if (!agent.card.executors.includes('local')) return { kind: 'wait-user', reason: `${task.assignee} does not run on the local model` };

      // A chat task ends with one message: if it is there, the task is answered
      // (a crash after the message, before the engine recorded the step).
      const [answered] = await sql<{ id: string }[]>`
        SELECT id::text FROM messages WHERE task_id = ${task.id} AND role = 'assistant' ORDER BY id LIMIT 1`;
      if (answered !== undefined) return { kind: 'answered', messageId: answered.id };

      const turns = await loadTurns(sql, task.id);
      // This step already completed before a crash or a lost lock: give the
      // same outcome again, without calling the model.
      const done = turns.find((turn) => turn.step === step);
      if (done !== undefined) return replay(task, done);

      const history = await historyOf(sql, task, turns);
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
      const allowed = history.map((part, index): TurnMessage => ({ role: part.value.role, content: decision.texts[index] ?? '' }));

      const tools = orchestratorTools(agent);
      let asked;
      try {
        asked = await ask(tools, agent.prompt, allowed, ctx.signal);
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
      const usage = { steps: 1, tokensIn: asked.tokensIn, tokensOut: asked.tokensOut };
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
        return { kind: 'continue', usage };
      }

      // A call: the schema allowed only offered tools, checked again here.
      if (answer.action !== 'call' || !isLocalTool(answer.tool) || !tools.includes(answer.tool)) {
        return { kind: 'wait-user', reason: 'the local model asked for a tool it does not have', usage };
      }
      const tool = answer.tool;
      // The tool and its turn commit together: after a crash the step either
      // finds its turn or runs again with nothing done (a card is not created twice).
      await sql.begin(async (tx) => {
        const result = await runTool(tool, answer.arguments, { sql: tx, kb: options.kb, task, context });
        await recordTurn(tx, { ...turn, label: maxLabel(label, result.label), result: result.text });
      });
      return { kind: 'continue', usage };
    },
  };
}

const INVALID_ANSWER = 'the local model did not give a valid answer';
const UNDELIVERED = 'error: the answer was not delivered';
const NO_CONVERSATION = 'answer for the user, kept here: the task has no conversation';

function undelivered(reason: string): string {
  return reason === 'blocked' ? 'the gateway blocked the answer' : 'the answer is above what the conversation may hold';
}

/** The outcome a completed step had, from its turn. */
function replay(task: Task, turn: Turn): StepOutcome {
  if (turn.messageId !== null) return { kind: 'answered', messageId: turn.messageId, usage: { steps: 0 } };
  if (turn.result?.startsWith(UNDELIVERED) === true) {
    return { kind: 'wait-user', reason: undelivered(turn.result.includes('(blocked)') ? 'blocked' : 'above-clearance'), usage: { steps: 0 } };
  }
  if (turn.result === NO_CONVERSATION && task.conversationId === null) {
    return { kind: 'done', evidence: [{ kind: 'turn', ref: String(turn.step) }], usage: { steps: 0 } };
  }
  return { kind: 'continue', usage: { steps: 0 } };
}
