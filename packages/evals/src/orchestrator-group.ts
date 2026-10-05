import { join } from 'node:path';

import { AGENTS_DIR, loadAgent } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import type { LocalModel } from '@arianna/executors';

import { createOrchestratorEvaluator, matchesExpectation, type OrchestratorActual } from './orchestrator.ts';
import type { Evaluate, EvalGroup, Measure } from './types.ts';

/** Thresholds per measure (docs/EVALS.md); the overall rate is not a criterion. */
const ORCHESTRATOR_MEASURES: readonly Measure[] = [
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
];

/** The prompt of Arianna, from agents/ of ARIANNA_HOME. */
export function ariannaPrompt(home: string): string {
  return loadAgent(join(home, AGENTS_DIR), 'arianna').prompt;
}

export interface OrchestratorGroupOptions {
  /** The local model under test; its `local-large` alias is what the cases ask. */
  model: LocalModel | (() => LocalModel);
  /** The orchestrator's prompt; default `agents/arianna.md` of ARIANNA_HOME, read at the first case. */
  prompt?: string | (() => string);
}

/**
 * The orchestrator group on a given model (D-081): the core runs it on a
 * candidate of the catalog, `GROUPS` on the configured model.
 */
export function createOrchestratorGroup(options: OrchestratorGroupOptions): EvalGroup {
  const { model: given, prompt: promptOption } = options;
  const model = typeof given === 'function' ? given : () => given;
  let prompt: string | undefined;
  const evaluate: Evaluate = (input, signal) => {
    prompt ??= typeof promptOption === 'string' ? promptOption : promptOption === undefined ? ariannaPrompt(resolveHome()) : promptOption();
    return createOrchestratorEvaluator(model, prompt)(input, signal);
  };
  return {
    name: 'orchestrator',
    tier: 'models',
    threshold: 0,
    strictTags: [],
    compare: matchesExpectation,
    measures: ORCHESTRATOR_MEASURES,
    subject: { status: 'active', evaluate },
  };
}
