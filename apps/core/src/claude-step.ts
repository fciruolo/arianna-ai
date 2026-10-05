import {
  ClaudeError,
  type ClaudeEvent,
  type ClaudeExecutor,
  type ClaudeModel,
  type ClaudeResult,
  type ClaudeTool,
  type ClaudeUsage,
  type PreparedWorkspace,
} from '@arianna/executors';
import type { Context, Decision, Label } from '@arianna/policy';

import type { Sql } from './db/client.ts';
import type { StepContext } from './engine.ts';
import { appendEvent } from './events.ts';
import { passGateway } from './gateway.ts';
import type { RunUsage } from './runs.ts';

/** A piece of the brief, with its label and where it comes from (`task:<id>`, `file:<path>`). */
export interface BriefFragment {
  text: string;
  label: Label;
  source: string;
}

export interface ClaudeStepInput {
  /** The run's session on the sending side: what the brief was written from. */
  context: Context;
  brief: readonly BriefFragment[];
  workspace: PreparedWorkspace;
  model: ClaudeModel;
  tools: readonly ClaudeTool[];
  /** Turns per run. */
  maxTurns?: number;
  /**
   * The adapter's own wall-clock cap (default 15 minutes); the task's time cap
   * also stops the run through `step.signal`, whichever comes first.
   */
  timeoutMs?: number;
  /** For gateway_log: what leaves, in a few words, without content. */
  summary?: string;
  /**
   * Text the model writes, the tools it calls and the changes to files they
   * make (D-117), as they come (task 1.10): for the chat. Awaited in order; a
   * rejection stops the run.
   */
  onEvent?: (event: Extract<ClaudeEvent, { type: 'text' | 'tool' | 'edit' }>) => void | Promise<void>;
}

export type ClaudeStepResult =
  | { kind: 'answer'; result: ClaudeResult; usage: RunUsage }
  /** The gateway refused the brief: nothing was launched. */
  | { kind: 'blocked'; decision: Extract<Decision, { decision: 'block' }> }
  /**
   * The subscription refused, or went on paid extra usage (`overage`, stopped:
   * nothing is paid beyond the subscription, D-002); the router waits (1.10).
   */
  | { kind: 'quota'; overage: boolean; resetsAt?: Date; usage: RunUsage }
  /** The run failed; its usage counts anyway. `error` says how, for the readable error (D-064). */
  | { kind: 'failed'; reason: string; usage: RunUsage; error: ClaudeError };

/** A model name as the binary reports it; anything else is not written. */
const REPORTED_MODEL = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/;

const toUsage = (usage: ClaudeUsage | undefined): RunUsage =>
  usage === undefined ? { steps: 0 } : { steps: usage.turns, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, cost: 0 };

/**
 * One step of a task on `claude -p` (task 1.5): the options checked, the brief
 * through the gateway (a row in gateway_log, allowed or not), then the run in the prepared
 * workspace, resuming the interrupted session when the engine has one. The
 * session id is saved as soon as the binary gives it; every rate limit the
 * binary reports goes in the events, with numbers only, for the router's
 * budget. Subscription runs cost nothing beyond it (`cost` 0, AGENT-CARDS.md).
 *
 * A stop asked by the engine (shutdown, time cap) is thrown, so that the
 * engine interrupts the run as it does for any executor.
 */
export async function runClaudeStep(sql: Sql, executor: ClaudeExecutor, step: StepContext, input: ClaudeStepInput): Promise<ClaudeStepResult> {
  const ids = { taskId: step.task.id, runId: step.runId };
  // The kind and the profile fields only: the message never quotes output.
  const failed = async (error: ClaudeError): Promise<ClaudeStepResult> => {
    await appendEvent(sql, {
      ...ids,
      kind: 'executor.failed',
      label: 'L0',
      payload: {
        executor: 'claude',
        error: error.kind,
        violations: [...error.violations],
        exitCode: error.exitCode ?? null,
        apiStatus: error.apiStatus ?? null,
      },
    });
    return { kind: 'failed', reason: `claude: ${error.kind}`, usage: toUsage(error.usage), error };
  };

  const sessionRef = step.resume?.sessionRef ?? undefined;
  const launch = {
    workspace: input.workspace,
    model: input.model,
    tools: input.tools,
    limits: { ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) },
  };
  // Before the gateway: no allow is logged for a run that cannot start.
  try {
    await executor.check({ ...launch, ...(sessionRef === undefined ? {} : { sessionRef }) });
  } catch (error) {
    if (!(error instanceof ClaudeError)) throw error;
    return failed(error);
  }

  const decision = await passGateway(
    sql,
    input.brief.map((fragment) => ({ value: fragment.text, label: fragment.label, source: fragment.source })),
    input.context,
    { kind: 'executor', id: 'claude', locality: 'cloud' },
    { ...ids, ...(input.summary === undefined ? {} : { summary: input.summary }) },
  );
  if (decision.decision === 'block') return { kind: 'blocked', decision };

  const options = {
    ...launch,
    brief: decision,
    signal: step.signal,
    onEvent: async (event: ClaudeEvent) => {
      if (event.type === 'init') {
        await step.setSessionRef(event.sessionRef);
        // The model that actually runs: an exact name of [cloud.models] changes live and runs keep the alias (D-071).
        await appendEvent(sql, {
          ...ids,
          kind: 'executor.model',
          label: 'L0',
          payload: { executor: 'claude', alias: input.model, model: REPORTED_MODEL.test(event.model) ? event.model : null },
        });
      }
      if (event.type === 'text' || event.type === 'tool' || event.type === 'edit') await input.onEvent?.(event);
      if (event.type === 'rate-limit') {
        await appendEvent(sql, {
          ...ids,
          kind: 'executor.rate_limit',
          label: 'L0',
          payload: {
            executor: 'claude',
            status: event.status,
            window: event.window ?? null,
            resetsAt: event.resetsAt?.toISOString() ?? null,
            utilization: event.utilization ?? null,
            overage: event.overage,
          },
        });
      }
    },
  };
  const run = sessionRef === undefined ? executor.start(options) : executor.resume({ ...options, sessionRef });

  try {
    const result = await run.result;
    return { kind: 'answer', result, usage: toUsage(result.usage) };
  } catch (error) {
    if (!(error instanceof ClaudeError)) throw error;
    if (step.signal.aborted && (error.kind === 'cancelled' || error.kind === 'handler')) throw error;
    if (error.kind === 'quota' || error.kind === 'overage') {
      await appendEvent(sql, {
        ...ids,
        kind: 'executor.quota',
        label: 'L0',
        payload: { executor: 'claude', resetsAt: error.resetsAt?.toISOString() ?? null, overage: error.kind === 'overage' },
      });
      return {
        kind: 'quota',
        overage: error.kind === 'overage',
        ...(error.resetsAt === undefined ? {} : { resetsAt: error.resetsAt }),
        usage: toUsage(error.usage),
      };
    }
    return failed(error);
  }
}
