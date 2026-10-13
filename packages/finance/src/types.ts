// The shapes shared by the import (F1) and the analysis (F2-F3) of the expense
// tracker (D-183). Pure data: no I/O, no database. Amounts are integer cents,
// never floats; dates are calendar days `YYYY-MM-DD`, without a time zone.

/** A calendar day, `YYYY-MM-DD`. */
export type Day = string;

/** One row of a bank statement, normalized by the import. */
export interface Transaction {
  /** The account the statement belongs to (an id of `finance_accounts`). */
  account: string;
  /** The day the bank booked the movement (data contabile). */
  booked: Day;
  /** The day it counts for the bank's interest (data valuta), when the file has it. */
  value: Day | null;
  /** The description as the bank wrote it, trimmed, single spaces. */
  description: string;
  /** Integer cents: negative for money out, positive for money in. */
  amount: number;
  /** ISO 4217, `EUR` unless the file says otherwise. */
  currency: string;
  /** The balance after the movement in cents, when the file has it. */
  balance: number | null;
  /** The fingerprint that recognizes the same movement imported twice. */
  fingerprint: string;
}

/** A category of expenses or income, chosen by the user. */
export interface Category {
  id: string;
  name: string;
  /** `out` for expenses, `in` for income. */
  kind: 'out' | 'in';
}

/** A rule of the user: a description that matches goes to the category. */
export interface CategoryRule {
  id: string;
  /** Words the normalized description must contain, without case or accents. */
  match: string;
  category: string;
}

/** A transaction with the category it has (by a rule, by the user, or none yet). */
export interface CategorizedTransaction extends Transaction {
  category: string | null;
  /** How it got its category: a rule, the user, or still none. */
  by: 'rule' | 'user' | null;
}

/** A spending limit for a category in a month. */
export interface Budget {
  category: string;
  /** Integer cents, positive. */
  monthly: number;
}
