import { join } from 'node:path';

import { AGENTS_DIR, loadAgent } from '@arianna/agents';
import { loadConfig } from '@arianna/config';
import { createLocalModel, type LocalModel } from '@arianna/executors';

import { canary, matchesCanary } from './canary.ts';
import { contract, matchesContract } from './contract.ts';
import { evaluateGateway } from './gateway.ts';
import { createOrchestratorEvaluator, matchesExpectation, type OrchestratorActual } from './orchestrator.ts';
import { evaluateRouter, matchesRouterExpectation } from './router.ts';
import type { Evaluate, EvalGroup } from './types.ts';

/** The orchestrator on the configured local model, created at the first case. */
function orchestrator(): Evaluate {
  let model: LocalModel | undefined;
  let prompt: string | undefined;
  return (input) => {
    if (model === undefined || prompt === undefined) {
      const config = loadConfig();
      if (config.local.endpoints.length === 0) {
        throw new Error('no [[local.endpoints]] in config/arianna.toml: install oMLX and configure it (task 1.4)');
      }
      model = createLocalModel({ endpoints: config.local.endpoints });
      prompt = loadAgent(join(config.home, AGENTS_DIR), 'arianna').prompt;
    }
    const ready = model;
    return createOrchestratorEvaluator(() => ready, prompt)(input);
  };
}

/** Every group of docs/EVALS.md, with its tier and threshold. */
export const GROUPS: readonly EvalGroup[] = [
  {
    name: 'gateway',
    tier: 'deterministic',
    threshold: 1,
    strictTags: [],
    subject: { status: 'active', evaluate: evaluateGateway },
  },
  {
    name: 'router',
    tier: 'deterministic',
    threshold: 0.95,
    strictTags: ['privacy'],
    compare: matchesRouterExpectation,
    subject: { status: 'active', evaluate: evaluateRouter },
  },
  {
    // Thresholds per measure (docs/EVALS.md); the overall rate is not a criterion.
    name: 'orchestrator',
    tier: 'models',
    threshold: 0,
    strictTags: [],
    compare: matchesExpectation,
    measures: [
      {
        name: 'schema',
        threshold: 1,
        excludeErrors: true,
        passed: (result) => (result.actual as OrchestratorActual | undefined)?.schemaOk === true,
      },
      { name: 'tool', tag: 'tool', threshold: 0.85 },
      { name: 'refusal', tag: 'refusal', threshold: 1 },
      { name: 'recovery', tag: 'recovery', threshold: 0.7 },
      { name: 'plan', tag: 'plan', threshold: 0.85 },
    ],
    subject: { status: 'active', evaluate: orchestrator() },
  },
  {
    name: 'extraction',
    tier: 'models',
    threshold: 0.9,
    strictTags: [],
    subject: { status: 'pending', until: 'phase 2' },
  },
  {
    name: 'retrieval',
    tier: 'models',
    threshold: 0.85,
    strictTags: [],
    subject: { status: 'pending', until: 'phase 2' },
  },
  {
    name: 'contract',
    tier: 'live',
    threshold: 1,
    strictTags: [],
    compare: matchesContract,
    subject: { status: 'active', evaluate: contract() },
  },
  {
    name: 'canary',
    tier: 'live',
    threshold: 1,
    strictTags: [],
    compare: matchesCanary,
    subject: { status: 'active', evaluate: canary() },
  },
];
