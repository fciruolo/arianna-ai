// The fingerprint that recognizes a movement imported twice (D-183): sha256 of
// account, booking day, amount, normalized description and the occurrence of
// that same tuple in the file, so two identical coffees on the same day stay
// two movements while the same file imported again matches one to one.
import { createHash } from 'node:crypto';

import type { Day } from './types.ts';

/**
 * Lower case, no accents, punctuation as spaces, single spaces. Runs of ten
 * or more digits (operation and reference numbers some banks regenerate on
 * every export) become `#`; shorter numbers (card endings, dates, shop codes)
 * stay, because they often tell two movements apart.
 */
export function normalizeDescription(description: string): string {
  return description
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\d{10,}/g, '#')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .trim();
}

/** The key of the tuple whose repetitions in one file are counted. */
export function fingerprintKey(account: string, booked: Day, amount: number, description: string): string {
  return JSON.stringify([account, booked, amount, normalizeDescription(description)]);
}

/** sha256 hex of the tuple and its 1-based occurrence in the file. */
export function fingerprint(account: string, booked: Day, amount: number, description: string, occurrence: number): string {
  return createHash('sha256')
    .update(`finance-fingerprint-v1\n${fingerprintKey(account, booked, amount, description)}\n${String(occurrence)}`)
    .digest('hex');
}

/** Counts repetitions as the rows of one file go by. */
export class OccurrenceCounter {
  readonly #seen = new Map<string, number>();

  /** The fingerprint of the next row with this tuple. */
  next(account: string, booked: Day, amount: number, description: string): string {
    const key = fingerprintKey(account, booked, amount, description);
    const occurrence = (this.#seen.get(key) ?? 0) + 1;
    this.#seen.set(key, occurrence);
    return fingerprint(account, booked, amount, description, occurrence);
  }
}
