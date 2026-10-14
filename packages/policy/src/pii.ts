// The second scanner of personal data (D-113, stage 2): what Rizzo-PII found
// in the texts that are about to leave towards a cloud target. Only upwards: a
// finding blocks the exit, nothing here lowers or decides a label. The model
// runs in apps/guard; the core asks it and hands the answer to the gateway as
// a `PiiCheck`, which only the functions of this file can make.
import { payloadText, sha256Hex } from './payload.ts';

/** One personal datum found by the model: its kind and where it is, never its text. */
export interface PiiEntity {
  kind: string;
  /** Start and end in UTF-16 code units of the checked text, like `String.prototype.slice`. */
  start: number;
  end: number;
  score: number;
}

/** Why the second check gave no answer. */
export type PiiUnavailableReason = 'off' | 'starting' | 'timeout' | 'malformed' | 'error';

/** A finding of the second scanner, as the gateway reports it: no text, no position. */
export interface PiiFinding {
  kind: string;
  /** Which fragment of the payload. */
  fragment: number;
}

/**
 * Kinds that alone point at no one: a date, a city or a house number appear in
 * any work text (the port 7420 was read as a house number in the trial). Every
 * other kind blocks, also one the model may learn later: an unknown kind is not
 * a harmless one.
 */
export const PII_NON_BLOCKING: readonly string[] = ['AGE', 'AMOUNT', 'BUILDINGNUM', 'CITY', 'DATE', 'GENDER', 'ORG', 'PROVINCE', 'TIME', 'ZIPCODE'];

/** A house number with a postcode in the same text is an address, even when the street was missed. */
const ADDRESS_PAIR: readonly string[] = ['BUILDINGNUM', 'ZIPCODE'];

/** The name of the assistant: in almost every brief, never a person (the trial took it for one). */
export const ASSISTANT_NAMES: readonly string[] = ['Arianna'];

const MAX_NAME = 60;

/** Kinds the model gives to document numbers: a hash of git or a UUID in a brief of code is not one. */
const DOCUMENT_KINDS: readonly string[] = ['ID_DOC', 'DOCID'];
const WORD_CHAR = /[0-9A-Za-z_-]/;
const LOWER_HEX = /^[0-9a-f]{7,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when the entity lies inside a lowercase hexadecimal word of 7-64 digits
 * (a commit, a sha256, the version of a skill: `[739de001433318de]`) or a UUID.
 * An Italian identity card, passport or licence number has uppercase letters
 * and letters beyond f (CA12345AB, YA1234567), so it never matches.
 */
function isCodeIdentifier(text: string, entity: PiiEntity): boolean {
  let start = entity.start;
  let end = entity.end;
  while (start > 0 && WORD_CHAR.test(text.charAt(start - 1))) start--;
  while (end < text.length && WORD_CHAR.test(text.charAt(end))) end++;
  const word = text.slice(start, end);
  return (LOWER_HEX.test(word) && /[0-9]/.test(word)) || UUID.test(word);
}
const KIND = /^[A-Z][A-Z0-9_]{0,39}$/;

type CheckState =
  | { state: 'scanned'; hashes: readonly string[]; findings: readonly PiiFinding[] }
  | { state: 'unavailable'; reason: PiiUnavailableReason; development: boolean };

/** What the second check said about a payload; made only by `piiReport` and `piiUnavailable`. */
export interface PiiCheck {
  readonly brand: 'pii-check';
}

// Checks made here, and only these, reach a decision: an object literal could claim a clean scan.
const checks = new WeakMap<PiiCheck, CheckState>();

function make(state: CheckState): PiiCheck {
  const check: PiiCheck = Object.freeze({ brand: 'pii-check' });
  checks.set(check, state);
  return check;
}

function normalizeName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('it');
}

function isEntity(value: unknown, length: number): value is PiiEntity {
  if (typeof value !== 'object' || value === null) return false;
  const entity = value as Record<string, unknown>;
  return (
    typeof entity.kind === 'string' &&
    KIND.test(entity.kind) &&
    Number.isInteger(entity.start) &&
    Number.isInteger(entity.end) &&
    (entity.start as number) >= 0 &&
    (entity.start as number) < (entity.end as number) &&
    (entity.end as number) <= length &&
    typeof entity.score === 'number' &&
    Number.isFinite(entity.score)
  );
}

