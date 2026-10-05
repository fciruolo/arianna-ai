// Subject of the `router` eval group: the real `route` of @arianna/router.
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';

import { AGENTS_DIR, loadAgent, type AgentCard } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import {
  candidateKey,
  createRouterConfig,
  route,
  type Budget,
  type Candidate,
  type RouterAgent,
  type RouterConfig,
  type Step,
} from '@arianna/router';

import { contextOf, type ContextInput } from './context-input.ts';

/** Every executor and model, as on a machine with everything installed. */
const ALL: Candidate[] = [
  { executor: 'local', model: 'local-small', locality: 'local' },
  { executor: 'local', model: 'local-large', locality: 'local' },
  { executor: 'claude', model: 'sonnet', locality: 'cloud' },
  { executor: 'claude', model: 'opus', locality: 'cloud' },
  { executor: 'claude', model: 'fable', locality: 'cloud' },
  { executor: 'codex', model: 'codex', locality: 'cloud' },
];

/**
 * `agent` is the name of a card in `agents/` or an inline card. `candidates`
 * restricts the configuration to the listed `executor/model` keys, in that order.
 * `context.reads` are labels the run read, in order, applied with `recordRead`
 * (see `contextOf`).
 */
interface RouterInput {
  step: Omit<Step, 'agent'> & { agent: string | RouterAgent };
  context: ContextInput;
  budget?: Budget;
  candidates?: string[];
}

export interface RouterOutcome {
  decision: 'route' | 'wait';
  executor?: string;
  model?: string;
  locality?: string;
  approval?: string;
  next?: string;
  retryAt?: string;
  /** Present only when some read of `context.reads` was denied. */
  deniedReads?: number;
}

const cards = new Map<string, AgentCard>();

function agentOf(agent: string | RouterAgent): RouterAgent {
  if (typeof agent !== 'string') return agent;
  let card = cards.get(agent);
  if (card === undefined) {
    card = loadAgent(join(resolveHome(), AGENTS_DIR), agent).card;
    cards.set(agent, card);
  }
  return card;
}

function configOf(keys: string[] | undefined): RouterConfig {
  if (keys === undefined) return createRouterConfig(ALL);
  return createRouterConfig(
    keys.map((key) => {
      const candidate = ALL.find((item) => candidateKey(item) === key);
      if (candidate === undefined) throw new Error(`unknown candidate ${key}`);
      return candidate;
    }),
  );
}

export function evaluateRouter(raw: unknown): RouterOutcome {
  const input = raw as RouterInput;
  const { context, deniedReads } = contextOf(input.context);
  const denied = deniedReads === 0 ? {} : { deniedReads };
  const step: Step = { ...input.step, agent: agentOf(input.step.agent) };
  const decision = route(step, context, input.budget ?? { blocked: [] }, configOf(input.candidates));
  if (decision.decision === 'route') {
    const { executor, model, locality } = decision;
    return { decision: 'route', executor, model, locality, ...(decision.approval === undefined ? {} : { approval: decision.approval }), ...denied };
  }
  return { decision: 'wait', next: decision.next, ...(decision.retryAt === undefined ? {} : { retryAt: decision.retryAt }), ...denied };
}

/**
 * A case lists only what it checks (a privacy case may expect just
 * `locality: local`); every listed field must match. `approval: null` checks
 * that no approval is asked.
 */
export function matchesRouterExpectation(actual: unknown, expect: unknown): boolean {
  if (typeof actual !== 'object' || actual === null || typeof expect !== 'object' || expect === null) return false;
  const got = actual as Record<string, unknown>;
  return Object.entries(expect).every(([key, value]) => isDeepStrictEqual(got[key] ?? null, value));
}
