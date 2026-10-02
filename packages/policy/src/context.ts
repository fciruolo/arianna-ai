// Taint, clearance and contamination (docs/PRIVACY-POLICY-SPEC.md, rules 2, 8 and 9).
import { PolicyError } from './errors.ts';
import { isAtMost, labelOrDefault, maxLabel, type Label } from './labels.ts';

export interface Labeled<T> {
  value: T;
  label: Label;
  /** Where the value comes from, e.g. a path, `source:web` or a model call. */
  source: string;
}

/** Per conversation, task and run. */
export interface Context {
  /** Ceiling: reads above it are denied. Never L3. */
  readonly clearance: Label;
  /** Highest label actually read so far. Only goes up. */
  readonly effective: Label;
}

export type ConversationMode = 'work' | 'private';

export type ReadResult =
  | { allowed: true; context: Context }
  | { allowed: false; context: Context; reason: string };

/** Highest label any context may be cleared for: no model reads L3. */
const MAX_CLEARANCE: Label = 'L2';
/** Highest effective label with which cloud executors and web tools stay allowed. */
const CLOUD_CEILING: Label = 'L1';

/**
 * Taint: the output of a model or tool has the highest label among its inputs.
 * Inputs without a valid label count as L2. An output with no known inputs has
 * no provenance, so it is L2 as well.
 */
export function derive(inputs: readonly Labeled<unknown>[]): Label {
  if (inputs.length === 0) return 'L2';
  return maxLabel(...inputs.map((input) => labelOrDefault(input.label)));
}

/** Work conversations are bound to a repository and stop at L1; private ones reach L2. */
export function clearanceFor(mode: ConversationMode): Label {
  return mode === 'work' ? 'L1' : 'L2';
}

export function createContext(clearance: Label, effective: Label = 'L0'): Context {
  if (!isAtMost(clearance, MAX_CLEARANCE)) {
    throw new PolicyError(`no context can be cleared for ${clearance}`);
  }
  if (!isAtMost(effective, clearance)) {
    throw new PolicyError(`effective label ${effective} is above clearance ${clearance}`);
  }
  return Object.freeze({ clearance, effective });
}

/**
 * What the user writes in a conversation carries the conversation's clearance.
 * Callers must also record it as a read (`recordRead(context, labelForUserMessage(context))`):
 * otherwise a fresh private conversation would still pass `canUseCloud`.
 */
export function labelForUserMessage(context: Context): Label {
  return context.clearance;
}

/** Reads up to the clearance are allowed; L3 never is. */
export function canRead(context: Context, label: Label): boolean {
  return isAtMost(label, context.clearance) && isAtMost(label, MAX_CLEARANCE);
}

/**
 * Applies a read to the context. Allowed reads raise the effective label
 * (contamination); denied reads leave the context exactly as it was.
 * An invalid label is read as L2.
 */
export function recordRead(context: Context, label: Label): ReadResult {
  const read = labelOrDefault(label);
  if (!canRead(context, read)) {
    return {
      allowed: false,
      context,
      reason: `reading ${read} is above the clearance ${context.clearance} of this context`,
    };
  }
  return { allowed: true, context: createContext(context.clearance, maxLabel(context.effective, read)) };
}

/** A context that has read L2 stays local: cloud executors are allowed only up to L1. */
export function canUseCloud(context: Context): boolean {
  return isAtMost(context.effective, CLOUD_CEILING);
}

/** A web query from a context that has read L2 could carry it out: same ceiling as the cloud. */
export function canUseWebTools(context: Context): boolean {
  return isAtMost(context.effective, CLOUD_CEILING);
}
