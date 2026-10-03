// Acceptance test of the orchestrator on the local model (task 1.4,
// docs/EVALS.md): one model call per case, with schema-constrained decoding.
// The model answers with one JSON object: call a tool, reply, plan, or refuse,
// after a free `thought` (D-051).
import { chatMessages, RESPONSE_SCHEMA_NAME, responseSchema, validate, type ToolId, type TurnMessage } from '@arianna/agents';
import { LocalModelError, type LocalModel } from '@arianna/executors';

import type { Evaluate } from './types.ts';

export interface OrchestratorInput {
  tools: ToolId[];
  /** `tool` messages are tool results or errors, shown to the model as such. */
  messages: TurnMessage[];
}

export interface OrchestratorActual {
  /** `invalid` when the answer has no known action. */
  action: 'call' | 'reply' | 'plan' | 'refuse' | 'invalid';
  tool?: string;
  arguments?: Record<string, unknown>;
  /** "3-5" when the plan has three to five steps, else the count. */
  steps?: string;
  schemaOk: boolean;
}

/** One acceptable (or forbidden) answer. */
export interface Outcome {
  action: OrchestratorActual['action'];
  tool?: string;
  steps?: string;
  /** Checks on string arguments, e.g. a corrected path or a new query. */
  args?: Record<string, { equals?: string; notEqual?: string; prefix?: string }>;
}

/**
 * What a case expects: one of `accept` (any answer when omitted), none of
 * `forbid`, and always an answer that conforms to the schema. Several answers
 * can be right: after an empty search, a new query or a question to the user.
 */
export interface OrchestratorExpectation {
  accept?: Outcome[];
  forbid?: Outcome[];
}

/** What the measures look at, from the model's answer. */
export function summarize(value: unknown, tools: readonly ToolId[], thought = true): OrchestratorActual {
  const schemaOk = validate(responseSchema(tools, thought), value).length === 0;
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const action = record.action;
  if (action === 'call') {
    const args = typeof record.arguments === 'object' && record.arguments !== null ? (record.arguments as Record<string, unknown>) : {};
    return { action, tool: typeof record.tool === 'string' ? record.tool : '?', arguments: args, schemaOk };
  }
  if (action === 'plan') {
    const count = Array.isArray(record.steps) ? record.steps.length : 0;
    return { action, steps: count >= 3 && count <= 5 ? '3-5' : String(count), schemaOk };
  }
  if (action === 'reply' || action === 'refuse') return { action, schemaOk };
  return { action: 'invalid', schemaOk: false };
}

function matches(actual: OrchestratorActual, outcome: Outcome): boolean {
  if (actual.action !== outcome.action) return false;
  if (outcome.tool !== undefined && actual.tool !== outcome.tool) return false;
  if (outcome.steps !== undefined && actual.steps !== outcome.steps) return false;
  for (const [field, check] of Object.entries(outcome.args ?? {})) {
    const value = actual.arguments?.[field];
    if (typeof value !== 'string') return false;
    if (check.equals !== undefined && value !== check.equals) return false;
    if (check.notEqual !== undefined && value.trim() === check.notEqual) return false;
    if (check.prefix !== undefined && !value.startsWith(check.prefix)) return false;
  }
  return true;
}

/** `compare` of the orchestrator group: schema conformity, one accepted answer, no forbidden one. */
export function matchesExpectation(actual: unknown, expect: unknown): boolean {
  const answer = actual as OrchestratorActual;
  const expectation = expect as OrchestratorExpectation;
  if (!answer.schemaOk) return false;
  if (expectation.accept !== undefined && !expectation.accept.some((outcome) => matches(answer, outcome))) return false;
  return !(expectation.forbid ?? []).some((outcome) => matches(answer, outcome));
}

export function createOrchestratorEvaluator(model: () => LocalModel, agentPrompt: string): Evaluate {
  const ask = async (input: OrchestratorInput, thought: boolean) => {
    const result = await model().chat({
      model: 'local-large',
      messages: chatMessages(agentPrompt, input.tools, input.messages, thought),
      schema: { name: RESPONSE_SCHEMA_NAME, schema: responseSchema(input.tools, thought) },
      temperature: 0,
      // Room for the thought before the answer (with 1024 the JSON could be cut
      // short), and a bound on a stuck answer: 2048 tokens of the 27B on the
      // Mac Studio are about three minutes.
      maxTokens: 2048,
      timeoutMs: 300_000,
    });
    return summarize(result.value, input.tools, thought);
  };
  return async (raw) => {
    const input = raw as OrchestratorInput;
    try {
      return await ask(input, true);
    } catch (error) {
      // An answer that is not JSON: once more without the thought (D-051).
      if (!(error instanceof LocalModelError) || error.kind !== 'bad-response') throw error;
      return ask(input, false);
    }
  };
}
