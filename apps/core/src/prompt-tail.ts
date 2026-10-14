import { flatPersonaText, personaBlock, personaParts, type PersonaParts } from '@arianna/agents';
import type { Personas } from '@arianna/config';
import { isAtMost, profileBlock, scanText, type KnownSecrets, type Label, type ProfileFact } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

/**
 * The tail of an agent's system prompt (D-107, tappa A3): labeled pieces
 * written by the user that go after the stable prefix, so that the cached
 * block of oMLX (D-075) is the same whatever they say. Each piece passes the
 * gateway on its own, with its label and source, and counts in the label of
 * the step; the model reads the texts the gateway let out, joined in order.
 *
 * The persona first, then, in the steps on this machine only, the profile
 * «Su di te» (D-114, tappa B, `profilePart`) with its own label and source.
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
export function personaPart(personas: Personas, agent: string, clearance: Label, secrets: KnownSecrets = knownSecrets): TailPart | undefined {
  const persona = Object.hasOwn(personas, agent) ? personas[agent] : undefined;
  if (persona === undefined) return undefined;
  const parts = withoutPersonal(personaParts(persona, clearance), secrets);
  const text = personaBlock(parts);
  return text === '' ? undefined : { text, label: parts.label, source: `persona:${agent}` };
}

/**
 * The parts without a free text that looks like personal data or holds a
 * value of the vault (the user's choice of 2026-10-14): the settings page
 * already refuses such a text, but `arianna.toml` can be written by hand. The
 * text is dropped, tone and address stay; the label falls back to L0 when no
 * text is left. The gateway would stop it towards the cloud anyway; this keeps
 * it out of the local prompt too, and says nothing of the text.
 */
export function withoutPersonal(parts: PersonaParts, secrets: KnownSecrets = knownSecrets): PersonaParts {
  // Both the text as written and as the block shows it (flatPersonaText): a value split over lines joins again there.
  const clean = (text: string | undefined): boolean =>
    text === undefined || [text, flatPersonaText(text)].every((form) => scanText(form).length === 0 && secrets.find(form).length === 0);
  const kept: PersonaParts = { tone: parts.tone, address: parts.address, label: 'L0' };
  if (parts.displayName !== undefined && clean(parts.displayName)) kept.displayName = parts.displayName;
  if (parts.traits !== undefined && clean(parts.traits)) kept.traits = parts.traits;
  if (parts.specialization !== undefined && clean(parts.specialization)) kept.specialization = parts.specialization;
  if (kept.displayName !== undefined || kept.traits !== undefined || kept.specialization !== undefined) kept.label = parts.label;
  return kept;
}

/** The pieces of the tail of `agent` for a step with `clearance`, in the order the model reads them. */
export function tailParts(config: { personas: Personas }, agent: string, clearance: Label): TailPart[] {
  const persona = personaPart(config.personas, agent, clearance);
  return persona === undefined ? [] : [persona];
}

/** The profile as a piece of the tail; `topicsOnly` when only the topics entered (the step may then offer profile.read). */
export interface ProfilePart extends TailPart {
  topicsOnly: boolean;
}

/** Source of the profile piece in gateway_log: no text, no topic. */
export const PROFILE_SOURCE = 'profile:user';

/**
 * The profile «Su di te» (D-114, tappa B) as one piece of the tail, for a step
 * on the local model only, with `clearance` the lower of the card's
 * `max_label` and the task's: in a private step topics and texts of every
 * fact (L2 as soon as one L2 text is in), in a work step the texts of the L1
 * facts and the topics of the L2 ones (L1), nothing for an L0 agent or task
 * (`profileBlock` of the policy). Past its limit only the topics (L1), and
 * `readTool` says that the step offers profile.read; `shareTool` that it
 * offers profile.share, and a private fact says how to ask for it (D-213).
 * Never for a brief to the cloud: a single fact leaves only with profile.share.
 */
export function profilePart(facts: readonly ProfileFact[], clearance: Label, options: { readTool?: boolean; shareTool?: boolean } = {}): ProfilePart | undefined {
  const block = profileBlock(clearance, facts, {
    ...(options.readTool === undefined ? {} : { readTool: options.readTool }),
    ...(options.shareTool === undefined ? {} : { shareTool: options.shareTool }),
  });
  return block === undefined ? undefined : { text: block.text, label: block.label, source: PROFILE_SOURCE, topicsOnly: block.topicsOnly };
}

/** The tail as the prompt receives it: the texts the gateway let out, empty ones left out; '' without any. */
export function promptTail(texts: readonly string[]): string {
  return texts.filter((text) => text !== '').join('\n\n');
}
