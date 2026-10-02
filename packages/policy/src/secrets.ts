// Known secrets (docs/PRIVACY-POLICY-SPEC.md, rule 6). The vault reveals a
// secret only to the code that uses it; if its value then shows up in a
// payload, it is a leak whatever the label says, and the gateway blocks it for
// every target, local models included. Pure: the values come from the caller.
import { normalizeForScan } from './scanner.ts';

/**
 * Shorter values are not matched: a four-digit PIN would block every text
 * with that number in it. They are still secrets, only without this net.
 */
export const MIN_SECRET_LENGTH = 8;

/** A revealed secret: its vault reference (`vault://name`) and its value. */
export interface KnownSecret {
  ref: string;
  value: string;
}

/** What the gateway asks: which known secrets appear in a text. */
export interface KnownSecrets {
  /** References of the secrets whose value is in the text, never the values. */
  find(text: string): string[];
}

/**
 * A matcher over the given secrets. Text and values are compared in the form
 * the scanner reads (compatibility form, no invisible characters), so a
 * full-width or zero-width variant of a value still matches.
 */
export function secretMatcher(secrets: Iterable<KnownSecret>): KnownSecrets {
  const entries: { ref: string; value: string }[] = [];
  for (const secret of secrets) {
    const value = normalizeForScan(secret.value);
    if (value.length >= MIN_SECRET_LENGTH) entries.push({ ref: secret.ref, value });
  }
  return {
    find(text: string): string[] {
      const normalized = normalizeForScan(text);
      return [...new Set(entries.filter((entry) => normalized.includes(entry.value)).map((entry) => entry.ref))];
    },
  };
}
