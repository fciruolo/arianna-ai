// The label of an agent's persona (D-107): display name, free text and
// specialization are written by the user, and the user declared them L1 for
// every agent on 2026-10-05 ("di queste cose tutto può andare nel cloud";
// PRIVACY-POLICY-SPEC, "Da dove vengono le etichette"). The declaration holds
// only for what the user writes in [personas], from Settings or in the file:
// never for text written by an agent, a tool or a model. Tone and form of
// address are fixed sentences of ours, always L0, and are not judged here.
import { isAtMost, isLabel, type Label } from './labels.ts';

/** The label of the user's text of a persona, by the user's declaration. */
export const PERSONA_LABEL = 'L1' satisfies Label;

/**
 * True when the user's text of a persona may enter a step whose clearance is
 * `clearance`: L1 enters work and cloud steps (L1) and private ones (L2), never
 * an L0 agent or task. A clearance that is not a label admits nothing
 * (default-deny).
 */
export function personaFits(clearance: unknown): boolean {
  return isLabel(clearance) && isAtMost(PERSONA_LABEL, clearance);
}
