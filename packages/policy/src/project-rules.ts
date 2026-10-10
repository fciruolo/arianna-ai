// The label of the rules of a project (I-14, D-174): free text the user
// writes in [project_rules] of arianna.toml, from Settings, the page Progetti
// or by hand, declared L1 like the text of a persona (D-107): it goes at the
// head of every delegation on the project, to Claude and to Codex alike,
// through the gateway. The declaration holds only for the user's text in
// [project_rules], never for text written by an agent, a tool or a model.
import { isAtMost, isLabel, type Label } from './labels.ts';

/** The label of the rules of a project, by the user's declaration. */
export const PROJECT_RULES_LABEL = 'L1' satisfies Label;

/**
 * True when the rules of a project may enter a delegation whose clearance is
 * `clearance`: from L1 up, never an L0 task. A clearance that is not a label
 * admits nothing (default-deny).
 */
export function projectRulesFit(clearance: unknown): boolean {
  return isLabel(clearance) && isAtMost(PROJECT_RULES_LABEL, clearance);
}
