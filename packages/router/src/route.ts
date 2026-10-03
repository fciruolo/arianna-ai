// The router (docs/ROUTER-SPEC.md): privacy filter, budget filter, difficulty
// by rules, choice with escalation. Pure: no I/O, no model, no clock. The core
// writes every decision to router_decisions.
import type { Difficulty, ExecutorKind } from '@arianna/agents';
import { canSendTo, isAtMost, isContext, labelOrDefault, type Context, type Label, type Locality } from '@arianna/policy';

import {
  candidateKey,
  createRouterConfig,
  executorOf,
  isCloudExecutor,
  isRouterConfig,
  type Candidate,
  type ModelAlias,
  type RouterConfig,
} from './config.ts';
import { estimateDifficulty } from './difficulty.ts';

export const STEP_KINDS = ['extract', 'classify', 'summarize', 'plan', 'judge', 'coding', 'review'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Why an attempt counts as insufficient: the step is escalated. */
export const ATTEMPT_OUTCOMES = ['tests-failed', 'review-negative', 'stuck'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** What the router needs of an agent card; an `AgentCard` fits. */
export interface RouterAgent {
  name: string;
  executors: readonly ExecutorKind[];
  maxLabel: Label;
  /** Highest label a cloud executor of this agent may see. */
  cloudMaxLabel?: Label;
  difficulty: Difficulty;
}

export interface Attempt {
  executor: ExecutorKind;
  model: ModelAlias;
  outcome: AttemptOutcome;
}

export interface Step {
  kind: StepKind;
  agent: RouterAgent;
  /** Read by the keyword rules only; never copied into the decision. */
  text?: string;
  /** Files the step touches, when known. */
  files?: number;
  /** Earlier insufficient attempts of this step, oldest first. */
  attempts?: readonly Attempt[];
  /** The user approved the budget for Fable on this step. */
  budgetApproved?: boolean;
  /**
   * The model the user chose for the conversation (task 1.10): taken when it
   * is an installed candidate of this step that privacy, the agent, the budget
   * and the escalation allow; otherwise the ladder decides as usual.
   */
  preferredModel?: ModelAlias;
}

/**
 * An executor (or one of its models, with `model`) that cannot take work now:
 * `cap` for an exhausted cap of Arianna's own accounting, `quota` for the
 * quota error of the binary. `until` is when it is expected back, as ISO 8601.
 */
export interface BudgetBlock {
  executor: ExecutorKind;
  model?: ModelAlias;
  cause: 'cap' | 'quota';
  until?: string;
}

export interface Budget {
  blocked: readonly BudgetBlock[];
}

/** Why a candidate was not chosen, in the order the filters apply. */
export type Exclusion = 'not-for-step' | 'privacy' | 'agent' | 'cap' | 'quota' | 'escalation' | 'not-chosen';

export interface CandidateOutcome {
  executor: ExecutorKind;
  model: ModelAlias;
  outcome: 'chosen' | Exclusion;
}

interface DecisionBase {
  /** The effective label the decision was made for. */
  label: Label;
  difficulty: Difficulty;
  /** Labels, rules and candidate names only, never content. */
  reason: string;
  /** Every configured candidate, with what happened to it. */
  candidates: CandidateOutcome[];
  /** `executor/model` of the last insufficient attempt. */
  escalatedFrom?: string;
}

export type RouteDecision =
  | (DecisionBase & {
      decision: 'route';
      executor: ExecutorKind;
      model: ModelAlias;
      locality: Locality;
      /** The step may start only after the user approves this budget. */
      approval?: 'budget';
    })
  | (DecisionBase & {
      decision: 'wait';
      /** `retry-later`: schedule the step again at `retryAt`. `wait-user`: the task goes to "Attende te". */
      next: 'retry-later' | 'wait-user';
      retryAt?: string;
    });

/** Models in order of strength; each tier lists alternatives in order of preference. */
type Ladder = readonly (readonly ModelAlias[])[];

const LOCAL_SMALL_FIRST: Ladder = [['local-small'], ['local-large']];
const LOCAL_LARGE: Ladder = [['local-large']];
const CLOUD_CODING: Ladder = [['sonnet'], ['opus', 'codex'], ['fable']];
// A second opinion comes best from a different family of models.
const CLOUD_REVIEW: Ladder = [['codex', 'sonnet'], ['opus'], ['fable']];

/** First tier for each difficulty, clipped to the ladder. */
const START_TIER: Record<Difficulty, number> = { trivial: 0, normal: 0, hard: 1, critical: 2 };

/** Only behind a budget approval (docs/ROUTER-SPEC.md). */
const NEEDS_BUDGET_APPROVAL: readonly ModelAlias[] = ['fable'];

function tierOf(ladder: Ladder, model: string): number {
  return ladder.findIndex((tier) => (tier as readonly string[]).includes(model));
}

const EXECUTOR_KINDS: readonly string[] = ['local', 'claude', 'codex'];
// ISO 8601 with an explicit offset: a date without one would be read in local time.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Steps and budgets also come from JSON, where the types do not hold. Returns
 * the budget with every `until` normalized to UTC ISO 8601.
 */
function check(step: Step, budget: Budget): Budget {
  if (!(STEP_KINDS as readonly string[]).includes(step.kind)) throw new TypeError(`unknown step kind ${JSON.stringify(step.kind)}`);
  if (step.preferredModel !== undefined && executorOf(step.preferredModel) === undefined) {
    throw new TypeError(`unknown preferred model ${JSON.stringify(step.preferredModel)}`);
  }
  const attempts: unknown = step.attempts ?? [];
  if (!Array.isArray(attempts)) throw new TypeError('attempts must be a list');
  for (const attempt of attempts as readonly (Partial<Attempt> | null)[]) {
    if (typeof attempt !== 'object' || attempt === null) throw new TypeError('an attempt must be an object');
    if (!(ATTEMPT_OUTCOMES as readonly string[]).includes(attempt.outcome as string)) {
      throw new TypeError(`unknown attempt outcome ${JSON.stringify(attempt.outcome)}`);
    }
    const executor = executorOf(String(attempt.model));
    if (executor === undefined || executor !== attempt.executor) throw new TypeError('an attempt names an unknown executor or model');
  }
  const blocked: unknown = budget.blocked;
  if (!Array.isArray(blocked)) throw new TypeError('budget.blocked must be a list');
  return {
    blocked: (blocked as readonly (Partial<BudgetBlock> | null)[]).map((block) => {
      if (typeof block !== 'object' || block === null) throw new TypeError('a budget block must be an object');
      if (block.cause !== 'cap' && block.cause !== 'quota') throw new TypeError(`unknown budget cause ${JSON.stringify(block.cause)}`);
      if (!EXECUTOR_KINDS.includes(block.executor as string)) throw new TypeError('a budget block names an unknown executor');
      if (block.model !== undefined && executorOf(block.model) !== block.executor) {
        throw new TypeError('a budget block names a model of another executor');
      }
      if (block.until === undefined) return { executor: block.executor as ExecutorKind, ...(block.model === undefined ? {} : { model: block.model }), cause: block.cause };
      if (typeof block.until !== 'string' || !ISO_WITH_OFFSET.test(block.until) || Number.isNaN(Date.parse(block.until))) {
        throw new TypeError('budget until must be an ISO 8601 date with an offset');
      }
      return {
        executor: block.executor as ExecutorKind,
        ...(block.model === undefined ? {} : { model: block.model }),
        cause: block.cause,
        until: new Date(block.until).toISOString(),
      };
    }),
  };
}

/**
 * Chooses executor and model for a step. `context` is the run's policy
 * context: its effective label includes contamination. A context not issued by
 * the policy counts as L2 (default-deny), so it never reaches the cloud. A
 * configuration not made by `createRouterConfig` is validated first.
 */
export function route(step: Step, context: Context, rawBudget: Budget, rawConfig: RouterConfig): RouteDecision {
  const budget = check(step, rawBudget);
  const config = isRouterConfig(rawConfig) ? rawConfig : createRouterConfig(rawConfig.candidates);
  const { agent } = step;
  const issued = isContext(context);
  const label = issued ? labelOrDefault(context.effective) : 'L2';
  const notes = issued ? [] : ['context not issued by the policy, read as L2'];
  const attempts = step.attempts ?? [];
  const signals = {
    base: agent.difficulty,
    ...(step.text === undefined ? {} : { text: step.text }),
    ...(step.files === undefined ? {} : { files: step.files }),
  };
  // The logged difficulty counts the failures; the starting tier does not,
  // because the floor already escalates past them (Sonnet → Opus → Fable).
  const estimate = estimateDifficulty({ ...signals, failedAttempts: attempts.length });
  const startDifficulty = estimateDifficulty(signals).difficulty;
  const difficulty = estimate.difficulty;
  const last = attempts.at(-1);
  const escalatedFrom = last === undefined ? {} : { escalatedFrom: candidateKey(last) };
  const base = { label, difficulty, ...escalatedFrom };

  const cloudCeiling = agent.cloudMaxLabel ?? agent.maxLabel;
  // claude and codex are cloud whatever the configuration says.
  const localityOf = (candidate: Candidate): Locality => (isCloudExecutor(candidate.executor) ? 'cloud' : candidate.locality);
  const privacyOk = (candidate: Candidate): boolean => {
    const locality = localityOf(candidate);
    return canSendTo(locality, label) && (locality === 'local' || isAtMost(label, cloudCeiling));
  };
  const agentOk = (candidate: Candidate): boolean => agent.executors.includes(candidate.executor);
  const blocksOf = (candidate: Candidate): BudgetBlock[] =>
    budget.blocked.filter(
      (block) => block.executor === candidate.executor && (block.model === undefined || block.model === candidate.model),
    );
  /** When every block on the candidate is expected to lift; undefined if one has no reset. */
  const backAt = (candidate: Candidate): string | undefined => {
    const untils = blocksOf(candidate).map((block) => block.until);
    if (untils.length === 0 || untils.some((until) => until === undefined)) return undefined;
    return (untils as string[]).sort().at(-1);
  };

  const describe = (choice: string): string => {
    const rules = estimate.rules.length > 0 ? `; rules: ${estimate.rules.join(', ')}` : '';
    const parts = [`${step.kind} at ${label} for ${agent.name}, difficulty ${difficulty} (default ${agent.difficulty}${rules})`, ...notes, choice];
    return parts.join('; ');
  };
  const everyCandidate = (outcome: Exclusion): CandidateOutcome[] =>
    config.candidates.map(({ executor, model }) => ({ executor, model, outcome }));

  if (!canSendTo('local', label)) {
    return { decision: 'wait', next: 'wait-user', ...base, reason: describe(`no model reads ${label}`), candidates: everyCandidate('privacy') };
  }
  if (!isAtMost(label, agent.maxLabel)) {
    return {
      decision: 'wait',
      next: 'wait-user',
      ...base,
      reason: describe(`label above the clearance ${agent.maxLabel} of the agent`),
      candidates: everyCandidate('privacy'),
    };
  }

  // Coding and review go to the cloud when privacy and the agent allow an
  // installed cloud candidate; otherwise to the large local model. The budget
  // does not move a step from the cloud to the local model: it waits instead.
  let ladder: Ladder;
  let cloudLadder: Ladder | undefined;
  if (step.kind === 'coding' || step.kind === 'review') {
    cloudLadder = step.kind === 'coding' ? CLOUD_CODING : CLOUD_REVIEW;
    const inCloud = config.candidates.filter((candidate) => tierOf(cloudLadder ?? [], candidate.model) !== -1);
    const reachable = inCloud.some((candidate) => privacyOk(candidate) && agentOk(candidate));
    ladder = reachable ? cloudLadder : LOCAL_LARGE;
    if (!reachable && inCloud.length > 0) {
      notes.push(inCloud.some(privacyOk) ? 'cloud excluded: agent' : 'cloud excluded: privacy');
    }
  } else {
    ladder = step.kind === 'plan' || step.kind === 'judge' ? LOCAL_LARGE : LOCAL_SMALL_FIRST;
  }

  // Escalation: never again at or below the tier of a failed attempt.
  const failedTiers = attempts.map((attempt) => tierOf(ladder, attempt.model));
  const floor = Math.max(-1, ...failedTiers) + 1;
  // Tiers where privacy, the agent and the installed candidates leave nothing
  // are skipped upwards: that is the agent's own ladder, not a costlier choice.
  const usable = (tier: number): boolean =>
    config.candidates.some((candidate) => tierOf(ladder, candidate.model) === tier && privacyOk(candidate) && agentOk(candidate));
  let start = Math.max(Math.min(START_TIER[startDifficulty], ladder.length - 1), floor);
  let lowest = floor;
  while (lowest < ladder.length && !usable(lowest)) lowest += 1;
  if (lowest > start) start = lowest;

  const outcomes = new Map<Candidate, CandidateOutcome['outcome']>();
  for (const candidate of config.candidates) {
    const tier = tierOf(ladder, candidate.model);
    const block = blocksOf(candidate)[0];
    let outcome: CandidateOutcome['outcome'] | undefined;
    if (tier === -1) {
      // A cloud candidate left out by the fallback to the local model says why.
      const cloudOnly = cloudLadder !== undefined && ladder !== cloudLadder && tierOf(cloudLadder, candidate.model) !== -1;
      outcome = cloudOnly && !privacyOk(candidate) ? 'privacy' : cloudOnly && !agentOk(candidate) ? 'agent' : 'not-for-step';
    } else if (!privacyOk(candidate)) outcome = 'privacy';
    else if (!agentOk(candidate)) outcome = 'agent';
    else if (tier < floor) outcome = 'escalation';
    else if (block !== undefined) outcome = block.cause;
    else if (tier > start) outcome = 'not-chosen';
    if (outcome !== undefined) outcomes.set(candidate, outcome);
  }
  const list = (): CandidateOutcome[] =>
    config.candidates.map((candidate) => ({
      executor: candidate.executor,
      model: candidate.model,
      outcome: outcomes.get(candidate) ?? 'not-chosen',
    }));

  if (floor >= ladder.length) {
    return { decision: 'wait', next: 'wait-user', ...base, reason: describe('no stronger executor is allowed after the failed attempts'), candidates: list() };
  }

  const choose = (chosen: Candidate, note: string): RouteDecision => {
    outcomes.set(chosen, 'chosen');
    const approval = NEEDS_BUDGET_APPROVAL.includes(chosen.model) && step.budgetApproved !== true ? { approval: 'budget' as const } : {};
    return {
      decision: 'route',
      executor: chosen.executor,
      model: chosen.model,
      locality: localityOf(chosen),
      ...approval,
      ...base,
      reason: describe(`${candidateKey(chosen)}${note}${'approval' in approval ? ', needs budget approval' : ''}`),
      candidates: list(),
    };
  };

  // The user's choice for the conversation wins over the ladder when nothing
  // excludes it: a stronger model than the ladder would pick is their call,
  // a weaker one than a failed attempt is not.
  if (step.preferredModel !== undefined) {
    const preferred = config.candidates.find((candidate) => candidate.model === step.preferredModel);
    // `not-chosen` (above the starting tier) is the ladder's exclusion, not a rule's.
    const excluded = preferred === undefined ? undefined : outcomes.get(preferred);
    if (preferred !== undefined && (excluded === undefined || excluded === 'not-chosen')) return choose(preferred, ' (chosen by the user)');
    notes.push(preferred === undefined ? `preferred ${step.preferredModel} not installed` : `preferred ${step.preferredModel} excluded: ${excluded ?? 'not-chosen'}`);
  }

  // From the starting tier down to the floor: a model that is out of budget or
  // not installed is replaced by a weaker one, never by a stronger (costlier) one.
  for (let tier = start; tier >= floor; tier -= 1) {
    for (const model of ladder[tier] ?? []) {
      const chosen = config.candidates.find((candidate) => candidate.model === model && !outcomes.has(candidate));
      if (chosen === undefined) continue;
      return choose(chosen, tier < start ? ` (tier ${String(start)} unavailable)` : '');
    }
  }

  // Nothing usable: if the budget is what stops the allowed candidates, retry
  // when the first of them is expected back; otherwise ask the user.
  const allowed = config.candidates.filter((candidate) => {
    const tier = tierOf(ladder, candidate.model);
    return tier >= floor && tier <= start && privacyOk(candidate) && agentOk(candidate);
  });
  const retryAt = allowed
    .map(backAt)
    .filter((until): until is string => until !== undefined)
    .sort()
    .at(0);
  if (retryAt !== undefined) {
    return { decision: 'wait', next: 'retry-later', retryAt, ...base, reason: describe(`budget exhausted, retry at ${retryAt}`), candidates: list() };
  }
  const why = allowed.length > 0 ? 'budget exhausted with no expected reset' : 'no executor allowed for this step is installed';
  return { decision: 'wait', next: 'wait-user', ...base, reason: describe(why), candidates: list() };
}
