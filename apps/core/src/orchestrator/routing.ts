import { aliasesOf, type AriannaConfig } from '@arianna/config';
import { CLAUDE_MODELS } from '@arianna/executors';
import { createRouterConfig, MODEL_ALIASES, type Budget, type BudgetBlock, type Candidate, type ModelAlias, type RouterConfig } from '@arianna/router';

import type { Queryable } from '../db/client.ts';

/**
 * What the router may choose from on this installation (task 1.10, D-055):
 * the local aliases a role serves, and the models of each cloud executor the
 * user enabled in `[cloud] executors` and that has an adapter. Codex waits
 * for its adapter (task 1.16): enabled or not, it is not a candidate yet.
 */
export function routerConfigOf(config: AriannaConfig): RouterConfig {
  const candidates: Candidate[] = [];
  for (const alias of Object.keys(aliasesOf(config.roles))) {
    if ((MODEL_ALIASES as readonly string[]).includes(alias)) candidates.push({ executor: 'local', model: alias as ModelAlias, locality: 'local' });
  }
  if (config.cloud.executors.includes('claude')) {
    for (const model of CLAUDE_MODELS) candidates.push({ executor: 'claude', model, locality: 'cloud' });
  }
  return createRouterConfig(candidates);
}

/** The cloud models the user may choose for a work conversation: the cloud candidates of the router. */
export function selectableModels(config: AriannaConfig): { executor: string; model: ModelAlias }[] {
  return routerConfigOf(config)
    .candidates.filter((candidate) => candidate.locality === 'cloud')
    .map(({ executor, model }) => ({ executor, model }));
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
