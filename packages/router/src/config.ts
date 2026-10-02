// The executors and models the router may choose from (docs/ROUTER-SPEC.md).
// Model names are aliases: `arianna.toml` maps them to real names, never the code.
import type { ExecutorKind } from '@arianna/agents';
import type { Locality } from '@arianna/policy';

export const MODEL_ALIASES = ['local-small', 'local-large', 'sonnet', 'opus', 'fable', 'codex'] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

/** One executor with one model, as configured on this machine. */
export interface Candidate {
  executor: ExecutorKind;
  model: ModelAlias;
  /** From the endpoint configuration, not from the name of the binary. */
  locality: Locality;
}

export interface RouterConfig {
  readonly candidates: readonly Candidate[];
}

export class RouterConfigError extends Error {
  override name = 'RouterConfigError';
}

/** Which executor runs each model alias. */
const EXECUTOR_OF: Record<ModelAlias, ExecutorKind> = {
  'local-small': 'local',
  'local-large': 'local',
  sonnet: 'claude',
  opus: 'claude',
  fable: 'claude',
  codex: 'codex',
};

const LOCALITIES: readonly Locality[] = ['local', 'cloud'];

/** Inference of these binaries is always in the cloud: declaring them local is a bug or an attack. */
const CLOUD_EXECUTORS: readonly ExecutorKind[] = ['claude', 'codex'];

// Configurations made here, and only these, are trusted by `route`: an object
// literal could declare claude local. Same pattern as contexts in the policy.
const issued = new WeakSet<RouterConfig>();

/** Not a type guard: every RouterConfig has the right shape, only issued ones are trusted. */
export function isRouterConfig(value: unknown): boolean {
  return typeof value === 'object' && value !== null && issued.has(value as RouterConfig);
}

export function isCloudExecutor(executor: string): boolean {
  return (CLOUD_EXECUTORS as readonly string[]).includes(executor);
}

/** The executor that runs a model alias, or undefined for an unknown alias. */
export function executorOf(model: string): ExecutorKind | undefined {
  return (MODEL_ALIASES as readonly string[]).includes(model) ? EXECUTOR_OF[model as ModelAlias] : undefined;
}

export function candidateKey(candidate: { executor: string; model: string }): string {
  return `${candidate.executor}/${candidate.model}`;
}

/**
 * Validates the candidates and freezes them. Rejected: an alias on the wrong
 * executor, a cloud binary declared local, the same candidate twice.
 */
export function createRouterConfig(candidates: readonly Candidate[]): RouterConfig {
  // Configurations also come from JSON and object literals, where the types do not hold.
  const list: unknown = candidates;
  if (!Array.isArray(list)) throw new RouterConfigError('router candidates must be a list');
  const seen = new Set<string>();
  const frozen = candidates.map((candidate) => {
    const { executor, model, locality } = candidate;
    const where = `router candidate ${candidateKey(candidate)}`;
    if (!(MODEL_ALIASES as readonly string[]).includes(model)) throw new RouterConfigError(`${where}: unknown model alias`);
    if (EXECUTOR_OF[model] !== executor) throw new RouterConfigError(`${where}: ${model} runs on ${EXECUTOR_OF[model]}`);
    if (!(LOCALITIES as readonly string[]).includes(locality)) throw new RouterConfigError(`${where}: locality must be local or cloud`);
    if (CLOUD_EXECUTORS.includes(executor) && locality !== 'cloud') {
      throw new RouterConfigError(`${where}: ${executor} always runs in the cloud`);
    }
    const key = candidateKey(candidate);
    if (seen.has(key)) throw new RouterConfigError(`${where}: listed twice`);
    seen.add(key);
    return Object.freeze({ executor, model, locality });
  });
  const config = Object.freeze({ candidates: Object.freeze(frozen) });
  issued.add(config);
  return config;
}
