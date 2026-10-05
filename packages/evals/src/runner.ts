import { isDeepStrictEqual } from 'node:util';

import type {
  CaseResult,
  EvalCase,
  EvalGroup,
  Evaluate,
  GroupReport,
  Tier,
  TierReport,
} from './types.ts';

/** Class name and `code` or `kind` of an error, never its message (like `errorCode` of the core's jobs). */
export function caseErrorCode(error: unknown): string {
  const record = error as { code?: unknown; kind?: unknown } | null;
  const detail = typeof record?.code === 'string' ? record.code : typeof record?.kind === 'string' ? record.kind : undefined;
  const name = error instanceof Error ? error.name : typeof error;
  const text = detail === undefined ? name : `${name}:${detail}`;
  return /^[\w.:-]{1,100}$/.test(text) ? text : 'error';
}

async function runCase(
  evaluate: Evaluate,
  evalCase: EvalCase,
  compare: (actual: unknown, expect: unknown) => boolean,
  signal: AbortSignal | undefined,
): Promise<CaseResult> {
  const started = performance.now();
  const base = { id: evalCase.id, tags: evalCase.tags };
  try {
    const actual = await evaluate(evalCase.input, signal);
    const durationMs = performance.now() - started;
    return { ...base, passed: compare(actual, evalCase.expect), durationMs, actual };
  } catch (error) {
    // A crashing evaluator is a failed case, not a crashed run.
    const durationMs = performance.now() - started;
    return {
      ...base,
      passed: false,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
      errorCode: caseErrorCode(error),
    };
  }
}

/**
 * Optional hooks of a run (D-081: a trial of a model inside the core). Without
 * them a run is what it always was: every case once, in order.
 */
export interface RunHooks {
  /** Stops the run: the case in progress gets it, no other case starts, `runGroup` rejects with its reason. */
  signal?: AbortSignal;
  /** Awaited before each attempt of a case, outside the time of the case (waiting for a free machine). */
  beforeCase?: () => Promise<void>;
  /**
   * A signal for one attempt of a case: when it fires before the case ends,
   * the result is dropped and the case runs again, after `beforeCase`
   * (preemption). `stop` is called once the attempt is over.
   */
  watchCase?: () => { signal: AbortSignal; stop: () => void };
  /** Each kept result, as it comes: `index` from 0, of `total`. */
  onResult?: (result: CaseResult, index: number, total: number) => void;
}

/** A function, not a property read: TypeScript would keep a narrowing across the awaits. */
function aborted(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

function stopped(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('the run was stopped', 'AbortError');
}

/** One case under the hooks: attempts until one is not preempted. */
async function supervisedCase(
  evaluate: Evaluate,
  evalCase: EvalCase,
  compare: (actual: unknown, expect: unknown) => boolean,
  hooks: RunHooks,
): Promise<CaseResult> {
  for (;;) {
    await hooks.beforeCase?.();
    if (aborted(hooks.signal)) throw stopped(hooks.signal);
    const watch = hooks.watchCase?.();
    const signals = [hooks.signal, watch?.signal].filter((item): item is AbortSignal => item !== undefined);
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    let result: CaseResult;
    try {
      result = await runCase(evaluate, evalCase, compare, signal);
    } finally {
      watch?.stop();
    }
    if (aborted(hooks.signal)) throw stopped(hooks.signal);
    if (aborted(watch?.signal)) continue;
    return result;
  }
}

export async function runGroup(group: EvalGroup, cases: EvalCase[], hooks: RunHooks = {}): Promise<GroupReport> {
  if (group.subject.status === 'pending') {
    return { name: group.name, status: 'pending', until: group.subject.until, cases: cases.length };
  }

  const results: CaseResult[] = [];
  for (const [index, evalCase] of cases.entries()) {
    const result = await supervisedCase(group.subject.evaluate, evalCase, group.compare ?? isDeepStrictEqual, hooks);
    results.push(result);
    hooks.onResult?.(result, index, cases.length);
  }

  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const rate = total === 0 ? 0 : passed / total;

  const reasons: string[] = [];
  // An active group without cases proves nothing: it must not pass by default.
  if (total === 0) reasons.push('no cases');
  if (total > 0 && rate < group.threshold) reasons.push('pass rate below threshold');
  for (const tag of group.strictTags) {
    const failed = results.filter((result) => !result.passed && result.tags.includes(tag));
    if (failed.length > 0) {
      reasons.push(`"${tag}" cases must all pass: ${failed.map((result) => result.id).join(', ')}`);
    }
  }

  const measures = (group.measures ?? []).map((measure) => {
    const scope = results.filter(
      (result) =>
        (measure.tag === undefined || result.tags.includes(measure.tag)) && !(measure.excludeErrors === true && result.error !== undefined),
    );
    const ok = scope.filter((result) => (measure.passed ?? ((r: CaseResult) => r.passed))(result)).length;
    const measured = { name: measure.name, total: scope.length, passed: ok, rate: scope.length === 0 ? 0 : ok / scope.length, threshold: measure.threshold };
    // A measure without cases proves nothing, like a group without cases.
    if (scope.length === 0) reasons.push(`measure "${measure.name}" has no cases`);
    else if (measured.rate < measure.threshold) reasons.push(`measure "${measure.name}" below threshold`);
    return measured;
  });

  // Cases that crashed say nothing about the speed of the subject.
  const durations = results
    .filter((result) => result.error === undefined)
    .map((result) => result.durationMs)
    .sort((a, b) => a - b);
  const latency = {
    medianMs: durations.length === 0 ? 0 : (durations[Math.floor((durations.length - 1) / 2)] ?? 0),
    maxMs: durations.at(-1) ?? 0,
  };

  return {
    name: group.name,
    status: reasons.length === 0 ? 'passed' : 'failed',
    threshold: group.threshold,
    total,
    passed,
    rate,
    measures,
    latency,
    reasons,
    results,
  };
}

export async function runTier(
  tier: Tier,
  groups: readonly EvalGroup[],
  loadGroupCases: (group: string) => EvalCase[],
): Promise<TierReport> {
  const reports: GroupReport[] = [];
  for (const group of groups.filter((candidate) => candidate.tier === tier)) {
    reports.push(await runGroup(group, loadGroupCases(group.name)));
  }
  return { tier, ok: reports.every((report) => report.status !== 'failed'), groups: reports };
}
