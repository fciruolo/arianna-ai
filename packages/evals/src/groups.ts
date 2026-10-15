import { loadConfig } from '@arianna/config';
import { createLocalModel, localKeys, type LocalModel } from '@arianna/executors';

import { createAnonymizeGroup } from './anonymize-group.ts';
import { canary, matchesCanary } from './canary.ts';
import { contract, matchesContract } from './contract.ts';
import { createFinanceGroup, financePrompt } from './finance-group.ts';
import { evaluateGateway } from './gateway.ts';
import { ariannaPrompt, createOrchestratorGroup } from './orchestrator-group.ts';
import { evaluateRouter, matchesRouterExpectation } from './router.ts';
import type { EvalGroup } from './types.ts';

let config: ReturnType<typeof loadConfig> | undefined;
const configured = (): ReturnType<typeof loadConfig> => {
  config ??= loadConfig();
  return config;
};

let model: LocalModel | undefined;
/** The configured local model, created at the first case of a group that needs it. */
const configuredModel = (): LocalModel => {
  if (model === undefined) {
    const { local, paths } = configured();
    if (local.endpoints.length === 0) {
      throw new Error('no [[local.endpoints]] in config/arianna.toml: install oMLX and configure it (task 1.4)');
    }
    // The key of a server the core started (D-221).
    model = createLocalModel({ endpoints: local.endpoints, apiKey: localKeys(paths.data, (id) => local.endpoints.some((endpoint) => endpoint.id === id && endpoint.command !== undefined)) });
  }
  return model;
};

/** The orchestrator on the configured local model. */
function orchestrator(): EvalGroup {
  return createOrchestratorGroup({ model: configuredModel, prompt: () => ariannaPrompt(configured().home) });
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
  orchestrator(),
  createFinanceGroup({ model: configuredModel, prompt: () => financePrompt(configured().home) }),
  createAnonymizeGroup(configuredModel),
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
