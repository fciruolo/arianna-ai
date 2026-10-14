// The user's profile (D-114): single facts, each with its label, written only
// by the user from Settings → "Su di te". Two levels: "Solo in casa" (L2, the
// default) and "Condivisibile" (L1, by the user's declaration, as a persona).
// The topic of every fact is L1 by the user's declaration: it may appear in a
// brief ("the user has not shared: city") and in the events. L3 (health,
// credentials, identity documents) never enters the profile: it stays in the
// vault or in the archive, where no model reads it.
import { PolicyError } from './errors.ts';
import { isLabel, type Label } from './labels.ts';

/** The labels a fact may have: L1 "Condivisibile", L2 "Solo in casa". */
export const FACT_LABELS = ['L1', 'L2'] as const satisfies readonly Label[];

export type FactLabel = (typeof FACT_LABELS)[number];

/** A new fact is "Solo in casa" unless the user says otherwise. */
export const DEFAULT_FACT_LABEL = 'L2' satisfies FactLabel;

/** The label of a fact's topic, by the user's declaration, whatever the fact's label. */
export const FACT_TOPIC_LABEL = 'L1' satisfies Label;

export function isFactLabel(value: unknown): value is FactLabel {
  return FACT_LABELS.some((label) => label === value);
}

/** A fact as the profile holds it. `label` arrives from the database: checked here, never trusted. */
export interface ProfileFact {
  topic: string;
  text: string;
  label: unknown;
}

/** What of a fact enters a step: the topic, and the text only when the clearance admits it. */
export interface FittingFact {
  topic: string;
  /** Null when only the topic enters (an L2 fact in a work step). */
  text: string | null;
}

/**
 * What of the profile may enter a step whose clearance is `clearance`:
 * - L2 and above (a private conversation): topics and texts of every fact;
 * - L1 (a work conversation, a brief to the cloud): the texts of the L1 facts
 *   only, and the topics of the L2 facts without their text;
 * - L0, or a clearance that is not a label: nothing (default-deny).
 * A fact whose label is not L1 or L2 (L3, missing, unknown) never enters, not
 * even its topic: the profile holds no such fact, and one that does is refused.
 */
export function profileFits(clearance: unknown, facts: readonly ProfileFact[]): FittingFact[] {
  if (!isLabel(clearance) || clearance === 'L0') return [];
  const fitting: FittingFact[] = [];
  for (const fact of facts) {
    if (!isFactLabel(fact.label)) continue;
    if (clearance === 'L1' && fact.label === 'L2') fitting.push({ topic: fact.topic, text: null });
    else fitting.push({ topic: fact.topic, text: fact.text });
  }
  return fitting;
}

/** The fields of a fact the scanner and the vault check before it is saved. */
export type FactField = 'topic' | 'text';

/**
 * The rule for saving a fact with label `label`: L3 or anything that is not
 * L1 or L2 is refused (throws). The topic is always checked by the scanner and
 * against the values of the vault (it is L1); the text only when the fact is
 * L1, because only then may it leave. An L2 text stays at home.
 */
export function factFieldsToScan(label: unknown): FactField[] {
  if (label === 'L3') throw new PolicyError('profile: L3 data (health, documents, credentials) never enters the profile');
  if (!isFactLabel(label)) throw new PolicyError(`profile: a fact is L1 or L2, not ${JSON.stringify(label)}`);
  return label === 'L1' ? ['topic', 'text'] : ['topic'];
}

/**
 * True when changing a fact from `from` to `to` lowers it (L2 → L1): a
 * declassification, prepared, shown and confirmed by the user, with its row
 * in label_changes. Raising (L1 → L2) is immediate. Throws on a label that a
 * fact cannot have.
 */
export function isFactLowering(from: unknown, to: unknown): boolean {
  if (!isFactLabel(from) || !isFactLabel(to)) throw new PolicyError('profile: a fact is L1 or L2');
  return from === 'L2' && to === 'L1';
}
