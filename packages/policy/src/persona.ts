// The label of an agent's persona (D-107): display name and free text are
// written by the user, so they are private like any unlabeled data (L2,
// default-deny). Only an explicit declaration makes them L1; nothing makes
// them L0. Tone and form of address are fixed sentences of ours, always L0,
// and are not judged here.
import { isAtMost, isLabel } from './labels.ts';

/** The labels a persona may carry: L2 by default, L1 only when declared. */
export type PersonaLabel = 'L1' | 'L2';

/** L1 only for an explicit `"L1"`; anything else, absent included, is L2. */
export function personaLabel(declared: unknown): PersonaLabel {
  return declared === 'L1' ? 'L1' : 'L2';
}

/**
 * True when the user's text of a persona (name and free text) may enter a
 * step whose clearance is `clearance`: its label must not exceed it. A
 * clearance that is not a label admits nothing (default-deny); with L0 the
 * text never enters.
 */
export function personaFits(declared: unknown, clearance: unknown): boolean {
  return isLabel(clearance) && isAtMost(personaLabel(declared), clearance);
}
