// Privacy labels, ordered from least to most restricted (docs/PRIVACY-POLICY-SPEC.md).
export const LABELS = ['L0', 'L1', 'L2', 'L3'] as const;

export type Label = (typeof LABELS)[number];
