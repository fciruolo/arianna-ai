import {
  CodexError,
  type CodexAccess,
  type CodexEvent,
  type CodexExecutor,
  type CodexModel,
  type CodexResult,
  type CodexUsage,
  type PreparedWorkspace,
} from '@arianna/executors';
import type { Context, Decision } from '@arianna/policy';

import { sessionToResume, type BriefFragment } from './claude-step.ts';
import type { Sql } from './db/client.ts';
import type { StepContext } from './engine.ts';
import { appendEvent } from './events.ts';
import { passGateway } from './gateway.ts';
import type { RunUsage } from './runs.ts';

export interface CodexStepInput {
  /** The run's session on the sending side: what the brief was written from. */
  context: Context;
  brief: readonly BriefFragment[];
  workspace: PreparedWorkspace;
  model: CodexModel;
  /** `read`: the sandbox opens the workspace read only; `write`: the workspace only (D-138). */
  access: CodexAccess;
  /** Commands and file changes per run. */
  maxTurns?: number;
  /** The adapter's own wall-clock cap (default 15 minutes); the task's time cap also stops the run through `step.signal`. */
  timeoutMs?: number;
  /** For gateway_log: what leaves, in a few words, without content. */
  summary?: string;
  /**
   * The text the model writes and the kind of tool it uses, as they come
   * (D-140): for the chat. A file change gives no diff, only its path: the
   * changes are read from git after the run. Awaited in order; a rejection
   * stops the run.
   */
  onEvent?: (event: Extract<CodexEvent, { type: 'text' | 'tool' }>) => void | Promise<void>;
  /** As for `runClaudeStep`: a string resumes that session, null starts a new one. */
  sessionRef?: string | null;
  /** False: `--ephemeral`, nothing of the session is saved (D-136, incognito). Default true. */
  persistSession?: boolean;
}

export type CodexStepResult =
  | { kind: 'answer'; result: CodexResult; usage: RunUsage }
  /** The gateway refused the brief: nothing was launched. */
  | { kind: 'blocked'; decision: Extract<Decision, { decision: 'block' }> }
  /** The subscription refused; the binary gives no reset time, so the router waits an hour (`budgetOf`). */
  | { kind: 'quota'; overage: boolean; resetsAt?: Date; usage: RunUsage }
  /** The run failed; its usage counts anyway. */
  | { kind: 'failed'; reason: string; usage: RunUsage; error: CodexError };

const toUsage = (usage: CodexUsage | undefined): RunUsage =>
  usage === undefined ? { steps: 0 } : { steps: usage.turns, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, cost: 0 };

/**
 * One step of a task on `codex exec` (D-140, D-111 tappa C), the same chain
 * as `runClaudeStep`: options checked, the brief through the gateway towards
 * `codex` (a row in gateway_log, allowed or not), then the run in the
 * workspace, resuming the interrupted session when the engine has one. The
 * session id is saved as soon as the binary gives it. The stream of `codex`
 * carries no quota windows: a refusal is an `executor.quota` event without a
 * reset time. Subscription runs cost nothing beyond it (`cost` 0).
 *
 * A stop asked by the engine (shutdown, time cap) is thrown, so that the
 * engine interrupts the run as it does for any executor.
 */
export async function runCodexStep(sql: Sql, executor: CodexExecutor, step: StepContext, input: CodexStepInput): Promise<CodexStepResult> {
  const ids = { taskId: step.task.id, runId: step.runId };
  // The kind and the profile fields only: the message never quotes output.
  const failed = async (error: CodexError): Promise<CodexStepResult> => {
    await appendEvent(sql, {
      ...ids,
      kind: 'executor.failed',
      label: 'L0',
      payload: {
        executor: 'codex',
        error: error.kind,
        violations: [...error.violations],
        exitCode: error.exitCode ?? null,
        apiStatus: error.apiStatus ?? null,
      },
    });
    return { kind: 'failed', reason: `codex: ${error.kind}`, usage: toUsage(error.usage), error };
  };

  const sessionRef = sessionToResume(step, input);
  const launch = {
    workspace: input.workspace,
    model: input.model,
    access: input.access,
    ...(input.persistSession === undefined ? {} : { persistSession: input.persistSession }),
    limits: { ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) },
  };
  // Before the gateway: no allow is logged for a run that cannot start.
  try {
    await executor.check({ ...launch, ...(sessionRef === undefined ? {} : { sessionRef }) });
  } catch (error) {
    if (!(error instanceof CodexError)) throw error;
    return failed(error);
  }

  const decision = await passGateway(
    sql,
    input.brief.map((fragment) => ({ value: fragment.text, label: fragment.label, source: fragment.source })),
    input.context,
    { kind: 'executor', id: 'codex', locality: 'cloud' },
    { ...ids, ...(input.summary === undefined ? {} : { summary: input.summary }) },
  );
  if (decision.decision === 'block') return { kind: 'blocked', decision };

  const options = {
    ...launch,
    brief: decision,
    signal: step.signal,
    onEvent: async (event: CodexEvent) => {
      if (event.type === 'init') {
        // A session that was not saved is not written either: there is nothing to resume (D-136).
        if (input.persistSession !== false) await step.setSessionRef(event.sessionRef);
        // The stream does not name the model: the alias only (the exact name of [cloud.models] is in the settings).
        await appendEvent(sql, { ...ids, kind: 'executor.model', label: 'L0', payload: { executor: 'codex', alias: input.model, model: null } });
      }
      if (event.type === 'text' || event.type === 'tool') await input.onEvent?.(event);
    },
  };
  const run = sessionRef === undefined ? executor.start(options) : executor.resume({ ...options, sessionRef });

  try {
    const result = await run.result;
    return { kind: 'answer', result, usage: toUsage(result.usage) };
  } catch (error) {
    if (!(error instanceof CodexError)) throw error;
    if (step.signal.aborted && (error.kind === 'cancelled' || error.kind === 'handler')) throw error;
    if (error.kind === 'quota' || error.kind === 'overage') {
      await appendEvent(sql, {
        ...ids,
        kind: 'executor.quota',
        label: 'L0',
        payload: { executor: 'codex', resetsAt: null, overage: error.kind === 'overage' },
      });
      return { kind: 'quota', overage: error.kind === 'overage', usage: toUsage(error.usage) };
    }
    return failed(error);
  }
}
