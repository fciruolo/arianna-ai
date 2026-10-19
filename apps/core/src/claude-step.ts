import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CLAUDE_DEFAULT_TIMEOUT_MS,
  ClaudeError,
  type ClaudeEvent,
  type ClaudeExecutor,
  type ClaudeModel,
  type ClaudeResult,
  type ClaudeTool,
  type ClaudeUsage,
  type McpToolName,
  prepareMcp,
  type PreparedMcp,
  type PreparedNotes,
  type PreparedWorkspace,
  releaseMcp,
} from '@arianna/executors';
import type { Context, Decision, Label } from '@arianna/policy';

import type { Sql } from './db/client.ts';
import type { StepContext } from './engine.ts';
import { appendEvent } from './events.ts';
import { passGateway } from './gateway.ts';
import { MCP_TOOLS_SOURCE, mcpToolsText } from './mcp/run-tools.ts';
import type { McpServer } from './mcp/server.ts';
import type { RunUsage } from './runs.ts';

/** A piece of a run shown live in the chat (D-249). */
export interface LivePiece {
  kind: 'thought' | 'text';
  text: string;
}

/** Hands a live piece to the caller; a failure is dropped: the run goes on (D-249). */
export async function live(input: { onLive?: (piece: LivePiece) => void | Promise<void> }, piece: LivePiece): Promise<void> {
  try {
    await input.onLive?.(piece);
  } catch {
    // Live only: the stored answer is what counts.
  }
}

/** A piece of the brief, with its label and where it comes from (`task:<id>`, `file:<path>`). */
export interface BriefFragment {
  text: string;
  label: Label;
  source: string;
}

/**
 * Arianna's MCP server for one run (D-261): a session opened for the run
 * before it starts, its configuration file written in `dir`, both gone when
 * the step ends however it ends (the session revoked, the file removed).
 */
export interface ClaudeStepMcp {
  server: Pick<McpServer, 'open' | 'revoke'>;
  /** The server's URL; undefined when the server did not start, and the run goes without it. */
  url: string | undefined;
  /** Absolute folder of the configuration file, one sandboxed commands cannot read (`data/mcp`). */
  dir: string;
  /** The agent's card id: its assigned skills are the ones the server lists. */
  agent: string;
  /** `mcpClearance(task, card)`: at most L1. */
  clearance: Label;
  /** Not empty: a step with no tool gets no `mcp`. */
  tools: readonly McpToolName[];
  /**
   * Whether an administrator manages Claude Code's settings on this machine
   * (`claudeManagedSettingsPresent`): their hooks and servers would run in a
   * run without `--safe-mode`, so the run goes without the server.
   */
  managed: () => boolean;
}

/** The event of a run that was to have the MCP server and goes without it (D-261): why, in a word, never a text. */
export const MCP_UNAVAILABLE_EVENT = 'mcp.unavailable';

/** Minutes a session outlives the run's own time cap: the revoke at the end comes first anyway. */
const MCP_SESSION_MARGIN_MS = 5 * 60_000;

export interface ClaudeStepInput {
  /** The run's session on the sending side: what the brief was written from. */
  context: Context;
  brief: readonly BriefFragment[];
  workspace: PreparedWorkspace;
  /** The read-only copy of the project's notes for this run (`prepareProjectNotes`, D-166); absent, none. */
  notes?: PreparedNotes;
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
  /** Names that are no person in this brief alone, for the second scanner (D-225, tappa B: the names of the series of the character). */
  names?: readonly string[];
  /**
   * Text the model writes, the tools it calls, the changes to files they
   * make (D-117) and the commands of Bash with their output (D-095), as they come (task 1.10): for the chat. Awaited in order; a
   * rejection stops the run.
   */
  onEvent?: (event: Extract<ClaudeEvent, { type: 'text' | 'tool' | 'edit' | 'command' | 'command-output' }>) => void | Promise<void>;
  /**
   * The thinking and the answer as they are written (D-249), for the chat:
   * `thought` pieces ('' when the model thinks without showing it) and, for
   * Claude, `text` pieces (a `text` event then says `streamed`). Awaited in
   * order; a failure is dropped and never stops the run.
   */
  onLive?: (piece: LivePiece) => void | Promise<void>;
  /**
   * The session to continue (D-111, the direct chat): a string resumes it,
   * null starts a new one even after a crash. The interrupted run's session,
   * when the engine has one, comes first; absent, only that one is resumed.
   */
  sessionRef?: string | null;
  /**
   * False: the binary keeps nothing of the session on disk and it cannot be
   * resumed (`--no-session-persistence`, D-136, incognito). Default true.
   */
  persistSession?: boolean;
  /** Arianna's MCP server for this run (D-261); absent, the run has the profile without it (`--safe-mode`). */
  mcp?: ClaudeStepMcp;
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

/**
 * The session a step continues: none when the caller asks for a new one
 * (null); else the interrupted run's, when the engine has one; else the
 * caller's (D-111, tappa A2). A run that saves no session (D-136) never
 * continues the interrupted one, which was not saved either: it starts again;
 * a session the caller names is still passed on, for the executor to refuse.
 */
export function sessionToResume(step: Pick<StepContext, 'resume'>, input: Pick<ClaudeStepInput, 'sessionRef' | 'persistSession'>): string | undefined {
  if (input.sessionRef === null) return undefined;
  if (input.persistSession === false) return input.sessionRef;
  return step.resume?.sessionRef ?? input.sessionRef ?? undefined;
}

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
  const mcp = input.mcp === undefined ? undefined : await openMcp(sql, step, input.mcp, input.timeoutMs);
  try {
    return await runWith(sql, executor, step, input, mcp);
  } finally {
    // D-261: the token dies with the step, whatever its outcome; the file too (the run removes it, a refused check does not).
    if (mcp !== undefined) {
      input.mcp?.server.revoke(ids.runId);
      await releaseMcp(mcp).catch(() => undefined);
    }
  }
}

