import { personaBlock, personaParts } from '@arianna/agents';
import type { Personas } from '@arianna/config';
import { isAtMost, type Label } from '@arianna/policy';

/**
 * The tail of an agent's system prompt (D-107, tappa A3): labeled pieces
 * written by the user that go after the stable prefix, so that the cached
 * block of oMLX (D-075) is the same whatever they say. Each piece passes the
 * gateway on its own, with its label and source, and counts in the label of
 * the step; the model reads the texts the gateway let out, joined in order.
 *
 * Today the persona alone. The profile «Su di te» (D-114, tappa B) joins
 * here as a second piece, after the persona, with its own label and source.
 */
export interface TailPart {
  text: string;
  label: Label;
  source: string;
}

/** The lower of two labels. */
export function minLabel(a: Label, b: Label): Label {
  return isAtMost(a, b) ? a : b;
}

/**
 * The persona of `agent` as one piece for a step with `clearance` (the lower
 * of the agent's ceiling and the task's): the fixed sentences of tone and
 * address (L0) always, the user's text (L1 by declaration) only when the
 * clearance admits L1, never for an L0 agent or task (`personaParts`). None
 * when nothing is left: the prompt is then the same byte for byte as without
 * a persona. Own keys only: an agent named `constructor` has no persona.
 */
export function personaPart(personas: Personas, agent: string, clearance: Label): TailPart | undefined {
  const persona = Object.hasOwn(personas, agent) ? personas[agent] : undefined;
  if (persona === undefined) return undefined;
  const parts = personaParts(persona, clearance);
  const text = personaBlock(parts);
  return text === '' ? undefined : { text, label: parts.label, source: `persona:${agent}` };
}

/** The pieces of the tail of `agent` for a step with `clearance`, in the order the model reads them. */
export function tailParts(config: { personas: Personas }, agent: string, clearance: Label): TailPart[] {
  const persona = personaPart(config.personas, agent, clearance);
  return persona === undefined ? [] : [persona];
}

/** The tail as the prompt receives it: the texts the gateway let out, empty ones left out; '' without any. */
export function promptTail(texts: readonly string[]): string {
  return texts.filter((text) => text !== '').join('\n\n');
}
