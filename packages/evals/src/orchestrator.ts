// Acceptance test of the orchestrator on the local model (task 1.4,
// docs/EVALS.md): one model call per case, with schema-constrained decoding.
// The model answers with one JSON object: call a tool, reply, plan, or refuse,
// after a free `thought` (D-051).
import { CODER_ONLY, chatMessages, parsePersona, personaBlock, personaParts, RESPONSE_SCHEMA_NAME, responseSchema, validate, type DelegateTarget, type Planner, type ToolId, type TurnMessage } from '@arianna/agents';
import { LocalModelError, type LocalModel } from '@arianna/executors';

import type { Evaluate } from './types.ts';

export interface OrchestratorInput {
  tools: ToolId[];
  /** `tool` messages are tool results or errors, shown to the model as such. */
  messages: TurnMessage[];
  /** The agents `task.delegate` may name, as the core offers them (D-119); the Coder alone when omitted. */
  delegates?: DelegateTarget[];
  /** Who writes the cards of `task.plan` (D-164): the model itself when omitted, Claude in a work conversation. */
  planner?: Planner;
  /**
   * The orchestrator's persona (D-107, tappa A3), a table as `[personas.arianna]`
   * of arianna.toml: its block goes in the tail of the prompt as in a private
   * conversation (L2). None when omitted: the prompt of today.
   */
  persona?: Record<string, unknown>;
}

/** The tail of the prompt for a case: the persona's block, or '' without one. */
export function caseTail(input: OrchestratorInput): string {
  return input.persona === undefined ? '' : personaBlock(personaParts(parsePersona(input.persona, 'persona'), 'L2'));
}

export interface OrchestratorActual {
  /** `invalid` when the answer has no known action. */
  action: 'call' | 'reply' | 'plan' | 'refuse' | 'invalid';
  tool?: string;
  arguments?: Record<string, unknown>;
  /** "3-5" when the plan has three to five steps, else the count. */
  steps?: string;
  /** The text of a reply or the reason of a refusal, kept only when the evaluator asks (the finance group checks the figures). */
  text?: string;
  schemaOk: boolean;
  /** How fast the model answered, when the evaluator times it (D-199): numbers only. */
  speed?: CaseSpeed;
}

/**
 * The timing of the call that gave the answer (D-199), from the stream and the
 * token counts of the local server: ms to the first piece of text, tokens
 * written and ms spent writing them after the first piece. A server that sends
 * no counts leaves `tokens` absent: the speed is never guessed.
 */
export interface CaseSpeed {
  firstTextMs?: number;
  tokens?: number;
  generationMs?: number;
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
export function summarize(value: unknown, tools: readonly ToolId[], thought = true, delegates: readonly DelegateTarget[] = CODER_ONLY, planner: Planner = 'self', keepText = false): OrchestratorActual {
  const schemaOk = validate(responseSchema(tools, thought, delegates, planner), value).length === 0;
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
  if (action === 'reply' || action === 'refuse') {
    const said = action === 'reply' ? record.text : record.reason;
    return keepText && typeof said === 'string' ? { action, text: said, schemaOk } : { action, schemaOk };
  }
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

/** The speed of one answer from the result of the local model (D-199). */
export function speedOf(result: { firstTextMs?: number; firstTokenMs?: number; durationMs: number; usage?: { completionTokens: number } }): CaseSpeed {
  const speed: CaseSpeed = {};
  if (result.firstTextMs !== undefined) speed.firstTextMs = result.firstTextMs;
  // The writing starts at the first token of any kind: the reasoning a server sends apart is in the count too.
  const writing = result.firstTokenMs ?? result.firstTextMs;
  if (writing !== undefined) speed.generationMs = Math.max(0, result.durationMs - writing);
  if (result.usage !== undefined) speed.tokens = result.usage.completionTokens;
  return speed;
}

/** `timed`: the request is streamed with the token counts, and the answer carries its `speed` (D-199). */
export function createOrchestratorEvaluator(model: () => LocalModel, agentPrompt: string, keepText = false, timed = false): Evaluate {
  const ask = async (input: OrchestratorInput, thought: boolean, signal: AbortSignal | undefined) => {
    const delegates = input.delegates ?? CODER_ONLY;
    const planner = input.planner ?? 'self';
    const result = await model().chat({
      ...(signal === undefined ? {} : { signal }),
      model: 'local-large',
      messages: chatMessages(agentPrompt, input.tools, input.messages, thought, caseTail(input), delegates, planner),
      schema: { name: RESPONSE_SCHEMA_NAME, schema: responseSchema(input.tools, thought, delegates, planner) },
      temperature: 0,
      // Room for the thought before the answer (with 1024 the JSON could be cut
      // short), and a bound on a stuck answer: 2048 tokens of the 27B on the
      // Mac Studio are about three minutes.
      maxTokens: 2048,
      timeoutMs: 300_000,
      ...(timed ? { onText: () => undefined, streamUsage: true } : {}),
    });
    const actual = summarize(result.value, input.tools, thought, delegates, planner, keepText);
    return timed ? { ...actual, speed: speedOf(result) } : actual;
  };
  return async (raw, signal) => {
    const input = raw as OrchestratorInput;
    try {
      return await ask(input, true, signal);
    } catch (error) {
      // An answer that is not JSON: once more without the thought (D-051).
      if (!(error instanceof LocalModelError) || error.kind !== 'bad-response' || signal?.aborted === true) throw error;
      return ask(input, false, signal);
    }
  };
}
