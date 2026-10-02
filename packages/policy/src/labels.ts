// Privacy labels, ordered from least to most restricted (docs/PRIVACY-POLICY-SPEC.md).
export const LABELS = ['L0', 'L1', 'L2', 'L3'] as const;

export type Label = (typeof LABELS)[number];

/** Where inference happens. A property of the endpoint, not of the binary. */
export type Locality = 'local' | 'cloud';

export function isLabel(value: unknown): value is Label {
  return LABELS.some((label) => label === value);
}

// Labels also arrive from files and JSON, where the type system does not help:
// anything that is not a label must stop the decision, never rank as harmless.
function rank(label: Label): number {
  const index = LABELS.indexOf(label);
  if (index === -1) throw new TypeError(`not a privacy label: ${JSON.stringify(label)}`);
  return index;
}

/** Default-deny: data without a valid label is private (L2). */
export function labelOrDefault(label: unknown): Label {
  return isLabel(label) ? label : 'L2';
}

/** The most restricted of the given labels; L0 when there is nothing to label. */
export function maxLabel(...labels: Label[]): Label {
  return labels.reduce<Label>((max, label) => (rank(label) > rank(max) ? label : max), 'L0');
}

/** True when `label` is no more restricted than `ceiling`. */
export function isAtMost(label: Label, ceiling: Label): boolean {
  return rank(label) <= rank(ceiling);
}

/** Cloud executors read up to L1, local models up to L2. No model ever reads L3. */
export function canSendTo(locality: Locality, label: Label): boolean {
  return isAtMost(label, locality === 'local' ? 'L2' : 'L1');
}
