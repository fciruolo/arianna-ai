// Privacy labels, ordered from least to most restricted (docs/PRIVACY-POLICY-SPEC.md).
export const LABELS = ['L0', 'L1', 'L2', 'L3'] as const;

export type Label = (typeof LABELS)[number];

/** Where inference happens. A property of the endpoint, not of the binary. */
export type Locality = 'local' | 'cloud';

function rank(label: Label): number {
  return LABELS.indexOf(label);
}

/** Default-deny: data without a label is private (L2). */
export function labelOrDefault(label: Label | undefined): Label {
  return label ?? 'L2';
}

/** The most restricted of the given labels; L0 when there is nothing to label. */
export function maxLabel(...labels: Label[]): Label {
  return labels.reduce<Label>((max, label) => (rank(label) > rank(max) ? label : max), 'L0');
}

/** Cloud executors read up to L1, local models up to L2. No model ever reads L3. */
export function canSendTo(locality: Locality, label: Label): boolean {
  return rank(label) <= rank(locality === 'local' ? 'L2' : 'L1');
}
