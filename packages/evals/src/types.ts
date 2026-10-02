/** What a run needs: nothing, a local model, or the official cloud binaries (docs/EVALS.md). */
export const TIERS = ['deterministic', 'models', 'live'] as const;
export type Tier = (typeof TIERS)[number];

/** One line of `evals/<group>/*.jsonl`. */
export interface EvalCase {
  id: string;
  input: unknown;
  expect: unknown;
  tags: string[];
}

export type Evaluate = (input: unknown) => unknown;

export interface EvalGroup {
  name: string;
  tier: Tier;
  /** Minimum pass rate, from 0 to 1. */
  threshold: number;
  /** Cases carrying one of these tags must all pass, whatever the threshold. */
  strictTags: readonly string[];
  /**
   * `pending` while the code under evaluation does not exist yet: the group is
   * reported, never counted as passed, and names the task or phase that will activate it.
   */
  subject: { status: 'active'; evaluate: Evaluate } | { status: 'pending'; until: string };
}

export interface CaseResult {
  id: string;
  passed: boolean;
  tags: string[];
  durationMs: number;
  actual?: unknown;
  error?: string;
}

export type GroupReport =
  | { name: string; status: 'pending'; until: string; cases: number }
  | {
      name: string;
      status: 'passed' | 'failed';
      threshold: number;
      total: number;
      passed: number;
      rate: number;
      /** Why the group failed; empty when it passed. */
      reasons: string[];
      results: CaseResult[];
    };

export interface TierReport {
  tier: Tier;
  ok: boolean;
  groups: GroupReport[];
}
