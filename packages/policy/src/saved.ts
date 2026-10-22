// The private values the user saved (D-283): clients and their contacts.
// In the agent's browser and in web.fetch they take the place of the second
// scanner (Rizzo-PII) on the address of a page and on a typed text: an exact
// comparison, which neither mistakes a street or a company for a person nor
// needs seconds to start. Pure: the values come from the caller (the core
// builds them from the database, in memory only).
import { normalizeForScan } from './scanner.ts';

/** Shorter values (normalized) are not compared: «Via» or «Bar» would match everywhere. */
export const MIN_SAVED_LENGTH = 4;
/** A phone number counts with this many digits at least. */
export const MIN_SAVED_DIGITS = 6;

/**
 * One saved value: a reference that names where it is (`client:<id>:email`,
 * `contact:<id>:name`), never the value, and the value. `phone`: compared on
 * its digits only.
 */
export interface SavedValue {
  ref: string;
  value: string;
  phone?: boolean;
}

/** What the gateway asks: which saved values appear in a text. */
export interface KnownPrivate {
  /** References of the saved values found in the text, never the values. */
  find(text: string): string[];
}

/**
 * What a caller gives the gateway for the exits D-283 covers: the saved
 * values, and the references the user let go in this conversation («Apri»
 * on the card «Apri / No»).
 */
export interface SavedCheck {
  known: KnownPrivate;
  approved: ReadonlySet<string>;
}

/**
 * A text as the comparison reads it: the form of the scanner, without accents
 * and case, every character that is not a letter or a digit as a space,
 * spaces collapsed.
 */
export function savedForm(text: string): string {
  return normalizeForScan(text)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Runs of digits a phone number can be written as: digits with spaces, dots, dashes, slashes or brackets between them. */
function digitRuns(text: string): string[] {
  const runs = new Set<string>();
  for (const match of normalizeForScan(text).matchAll(/\+?\d[\d\s.\-/()]*\d/g)) {
    // Every stretch of whole groups: a number next to other digits («via Glicini 14 0471 552908», two numbers in a row).
    const groups = match[0].split(/\D+/).filter((group) => group !== '').slice(0, 40);
    for (let start = 0; start < groups.length; start += 1) {
      let digits = '';
      for (let end = start; end < groups.length; end += 1) {
        digits += groups[end] ?? '';
        if (digits.length > 20) break;
        runs.add(digits);
      }
    }
  }
  return [...runs];
}

/** The ways a number's digits may be written: with or without the Italian prefix 39 or 0039. */
function phoneForms(digits: string): string[] {
  const forms = new Set([digits]);
  for (const prefix of ['0039', '39']) {
    if (digits.startsWith(prefix) && digits.length - prefix.length >= MIN_SAVED_DIGITS) forms.add(digits.slice(prefix.length));
  }
  const base = [...forms];
  for (const form of base) {
    forms.add(`39${form}`);
    forms.add(`0039${form}`);
  }
  return [...forms];
}

/**
 * A matcher over the given values: a text value matches as whole words of
 * the text (`savedForm` of both), a phone as a whole run of digits. Values
 * shorter than MIN_SAVED_LENGTH, or a phone with fewer than MIN_SAVED_DIGITS
 * digits, are left out.
 */
export function savedMatcher(values: Iterable<SavedValue>): KnownPrivate {
  const words: { ref: string; form: string }[] = [];
  const phones = new Map<string, Set<string>>();
  for (const saved of values) {
    if (typeof saved.value !== 'string' || typeof saved.ref !== 'string') continue;
    if (saved.phone === true) {
      const digits = saved.value.replace(/\D/g, '');
      if (digits.length < MIN_SAVED_DIGITS) continue;
      for (const form of phoneForms(digits)) {
        const refs = phones.get(form) ?? new Set<string>();
        refs.add(saved.ref);
        phones.set(form, refs);
      }
      continue;
    }
    const form = savedForm(saved.value);
    if (form.length >= MIN_SAVED_LENGTH) words.push({ ref: saved.ref, form: ` ${form} ` });
  }
  return {
    find(text: string): string[] {
      const found = new Set<string>();
      const form = ` ${savedForm(text)} `;
      for (const word of words) if (form.includes(word.form)) found.add(word.ref);
      if (phones.size > 0) {
        for (const run of digitRuns(text)) for (const ref of phones.get(run) ?? []) found.add(ref);
      }
      return [...found];
    },
  };
}

/**
 * The readings of an address the comparison takes besides the text as
 * written: decoded, and with `+` as a space (a query of a form). A broken
 * escape is left as it is (the gateway refused it before).
 */
export function addressReadings(address: string): string[] {
  const readings = [address];
  try {
    const decoded = decodeURIComponent(address);
    readings.push(decoded);
    if (address.includes('+')) readings.push(decodeURIComponent(address.replace(/\+/g, ' ')));
  } catch {
    // Read as written only.
  }
  return readings;
}
