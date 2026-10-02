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

async function runCase(
  evaluate: Evaluate,
  evalCase: EvalCase,
  compare: (actual: unknown, expect: unknown) => boolean,
): Promise<CaseResult> {
  const started = performance.now();
  const base = { id: evalCase.id, tags: evalCase.tags };
  try {
    const actual = await evaluate(evalCase.input);
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
    };
  }
}

export async function runGroup(group: EvalGroup, cases: EvalCase[]): Promise<GroupReport> {
  if (group.subject.status === 'pending') {
    return { name: group.name, status: 'pending', until: group.subject.until, cases: cases.length };
  }

  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    results.push(await runCase(group.subject.evaluate, evalCase, group.compare ?? isDeepStrictEqual));
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
