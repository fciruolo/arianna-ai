import type { AgentCard } from '@arianna/agents';
import { aliasesOf, CLOUD_MODELS, LEGACY_DEFAULT_AGENT, ORCHESTRATOR_AGENT, type AriannaConfig, type CloudModel } from '@arianna/config';
import { CLAUDE_MODELS, CODEX_MODELS } from '@arianna/executors';
import { createRouterConfig, executorOf, MODEL_ALIASES, type Budget, type BudgetBlock, type Candidate, type ModelAlias, type RouterConfig } from '@arianna/router';

import type { Queryable } from '../db/client.ts';

/** Which cloud adapters run on this machine: one whose sandbox is refused offers no model (D-050, D-138). */
export interface CloudAdapters {
  claude: boolean;
  codex: boolean;
}

/**
 * What the router may choose from on this installation (task 1.10, D-055):
 * the local aliases a role serves, and the models of each cloud executor the
 * user enabled in `[cloud] executors` and whose adapter runs here, without
 * the ones turned off in `[cloud.models]` (D-071). Codex is one since its
 * adapter is in the core (D-140, D-111 tappa C).
 */
export function routerConfigOf(config: AriannaConfig, adapters: CloudAdapters): RouterConfig {
  const candidates: Candidate[] = [];
  for (const alias of Object.keys(aliasesOf(config.roles))) {
    if ((MODEL_ALIASES as readonly string[]).includes(alias)) candidates.push({ executor: 'local', model: alias as ModelAlias, locality: 'local' });
  }
  if (adapters.claude && config.cloud.executors.includes('claude')) {
    for (const model of CLAUDE_MODELS) {
      if (config.cloud.models[model].enabled) candidates.push({ executor: 'claude', model, locality: 'cloud' });
    }
  }
  if (adapters.codex && config.cloud.executors.includes('codex')) {
    for (const model of CODEX_MODELS) {
      if (config.cloud.models[model].enabled) candidates.push({ executor: 'codex', model, locality: 'cloud' });
    }
  }
  return createRouterConfig(candidates);
}

/** The cloud models the user may choose for a work conversation: the cloud candidates of the router. */
export function selectableModels(config: AriannaConfig, adapters: CloudAdapters): { executor: string; model: ModelAlias }[] {
  return routerConfigOf(config, adapters)
    .candidates.filter((candidate) => candidate.locality === 'cloud')
    .map(({ executor, model }) => ({ executor, model }));
}

/**
 * The agent a work conversation delegates to until "+ Nuovo" lets the user
 * choose one (D-111, stage B): its model is the one a new work conversation
 * starts with, and the one the old `default` of `[cloud.models]` becomes.
 * Until then the model of any other agent is saved but not used.
 */
export const WORK_AGENT = LEGACY_DEFAULT_AGENT;

/**
 * The cloud models an agent may have as its model (D-116): those of the
 * cloud executors on its card, never one for Arianna, whose model is the
 * orchestrator of `[roles]`, local only. The card already keeps L2 out of
 * the cloud (cloud_max_label), and the router checks again at every step.
 */
export function agentModels(agent: string, card: AgentCard): CloudModel[] {
  if (agent === ORCHESTRATOR_AGENT) return [];
  return CLOUD_MODELS.filter((model) => {
    const executor = executorOf(model);
    return executor !== undefined && card.executors.includes(executor);
  });
}

/**
 * The model a new conversation with `agent` starts with (D-116): its
 * `[agents.<id>] model` while its card allows it and this installation offers
 * it, otherwise none (the router chooses). It never turns an executor on.
 */
export function agentDefaultModel(config: AriannaConfig, agent: string, card: AgentCard | undefined, adapters: CloudAdapters): ModelAlias | undefined {
  const chosen = config.agents[agent]?.model;
  if (chosen === undefined || card === undefined || !agentModels(agent, card).includes(chosen)) return undefined;
  return selectableModels(config, adapters).some((entry) => entry.model === chosen) ? chosen : undefined;
}

/** How long a quota refusal without a reset time keeps an executor blocked. */
const UNKNOWN_RESET_MS = 60 * 60_000;
/** Refusals older than this are not looked at. */
const LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/**
 * The router's budget from the quota refusals the adapters recorded
 * (`executor.quota` events, task 1.5): an executor is blocked until the reset
 * time the binary gave, or for an hour after a refusal without one. Arianna's
 * own caps (task 3.x) are not here yet.
 */
export async function budgetOf(sql: Queryable, now: Date = new Date()): Promise<Budget> {
  const rows = await sql<{ ts: Date; payload: { executor?: unknown; resetsAt?: unknown } }[]>`
    SELECT ts, payload FROM events
    WHERE kind = 'executor.quota' AND ts > ${new Date(now.getTime() - LOOKBACK_MS)}
    ORDER BY events.id DESC`;
  const blocked = new Map<string, BudgetBlock>();
  const seen = new Set<string>();
  for (const row of rows) {
    const executor = row.payload.executor;
    if (executor !== 'claude' && executor !== 'codex') continue;
    // The latest refusal of an executor is the one that counts.
    if (seen.has(executor)) continue;
    seen.add(executor);
    const given = typeof row.payload.resetsAt === 'string' ? Date.parse(row.payload.resetsAt) : Number.NaN;
    const until = Number.isNaN(given) ? row.ts.getTime() + UNKNOWN_RESET_MS : given;
    if (until <= now.getTime()) continue;
    blocked.set(executor, { executor, cause: 'quota', until: new Date(until).toISOString() });
  }
  return { blocked: [...blocked.values()] };
}
