// The `context` of a gateway or router case, built with the real policy.
import { createContext, isLabel, recordRead, type Context, type Label } from '@arianna/policy';

/**
 * `forged: true` passes a look-alike object instead of a context made by the
 * policy. `reads` are labels the session read, in order, applied with
 * `recordRead`: an allowed read raises `effective`, a denied one changes nothing.
 */
export interface ContextInput {
  clearance: Label;
  effective?: Label;
  forged?: boolean;
  reads?: Label[];
}

const KEYS = new Set(['clearance', 'effective', 'forged', 'reads']);

export interface BuiltContext {
  context: Context;
  /** Reads `recordRead` denied: above the clearance, or L3. */
  deniedReads: number;
}

/**
 * Builds the context of a case. A malformed one throws, which fails the case:
 * an unknown key (a typo like `read` would otherwise be ignored), a read that
 * is not L0..L3, or reads on a forged context (a look-alike cannot read).
 */
export function contextOf(raw: unknown): BuiltContext {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('"context" must be an object');
  const unknown = Object.keys(raw).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) throw new Error(`unknown context key(s): ${unknown.join(', ')}`);
  const input = raw as ContextInput;
  if (input.reads !== undefined) {
    if (!Array.isArray(input.reads)) throw new Error('"context.reads" must be a list');
    for (const label of input.reads as unknown[]) {
      if (!isLabel(label)) throw new Error(`"context.reads": ${JSON.stringify(label)} is not a label L0..L3`);
    }
    if (input.forged === true) throw new Error('"context.reads" cannot be used with "forged": a forged context reads nothing');
  }
  if (input.forged === true) return { context: { clearance: input.clearance, effective: input.effective ?? 'L0' }, deniedReads: 0 };
  let context = createContext(input.clearance, input.effective);
  let deniedReads = 0;
  for (const label of input.reads ?? []) {
    const read = recordRead(context, label);
    if (!read.allowed) deniedReads += 1;
    context = read.context;
  }
  return { context, deniedReads };
}
