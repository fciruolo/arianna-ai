// The `context` of a gateway or router case, built with the real policy.
import { createContext, isLabel, recordRead, type Context, type Label } from '@arianna/policy';

/**
 * `forged: true` passes a look-alike object instead of a context made by the
 * policy. `reads` are labels the session read, in order, applied with
 * `recordRead`: an allowed read raises `effective`, a denied one changes nothing.
 * A read may be `{ label, source }`: a `finance:*` source marks the context (D-183).
 */
export interface ContextInput {
  clearance: Label;
  effective?: Label;
  forged?: boolean;
  reads?: (Label | ReadInput)[];
  /** The site of the access of the Private chat of the browser (D-281): a context the core declares, cleared for L2. */
  browserSite?: string;
}

/** A read with the source of the value read. */
export interface ReadInput {
  label: Label;
  source: string;
}

function readOf(raw: unknown): ReadInput | undefined {
  if (isLabel(raw)) return { label: raw, source: 'eval' };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const read = raw as Record<string, unknown>;
  if (Object.keys(read).some((key) => key !== 'label' && key !== 'source')) return undefined;
  return isLabel(read.label) && typeof read.source === 'string' ? { label: read.label, source: read.source } : undefined;
}

const KEYS = new Set(['clearance', 'effective', 'forged', 'reads', 'browserSite']);

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
    for (const read of input.reads as unknown[]) {
      if (readOf(read) === undefined) throw new Error(`"context.reads": ${JSON.stringify(read)} is not a label L0..L3 nor { label, source }`);
    }
    if (input.forged === true) throw new Error('"context.reads" cannot be used with "forged": a forged context reads nothing');
  }
  if (input.forged === true) return { context: { clearance: input.clearance, effective: input.effective ?? 'L0' }, deniedReads: 0 };
  let context = createContext(input.clearance, input.effective, input.browserSite === undefined ? {} : { browserSite: input.browserSite });
  let deniedReads = 0;
  for (const raw of input.reads ?? []) {
    const { label, source } = readOf(raw) as ReadInput;
    const read = recordRead(context, label, source);
    if (!read.allowed) deniedReads += 1;
    context = read.context;
  }
  return { context, deniedReads };
}
