import { randomBytes } from 'node:crypto';

import { ClaudeError, prepareEmptyWorkspace, removeWorkspace, type ClaudeExecutor } from '@arianna/executors';
import { createContext } from '@arianna/policy';

import type { Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { passGateway } from './gateway.ts';
import { budgetOf } from './orchestrator/routing.ts';

/**
 * One answer of Claude (Sonnet, or Opus when asked) on public text, outside any task (I-20, D-185):
 * the examples of the styles of Open Design and the Italian descriptions of
 * the skills; and the router's advisor on a brief up to L1 (D-207). The text
 * is L0 (catalogs downloaded from GitHub) or L1; it passes the
 * gateway towards `claude` as everything else, the run has no tools, an empty
 * folder and no saved session, and it never starts while Claude is out of
 * quota. Events carry the purpose and the sizes, never the text.
 */

export class CloudTextError extends Error {
  override name = 'CloudTextError';
  readonly code: 'unavailable' | 'quota' | 'blocked' | 'failed';

  constructor(code: CloudTextError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface CloudTextDeps {
  sql: Sql;
  claude: ClaudeExecutor | undefined;
  /** data/: the empty folder of the run goes in data/worktrees. */
  data: string;
}

export interface CloudTextRequest {
  /**
   * Our fixed instructions (L0), then the public text. A part is L0 unless it
   * says L1: the brief the router's advisor judges (D-207).
   */
  parts: readonly { text: string; source: string; label?: 'L0' | 'L1' }[];
  /** What it is for, in gateway_log and the events (no text of the request). */
  purpose: string;
  timeoutMs?: number;
  /** Sonnet by default; Opus for the examples of the styles (choice of the user, D-185). */
  model?: 'sonnet' | 'opus';
  /**
   * The task the request is about (the advisor's brief): its row of the
   * gateway is tied to it, so an incognito conversation keeps no text of it
   * and «Elimina» takes it (D-297).
   */
  taskId?: string;
}

/** A function that answers a request with Sonnet; a fake in the tests. */
export type AskCloudText = (request: CloudTextRequest) => Promise<string>;

export function createCloudText(deps: CloudTextDeps): AskCloudText {
  return async (request) => {
    const claude = deps.claude;
    if (claude === undefined) throw new CloudTextError('unavailable', 'Claude non è disponibile su questa installazione');
    if ((await budgetOf(deps.sql)).blocked.some((entry) => entry.executor === 'claude')) throw new CloudTextError('quota', 'Claude è senza quota: riprova dopo il reset');
    const folder = { data: deps.data, runId: `text-${randomBytes(8).toString('hex')}` };
    const workspace = await prepareEmptyWorkspace(folder);
    try {
      const launch = { workspace, model: request.model ?? 'sonnet', tools: [], persistSession: false, limits: { maxTurns: 3, timeoutMs: request.timeoutMs ?? 8 * 60_000 } };
      await claude.check(launch);
      const decision = await passGateway(
        deps.sql,
        request.parts.map((part) => ({ value: part.text, label: part.label ?? 'L0', source: part.source })),
        createContext('L1', request.parts.some((part) => part.label === 'L1') ? 'L1' : 'L0'),
        { kind: 'executor', id: 'claude', locality: 'cloud' },
        { summary: request.purpose, ...(request.taskId === undefined ? {} : { taskId: request.taskId }) },
      );
      if (decision.decision === 'block') throw new CloudTextError('blocked', `il gateway ha fermato la richiesta: ${decision.reason}`);
      const run = claude.start({ ...launch, brief: decision });
      const result = await run.result;
      await appendEvent(deps.sql, { kind: 'cloud.text', label: 'L0', payload: { purpose: request.purpose, chars: result.text.length, model: result.model } }).catch(() => undefined);
      return result.text;
    } catch (error) {
      if (error instanceof CloudTextError) throw error;
      if (error instanceof ClaudeError) {
        throw new CloudTextError(error.kind === 'quota' || error.kind === 'overage' ? 'quota' : 'failed', `Claude non ha risposto (${error.kind})`);
      }
      throw error;
    } finally {
      await removeWorkspace(folder).catch(() => undefined);
    }
  };
}
