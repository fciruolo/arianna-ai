// Categories from the user's rules (D-183, F2): computed by code, never by a
// model. A rule matches when its words appear, as whole words and in order,
// in the normalized description or in the merchant key; the most specific (longest) rule wins, and
// on a tie the first in the list. A category set by the user is never touched.

import type { CategorizedTransaction, CategoryRule, Transaction } from '../types.ts';
import { merchantKey, normalizeDescription } from './normalize.ts';

/** A rule to propose to the user; the caller gives it an id when it is saved. */
export interface RuleProposal {
  match: string;
  category: string;
}

/** The rule that applies to a description, or null when none does. */
export function matchRule(description: string, rules: readonly CategoryRule[]): CategoryRule | null {
  // The merchant key too, so that a rule proposed from it matches even when
  // boilerplate words sat between the merchant's words.
  const haystacks = [' ' + normalizeDescription(description) + ' ', ' ' + merchantKey(description) + ' '];
  let best: CategoryRule | null = null;
  let bestLength = 0;
  for (const rule of rules) {
    const needle = normalizeDescription(rule.match);
    if (needle === '') continue;
    if (needle.length > bestLength && haystacks.some((haystack) => haystack.includes(' ' + needle + ' '))) {
      best = rule;
      bestLength = needle.length;
    }
  }
  return best;
}

/**
 * Applies the rules to the transactions, returning new objects in the same
 * order. Rows with `by: 'user'` stay as they are. Every other row is
 * recomputed: a matching rule gives `by: 'rule'`, no match gives no category
 * (so a rule the user deleted stops applying).
 */
export function categorize(
  transactions: readonly (Transaction | CategorizedTransaction)[],
  rules: readonly CategoryRule[],
): CategorizedTransaction[] {
  return transactions.map((transaction) => {
    if ('by' in transaction && transaction.by === 'user') return { ...transaction };
    const rule = matchRule(transaction.description, rules);
    return rule === null
      ? { ...transaction, category: null, by: null }
      : { ...transaction, category: rule.category, by: 'rule' as const };
  });
}

/**
 * A rule proposed from a confirmation of the user ("this row is Groceries"):
 * the merchant key of the row, so the next rows of the same shop follow.
 * Null when the description has no usable words.
 */
export function ruleFromConfirmation(transaction: Transaction, category: string): RuleProposal | null {
  const match = merchantKey(transaction.description);
  if (match === '') return null;
  return { match, category };
}