/**
 * The answer of the model for `texts`, the exact texts the gateway will check
 * (one per fragment, as `payloadText` writes them): `entities` holds one list
 * per text. An answer of the wrong shape, or with a position outside its text,
 * is a check that did not happen (`malformed`), never a clean one.
 *
 * `ignoreNames` are names of the assistant and of the agents: a FULLNAME whose
 * text is exactly one of them is not a person (`ASSISTANT_NAMES` always count).
 */
export function piiReport(texts: readonly string[], entities: unknown, ignoreNames: readonly string[] = []): PiiCheck {
  if (!Array.isArray(texts) || !texts.every((text) => typeof text === 'string')) return piiUnavailable('malformed');
  if (!Array.isArray(entities) || entities.length !== texts.length) return piiUnavailable('malformed');
  const ignored = new Set(
    [...ASSISTANT_NAMES, ...ignoreNames]
      .filter((name) => typeof name === 'string' && name.trim() !== '' && name.length <= MAX_NAME)
      .map(normalizeName),
  );
  const findings: PiiFinding[] = [];
  for (const [fragment, text] of texts.entries()) {
    const found: unknown = entities[fragment];
    if (!Array.isArray(found) || !found.every((entity) => isEntity(entity, text.length))) return piiUnavailable('malformed');
    const kinds = new Set<string>();
    for (const entity of found) {
      if (entity.kind === 'FULLNAME' && ignored.has(normalizeName(text.slice(entity.start, entity.end)))) continue;
      if (DOCUMENT_KINDS.includes(entity.kind) && isCodeIdentifier(text, entity)) continue;
      kinds.add(entity.kind);
    }
    for (const kind of kinds) {
      if (!PII_NON_BLOCKING.includes(kind)) findings.push({ kind, fragment });
    }
    if (ADDRESS_PAIR.every((kind) => kinds.has(kind))) findings.push({ kind: 'ADDRESS', fragment });
  }
  return make({ state: 'scanned', hashes: Object.freeze(texts.map((text) => sha256Hex(text))), findings: Object.freeze(findings) });
}

/**
 * The second check gave no answer. The exit stops (default-deny, D-113
 * question 2), except on a development installation, recognized as the doctor
 * does by the development passwords of the database: there the exit goes on
 * and its row in gateway_log says the check was skipped.
 */
export function piiUnavailable(reason: PiiUnavailableReason, development = false): PiiCheck {
  return make({ state: 'unavailable', reason, development: development });
}

export type PiiVerdict =
  | { verdict: 'clean' }
  | { verdict: 'skipped'; reason: PiiUnavailableReason }
  | { verdict: 'found'; findings: readonly PiiFinding[] }
  | { verdict: 'unavailable'; reason: PiiUnavailableReason | 'not-checked' | 'other-texts' };

/**
 * What a check says about `texts`, for the gateway. A check that is not one of
 * ours, or that was made for other texts, counts as no check at all.
 */
export function piiVerdict(check: unknown, texts: readonly string[]): PiiVerdict {
  const state = typeof check === 'object' && check !== null ? checks.get(check as PiiCheck) : undefined;
  if (state === undefined) return { verdict: 'unavailable', reason: 'not-checked' };
  if (state.state === 'unavailable') {
    return state.development ? { verdict: 'skipped', reason: state.reason } : { verdict: 'unavailable', reason: state.reason };
  }
  if (state.hashes.length !== texts.length || texts.some((text, index) => sha256Hex(text) !== state.hashes[index])) {
    return { verdict: 'unavailable', reason: 'other-texts' };
  }
  return state.findings.length === 0 ? { verdict: 'clean' } : { verdict: 'found', findings: state.findings };
}

/**
 * A fake recognizer for tests and evals: the answer it gives for `payload` is
 * `entities` (one list per fragment), by default nothing found. The core never
 * uses it: a test of apps/core fails if its sources name it.
 */
export function fakePiiCheck(payload: readonly { value: unknown }[], entities?: readonly (readonly PiiEntity[])[]): PiiCheck {
  const texts = Array.isArray(payload) ? payload.map((fragment) => payloadText((fragment as { value?: unknown } | null)?.value) ?? '') : [];
  return piiReport(texts, entities ?? texts.map(() => []));
}
