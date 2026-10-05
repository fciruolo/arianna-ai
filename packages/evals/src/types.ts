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

/** `signal` aborts the case (a trial of the core gives way to a call or a task, D-081). */
export type Evaluate = (input: unknown, signal?: AbortSignal) => unknown;

/**
 * A pass rate measured on part of a group, with its own threshold (for
 * instance "schema conformity 100%, right tool 85%" in the orchestrator).
 */
export interface Measure {
  name: string;
  threshold: number;
  /** Only cases with this tag; all cases when omitted. */
  tag?: string;
  /** What passing means for this measure; default: the case passed. */
  passed?: (result: CaseResult) => boolean;
  /** Leave out cases whose evaluator failed (timeout, network): they fail the other measures. */
  excludeErrors?: boolean;
}

export interface EvalGroup {
  name: string;
  tier: Tier;
  /** Minimum pass rate, from 0 to 1. */
  threshold: number;
  /** Cases carrying one of these tags must all pass, whatever the threshold. */
  strictTags: readonly string[];
  /** How a result matches the expectation; default: deep equality. */
  compare?: (actual: unknown, expect: unknown) => boolean;
  /** Extra pass rates, each with its threshold; the group fails if one is missed. */
  measures?: readonly Measure[];
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
  /**
   * The error as a short code (class name and `code` or `kind`), never a
   * message: what the core stores of a failed case (D-081).
   */
  errorCode?: string;
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
      measures: { name: string; total: number; passed: number; rate: number; threshold: number }[];
      /** Median and slowest case, in milliseconds. */
      latency: { medianMs: number; maxMs: number };
      /** Why the group failed; empty when it passed. */
      reasons: string[];
      results: CaseResult[];
    };

export interface TierReport {
  tier: Tier;
  ok: boolean;
  groups: GroupReport[];
}