/**
 * The session and the configuration of the MCP server for this run, or
 * undefined: a server that is not started, or a file that cannot be written,
 * leaves the run without Arianna's tools, with an event that says which.
 */
async function openMcp(sql: Sql, step: StepContext, mcp: ClaudeStepMcp, timeoutMs: number | undefined): Promise<PreparedMcp | undefined> {
  const ids = { taskId: step.task.id, runId: step.runId };
  const without = async (reason: 'server' | 'managed' | 'session' | 'config'): Promise<undefined> => {
    await appendEvent(sql, { ...ids, kind: MCP_UNAVAILABLE_EVENT, label: 'L0', payload: { executor: 'claude', reason } }).catch(() => undefined);
    return undefined;
  };
  const url = mcp.url;
  if (url === undefined) return without('server');
  if (mcp.managed()) return without('managed');
  let token: string;
  try {
    const expiresAt = new Date(Date.now() + (timeoutMs ?? CLAUDE_DEFAULT_TIMEOUT_MS) + MCP_SESSION_MARGIN_MS);
    ({ token } = mcp.server.open({ runId: step.runId, taskId: step.task.id, agent: mcp.agent, executor: 'claude', clearance: mcp.clearance, tools: mcp.tools, expiresAt }));
  } catch {
    return without('session');
  }
  const endpoint = { url, token, tools: mcp.tools };
  try {
    try {
      return await prepareMcp(mcp.dir, step.runId, endpoint);
    } catch (error) {
      // A file of this same run left by a core that stopped mid-run (its token died with that core): only once
      // prepareMcp has checked the folder and the run id, and the file is there.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await rm(join(mcp.dir, `${step.runId}.mcp.json`), { force: true });
      return await prepareMcp(mcp.dir, step.runId, endpoint);
    }
  } catch {
    mcp.server.revoke(step.runId);
    return without('config');
  }
}

async function runWith(sql: Sql, executor: ClaudeExecutor, step: StepContext, input: ClaudeStepInput, mcp: PreparedMcp | undefined): Promise<ClaudeStepResult> {
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

  const sessionRef = sessionToResume(step, input);
  const launch = {
    workspace: input.workspace,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    model: input.model,
    tools: input.tools,
    ...(input.persistSession === undefined ? {} : { persistSession: input.persistSession }),
    ...(mcp === undefined ? {} : { mcp }),
    limits: { ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) },
  };
  // Before the gateway: no allow is logged for a run that cannot start.
  try {
    await executor.check({ ...launch, ...(sessionRef === undefined ? {} : { sessionRef }) });
  } catch (error) {
    if (!(error instanceof ClaudeError)) throw error;
    return failed(error);
  }

  // The tools of the server, told only to a run whose session is open (D-261): after the brief, our fixed text.
  const brief: readonly BriefFragment[] = mcp === undefined ? input.brief : [...input.brief, { text: mcpToolsText(mcp.tools), label: 'L0', source: MCP_TOOLS_SOURCE }];
  const decision = await passGateway(
    sql,
    brief.map((fragment) => ({ value: fragment.text, label: fragment.label, source: fragment.source })),
    input.context,
    { kind: 'executor', id: 'claude', locality: 'cloud' },
    { ...ids, ...(input.summary === undefined ? {} : { summary: input.summary }), ...(input.names === undefined ? {} : { names: input.names }) },
  );
  if (decision.decision === 'block') return { kind: 'blocked', decision };

  const options = {
    ...launch,
    brief: decision,
    signal: step.signal,
    onEvent: async (event: ClaudeEvent) => {
      if (event.type === 'init') {
        // A session that was not saved is not written either: there is nothing to resume (D-136).
        if (input.persistSession !== false) await step.setSessionRef(event.sessionRef);
        // The model that actually runs: an exact name of [cloud.models] changes live and runs keep the alias (D-071).
        await appendEvent(sql, {
          ...ids,
          kind: 'executor.model',
          label: 'L0',
          // D-233: the version of the binary, digits and dots only, read by «Cosa è cambiato».
          payload: { executor: 'claude', alias: input.model, model: REPORTED_MODEL.test(event.model) ? event.model : null, ...(event.version === undefined ? {} : { version: event.version }) },
        });
      }
      if (event.type === 'text' || event.type === 'tool' || event.type === 'edit' || event.type === 'command' || event.type === 'command-output') await input.onEvent?.(event);
      if (event.type === 'thinking') await live(input, { kind: 'thought', text: event.text });
      if (event.type === 'text-delta') await live(input, { kind: 'text', text: event.text });
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
