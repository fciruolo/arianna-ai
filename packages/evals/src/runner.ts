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

async function runCase(evaluate: Evaluate, evalCase: EvalCase): Promise<CaseResult> {
  const started = performance.now();
  const base = { id: evalCase.id, tags: evalCase.tags };
  try {
    const actual = await evaluate(evalCase.input);
    const durationMs = performance.now() - started;
    return { ...base, passed: isDeepStrictEqual(actual, evalCase.expect), durationMs, actual };
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
    results.push(await runCase(group.subject.evaluate, evalCase));
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

  return {
    name: group.name,
    status: reasons.length === 0 ? 'passed' : 'failed',
    threshold: group.threshold,
    total,
    passed,
    rate,
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
