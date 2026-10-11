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
  /**
   * Present, and true, once the context has read finance data (D-183). It is
   * never removed: every context derived from a marked one is marked too, and
   * the gateway sends nothing of a marked context to a cloud target.
   */
  readonly finance?: true;
}

/** Options of `createContext`. */
export interface ContextOptions {
  /** A context that has read finance data: needs clearance and effective L2. */
  finance?: boolean;
}

export type ConversationMode = 'work' | 'private';

export type ReadResult =
  | { allowed: true; context: Context }
  | { allowed: false; context: Context; reason: string };

/** Highest label any context may be cleared for: no model reads L3. */
const MAX_CLEARANCE: Label = 'L2';
/** Highest effective label with which cloud executors and web tools stay allowed. */
const CLOUD_CEILING: Label = 'L1';

/** Sources of finance data start with this prefix, e.g. `finance:transactions` (D-183). */
export const FINANCE_SOURCE_PREFIX = 'finance:';
/** The source of what a model or tool wrote after reading finance data. */
export const FINANCE_DERIVED_SOURCE = 'finance:derived';
/** Finance data is at least Private: no rule lowers it below this label. */
export const FINANCE_LABEL: Label = 'L2';

/** True when `source` names finance data (`finance:*`). Anything that is not a string is not. */
export function isFinanceSource(source: unknown): boolean {
  return typeof source === 'string' && source.startsWith(FINANCE_SOURCE_PREFIX);
}

/**
 * The label a value really has: its label (L2 when invalid), raised to L2 when
 * its source is finance data, whatever label it was given.
 */
export function labelOf(item: Labeled<unknown>): Label {
  const label = labelOrDefault(item.label);
  return isFinanceSource(item.source) ? maxLabel(label, FINANCE_LABEL) : label;
}

/**
 * Taint: the output of a model or tool has the highest label among its inputs.
 * Inputs without a valid label count as L2, finance inputs at least L2. An
 * output with no known inputs has no provenance, so it is L2 as well.
 */
export function derive(inputs: readonly Labeled<unknown>[]): Label {
  if (inputs.length === 0) return 'L2';
  return maxLabel(...inputs.map(labelOf));
}

/**
 * The source of an output: `finance:derived` when any input is finance data,
 * `source` otherwise. The core labels every model or tool output with
 * `{ label: derive(inputs), source: deriveSource(inputs, source) }`, so the
 * finance mark follows the text wherever it goes next (gateway, declassify).
 */
export function deriveSource(inputs: readonly Labeled<unknown>[], source: string): string {
  return inputs.some((input) => isFinanceSource(input.source)) ? FINANCE_DERIVED_SOURCE : source;
}

/** Work conversations are bound to a repository and stop at L1; private ones reach L2. */
export function clearanceFor(mode: ConversationMode): Label {
  return mode === 'work' ? 'L1' : 'L2';
}

// Contexts made here, and only these, are accepted by the gateway: an object
// literal or a context parsed from JSON could claim any effective label.
const issued = new WeakSet<Context>();

/**
 * A context cleared for `clearance` that has read up to `effective`. With
 * `{ finance: true }` it is marked as having read finance data (D-183): that
 * needs both labels at L2, since finance data is L2. The core recreates a
 * stored context with the mark it had: dropping it is a bug, as is lowering
 * `effective`.
 */
export function createContext(clearance: Label, effective: Label = 'L0', options: ContextOptions = {}): Context {
  if (!isAtMost(clearance, MAX_CLEARANCE)) {
    throw new PolicyError(`no context can be cleared for ${clearance}`);
  }
  if (!isAtMost(effective, clearance)) {
    throw new PolicyError(`effective label ${effective} is above clearance ${clearance}`);
  }
  if (options.finance === true && effective !== FINANCE_LABEL) {
    throw new PolicyError(`a context that has read finance data has effective ${FINANCE_LABEL}, not ${effective}`);
  }
  const context: Context = Object.freeze(options.finance === true ? { clearance, effective, finance: true as const } : { clearance, effective });
  issued.add(context);
  return context;
}

/** True when the context was made by the policy and has read finance data: nothing of it goes to the cloud. */
export function isFinanceContext(context: Context): boolean {
  return isContext(context) && context.finance === true;
}

/**
 * True only for contexts returned by `createContext` or `recordRead`. It stops
 * forged or deserialized objects, not a caller that builds a fresh context:
 * where a context comes from (conversation, task, run) is the core's job.
 */
export function isContext(value: unknown): value is Context {
  return typeof value === 'object' && value !== null && issued.has(value as Context);
}

/**
 * What the user writes in a conversation carries the conversation's clearance.
 * Use `recordUserMessage` to apply it: a message that is labeled but not
 * recorded as a read would let a fresh private conversation pass `canUseCloud`.
 */
export function labelForUserMessage(context: Context): Label {
  return context.clearance;
}

/** The context after the user wrote a message: it has read its own clearance. */
export function recordUserMessage(context: Context): Context {
  return recordRead(context, labelForUserMessage(context)).context;
}

/** Reads up to the clearance are allowed; L3 never is. */
export function canRead(context: Context, label: Label): boolean {
  return isAtMost(label, context.clearance) && isAtMost(label, MAX_CLEARANCE);
}

/**
 * Applies a read to the context. Allowed reads raise the effective label
 * (contamination); denied reads leave the context exactly as it was.
 * An invalid label is read as L2.
 *
 * `source` is where the value read comes from: a `finance:*` source is read as
 * at least L2 (so a work context, cleared for L1, cannot read it) and marks
 * the context for good (D-183). The core passes the source of every read of
 * finance data; without it the read counts as an ordinary one.
 */
export function recordRead(context: Context, label: Label, source?: string): ReadResult {
  const finance = isFinanceSource(source);
  const read = finance ? maxLabel(labelOrDefault(label), FINANCE_LABEL) : labelOrDefault(label);
  if (!canRead(context, read)) {
    return {
      allowed: false,
      context,
      reason: `reading ${read} is above the clearance ${context.clearance} of this context`,
    };
  }
  const marked = finance || context.finance === true;
  return { allowed: true, context: createContext(context.clearance, maxLabel(context.effective, read), { finance: marked }) };
}

/** `recordRead` of finance data: the value read is L2 at least and the context is marked. */
export function recordFinanceRead(context: Context, label: Label = FINANCE_LABEL): ReadResult {
  return recordRead(context, label, FINANCE_DERIVED_SOURCE);
}

/** A context that has read L2, or finance data, stays local: cloud executors are allowed only up to L1. */
export function canUseCloud(context: Context): boolean {
  return context.finance !== true && isAtMost(context.effective, CLOUD_CEILING);
}

/** A web query from a context that has read L2, or finance data, could carry it out: same rule as the cloud. */
export function canUseWebTools(context: Context): boolean {
  return context.finance !== true && isAtMost(context.effective, CLOUD_CEILING);
}
