import type { ActivityKind, LiveEvent } from '../types.ts';
import { ACTIVITY_FRESH_MS, QUOTA_PAUSE_MS, type ActivitySignal } from './snapshot.ts';

export type { ActivitySignal } from './snapshot.ts';

/** The live signals the office reads (D-106): kinds, ids and times only. */
export interface OfficeSignals {
  activity: ActivitySignal[];
  quota: Record<string, number>;
  /** Run → agent, from the `run.started` events seen: `executor.quota` names only its run. */
  runs: Record<string, string>;
}

/** How many runs the office remembers: enough for the runs still going. */
const MAX_RUNS = 50;

export function emptySignals(): OfficeSignals {
  return { activity: [], quota: {}, runs: {} };
}

/** At most one signal per conversation, and only the fresh ones. */
export function noteActivity(signals: OfficeSignals, conversationId: string, kind: ActivityKind, now = Date.now()): void {
  const kept = signals.activity.filter((signal) => signal.conversationId !== conversationId && now - signal.at <= ACTIVITY_FRESH_MS);
  kept.push({ conversationId, kind, at: now });
  signals.activity = kept.slice(-20);
}

/**
 * The pause rule (D-106): `executor.quota` pauses the agent of its run (the
 * event carries only task and run: the agent comes from the `run.started` of
 * that run seen before; unknown, nobody is paused) until the reset time, or
 * an hour without one; the next `run.started` of that agent ends the pause.
 * A rate-limit warning (`executor.rate_limit`) is not a pause: the run goes on.
 */
export function notePause(signals: OfficeSignals, event: Pick<LiveEvent, 'kind' | 'agent' | 'runId' | 'payload'>, now = Date.now()): void {
  if (event.kind === 'run.started') {
    const agent = event.agent;
    if (agent === null) return;
    const runId = event.runId;
    if (runId !== null) {
      const kept: [string, string][] = Object.entries(signals.runs).filter(([run]) => run !== runId);
      kept.push([runId, agent]);
      signals.runs = Object.fromEntries(kept.slice(-MAX_RUNS));
    }
    if (Object.hasOwn(signals.quota, agent)) signals.quota = Object.fromEntries(Object.entries(signals.quota).filter(([name]) => name !== agent));
    return;
  }
  if (event.kind !== 'executor.quota') return;
  const runId = event.runId;
  const agent = event.agent ?? (runId !== null && Object.hasOwn(signals.runs, runId) ? signals.runs[runId] : undefined);
  if (agent === undefined) return;
  const resets = typeof event.payload.resetsAt === 'string' ? Date.parse(event.payload.resetsAt) : Number.NaN;
  signals.quota = { ...signals.quota, [agent]: Number.isNaN(resets) ? now + QUOTA_PAUSE_MS : resets };
}
