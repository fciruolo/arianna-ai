import { join } from 'node:path';

import { AGENTS_DIR, loadAgent } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import type { LocalModel } from '@arianna/executors';

import { createOrchestratorEvaluator, matchesExpectation, type OrchestratorActual, type OrchestratorExpectation } from './orchestrator.ts';
import type { Evaluate, EvalGroup, Measure } from './types.ts';

/**
 * What a finance case expects (I-18, D-183): the orchestrator's accepted and
 * forbidden answers, plus figures the reply must quote as the tool wrote them
 * and figures it must not quote (a net taken for a spending, a rounded sum).
 */
export interface FinanceExpectation extends OrchestratorExpectation {
  mentions?: string[];
  avoids?: string[];
}

/** Thresholds per measure (docs/EVALS.md). */
const FINANCE_MEASURES: readonly Measure[] = [
  {
    name: 'schema',
    threshold: 1,
    excludeErrors: true,
    passed: (result) => (result.actual as OrchestratorActual | undefined)?.schemaOk === true,
  },
  { name: 'tool', tag: 'tool', threshold: 0.85 },
  { name: 'figures', tag: 'figures', threshold: 0.8 },
  { name: 'refusal', tag: 'refusal', threshold: 1 },
];

/** Spaces as the model may write them around a figure: a no-break space is a space (case is ignored too). */
function plain(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, ' ');
}

/** `compare` of the finance group: the orchestrator's check, then the figures of the reply. */
export function matchesFinance(actual: unknown, expect: unknown): boolean {
  if (!matchesExpectation(actual, expect)) return false;
  const { mentions = [], avoids = [] } = expect as FinanceExpectation;
  if (mentions.length === 0 && avoids.length === 0) return true;
  const said = plain((actual as OrchestratorActual).text ?? '').toLowerCase();
  const found = (figure: string) => said.includes(plain(figure).toLowerCase());
  return mentions.every(found) && !avoids.some(found);
}

/** The prompt of Finanze, from agents/ of ARIANNA_HOME. */
export function financePrompt(home: string): string {
  return loadAgent(join(home, AGENTS_DIR), 'finanze').prompt;
}

export interface FinanceGroupOptions {
  /** The local model under test; its `local-large` alias is what the cases ask. */
  model: () => LocalModel;
  /** The prompt of Finanze; default `agents/finanze.md` of ARIANNA_HOME, read at the first case. */
  prompt?: () => string;
}

/** The Finanze agent on the local model, cases in evals/finance/. */
export function createFinanceGroup(options: FinanceGroupOptions): EvalGroup {
  const { model, prompt: promptOption = () => financePrompt(resolveHome()) } = options;
  let prompt: string | undefined;
  const evaluate: Evaluate = (input, signal) => {
    prompt ??= promptOption();
    return createOrchestratorEvaluator(model, prompt, true)(input, signal);
  };
  return {
    name: 'finance',
    tier: 'models',
    threshold: 0,
    strictTags: [],
    compare: matchesFinance,
    measures: FINANCE_MEASURES,
    subject: { status: 'active', evaluate },
  };
}
