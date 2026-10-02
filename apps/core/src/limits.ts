/**
 * Task caps (docs/ROUTER-SPEC.md, "Tetti per task"): steps, minutes of work
 * and euro beyond the subscriptions. Past a cap the task waits for the user.
 * Pure functions: the engine reads the usage from `runs`.
 */
export interface TaskLimits {
  maxSteps?: number;
  maxMinutes?: number;
  /** Euro beyond the subscriptions; 0 means no paid usage at all, not "no cap". */
  maxCost?: number;
}

export interface TaskUsage {
  steps: number;
  /** Minutes the task's runs have been working; waiting for the user does not count. */
  minutes: number;
  cost: number;
}

export type LimitName = 'steps' | 'minutes' | 'cost';

export interface LimitReached {
  limit: LimitName;
  used: number;
  max: number;
}

/** Reads `tasks.limits` (snake_case JSON, as in the agent cards). Unknown keys and bad values throw. */
export function parseLimits(value: unknown): TaskLimits {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('limits must be an object');
  }
  const raw = value as Record<string, unknown>;
  const limits: TaskLimits = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
      throw new TypeError(`limits.${key} must be a number of at least 0`);
    }
    if (key === 'max_steps') limits.maxSteps = entry;
    else if (key === 'max_minutes') limits.maxMinutes = entry;
    else if (key === 'max_cost') limits.maxCost = entry;
    else throw new TypeError(`limits: unknown key ${key}`);
  }
  return limits;
}

/** The first cap already reached, or undefined. A cap is reached at equality: no step starts past it. */
export function limitReached(limits: TaskLimits, usage: TaskUsage): LimitReached | undefined {
  if (limits.maxSteps !== undefined && usage.steps >= limits.maxSteps) {
    return { limit: 'steps', used: usage.steps, max: limits.maxSteps };
  }
  if (limits.maxMinutes !== undefined && usage.minutes >= limits.maxMinutes) {
    return { limit: 'minutes', used: usage.minutes, max: limits.maxMinutes };
  }
  // Cost is checked as "over", so that max_cost 0 lets free steps run.
  if (limits.maxCost !== undefined && usage.cost > limits.maxCost) {
    return { limit: 'cost', used: usage.cost, max: limits.maxCost };
  }
  return undefined;
}

/** Milliseconds the next step may work before the time cap; undefined without one. */
export function remainingMs(limits: TaskLimits, usage: TaskUsage): number | undefined {
  if (limits.maxMinutes === undefined) return undefined;
  return Math.max(0, (limits.maxMinutes - usage.minutes) * 60_000);
}

/** One line for "Attende te". */
export function describeLimit(reached: LimitReached): string {
  const round = (n: number) => String(Math.round(n * 100) / 100);
  const unit = { steps: 'steps', minutes: 'minutes', cost: 'euro' }[reached.limit];
  return `limit reached: ${round(reached.used)} of ${round(reached.max)} ${unit}`;
}

/** The stricter of two sets of caps, key by key (agent card and task). */
export function stricterLimits(a: TaskLimits, b: TaskLimits): TaskLimits {
  const pick = (x: number | undefined, y: number | undefined) => (x === undefined ? y : y === undefined ? x : Math.min(x, y));
  const result: TaskLimits = {};
  const maxSteps = pick(a.maxSteps, b.maxSteps);
  const maxMinutes = pick(a.maxMinutes, b.maxMinutes);
  const maxCost = pick(a.maxCost, b.maxCost);
  if (maxSteps !== undefined) result.maxSteps = maxSteps;
  if (maxMinutes !== undefined) result.maxMinutes = maxMinutes;
  if (maxCost !== undefined) result.maxCost = maxCost;
  return result;
}

/** setTimeout cannot wait longer than this; a longer cap is waited in full at the next step. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
