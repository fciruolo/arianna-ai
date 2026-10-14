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

/**
 * Names of assistants, in almost every brief and fixed prompt, never a person:
 * Arianna, and the cloud ones she talks to («You are Claude…» was taken for a
 * person in the trial of the plain chat). A longer name, «Arianna Bianchi»,
 * still counts.
 */
export const ASSISTANT_NAMES: readonly string[] = ['Arianna', 'Claude', 'Codex', 'ChatGPT'];

const MAX_NAME = 60;

const WORD_CHAR = /[0-9A-Za-z_-]/;
const LOWER_HEX = /^[0-9a-f]{12,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Letters, digits, letters: an identity card, a licence, a passport or a plate written in lowercase (ca12345ab, ab123cd). */
const DOCUMENT_SHAPE = /^[a-f]{0,3}[0-9]+[a-f]{0,3}$/;
/** The shape of a codice fiscale, in lowercase: some are made only of the letters a-f. */
const CF_SHAPE = /^[a-z]{6}[0-9]{2}[a-z][0-9]{2}[a-z][0-9]{3}[a-z]$/;

const DOTTED_CHAR = /[0-9.]/;
/** An IPv4 address of this machine or of a private network: 127.x, 10.x, 172.16-31.x, 192.168.x, 0.0.0.0. */
const LOCAL_IPV4 = /^(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|0\.0\.0\.0)$/;

/**
 * True when the entity lies inside a local IPv4 address (D-215): the address
 * of the core in the links of the diary (`http://127.0.0.1:7420/c/…`) was read
 * once as pieces of an email. It points at no one; a public address is not skipped.
 */
function isLocalAddress(text: string, entity: PiiEntity): boolean {
  let start = entity.start;
  let end = entity.end;
  while (start > 0 && DOTTED_CHAR.test(text.charAt(start - 1))) start--;
  while (end < text.length && DOTTED_CHAR.test(text.charAt(end))) end++;
  // Inside the address only, and the address alone: not a part of a longer word.
  if (!/^[0-9.]+$/.test(text.slice(entity.start, entity.end))) return false;
  if (WORD_CHAR.test(text.charAt(start - 1)) || /[A-Za-z_@-]/.test(text.charAt(end))) return false;
  return LOCAL_IPV4.test(text.slice(start, end).replace(/\.$/, ''));
}

/**
 * True when the entity lies inside an identifier of code: a UUID (the id of a
 * run in the path of the notes was read once as an IBAN) or a lowercase
 * hexadecimal word of 12-64 characters with digits and letters mixed (a
 * sha256, the version of a skill: `[739de001433318de]`, read once as a
 * document), or a local IPv4 address. Personal data never take that form: shorter words, the shape of
 * a document or a plate (letters, digits, letters), the shape of a codice
 * fiscale, and a word next to `@` (the start of an email) always count.
 */
function isCodeIdentifier(text: string, entity: PiiEntity): boolean {
  let start = entity.start;
  let end = entity.end;
  while (start > 0 && WORD_CHAR.test(text.charAt(start - 1))) start--;
  while (end < text.length && WORD_CHAR.test(text.charAt(end))) end++;
  if (text.charAt(start - 1) === '@' || text.charAt(end) === '@') return false;
  const word = text.slice(start, end);
  if (UUID.test(word)) return true;
  if (isLocalAddress(text, entity)) return true;
  return LOWER_HEX.test(word) && /[0-9]/.test(word) && /[a-f]/.test(word) && !DOCUMENT_SHAPE.test(word) && !CF_SHAPE.test(word);
}
const KIND = /^[A-Z][A-Z0-9_]{0,39}$/;

// The shape a finding of some kinds must have around it (D-215). The model reads
// pieces of dates, versions and numbers of a work text as a codice fiscale, a
// plate or a postcode (`-1` of `2026-10-10`, `2` of a list, `0.83` of a version):
// those kinds count only where the text has their form, at the place of the
// finding. A real value always has it; a value the model only half covered is
// still found, since the form is looked for around the finding, not inside it.
const START = '(?<![A-Za-z0-9])';
const END = '(?![A-Za-z0-9])';
/** A digit of a codice fiscale, or the letter that replaces it (omocodia). */
const OMO = '[0-9LMNPQRSTUV]';
/** How far around a finding its form is looked for: more than the longest form, separators included. */
const REACH = 32;
const SEP = '[ .-]?';
/**
 * A codice fiscale: the 16 characters of a person (any month letter, so a typo
 * still counts; one space, dot or hyphen allowed between characters), or the 11
 * digits of a company.
 */
const CF_FORM = new RegExp(
  `${START}(?:${['[A-Z]', '[A-Z]', '[A-Z]', '[A-Z]', '[A-Z]', '[A-Z]', OMO, OMO, '[A-Z]', OMO, OMO, '[A-Z]', OMO, OMO, OMO, '[A-Z]'].join(SEP)}|\\d{11})${END}`,
  'gi',
);
/**
 * An Italian plate: the cars since 1994 (AB 123 CD), the motorbikes since 1999
 * and the provincial plates before 1994 (MI 123456, MI A12345, ROMA 123456).
 */
const TARGA_FORM = new RegExp(`${START}(?:[A-Z]{2}[ -]?\\d{3}[ -]?[A-Z]{2}|[A-Z]{2}[ -]?[0-9A-Z]?\\d{4,6}|ROMA[ -]?[0-9A-Z]?\\d{4,6})${END}`, 'gi');
/** A postcode: five digits, not a piece of a decimal or of a version (`0.83.0`, `1.20121`). */
const ZIPCODE_FORM = new RegExp(`${START}(?<!\\d[.,])\\d{5}(?![.,]\\d)${END}`, 'g');
/** A house number: up to four digits, maybe a letter (14, 14b, 14/A), not a piece of a decimal or of a version. */
const BUILDINGNUM_FORM = new RegExp(`${START}(?<!\\d[.,])\\d{1,4}(?![.,]?\\d)(?:[ /]?[A-Za-z]${END})?`, 'g');
/**
 * Cadastral data are numbers alone (`foglio 12, particella 345`): they count only
 * with a word of the cadastre before them or in them, never in «riga 78».
 */
const CATASTO_WORD = /(?<![\p{L}\p{N}])(?:foglio|fogli|particella|particelle|mappale|mappali|subalterno|subalterni|catasto|catastale|catastali|nceu|nct|censuario|censuaria|(?:fg|part|mapp|map|sub)\.?\s*\d)/iu;
const CATASTO_REACH = 80;
/** A postcode and a house number make an address when this close (characters between them). */
const ADDRESS_REACH = 100;

/**
 * True when a match of `form` (a global regex) overlaps the entity, looked for
 * within REACH of it. Only that window is read, so a long brief costs the same
 * as a short one; at its edges a cut word may look like a whole one, which can
 * only make a form appear, never hide one.
 */
function formAround(text: string, entity: PiiEntity, form: RegExp): boolean {
  const from = Math.max(0, entity.start - REACH);
  const window = text.slice(from, Math.min(text.length, entity.end + REACH));
  const start = entity.start - from;
  const end = entity.end - from;
  for (const match of window.matchAll(form)) {
    if (match.index < end && match.index + match[0].length > start) return true;
  }
  return false;
}

/**
 * False when the entity is of a kind with a form (D-215) and the text has not
 * that form where it was found. Every other kind keeps what the model said.
 */
function hasForm(text: string, entity: PiiEntity): boolean {
  switch (entity.kind) {
    case 'CF':
      return formAround(text, entity, CF_FORM);
    case 'TARGA':
      return formAround(text, entity, TARGA_FORM);
    case 'ZIPCODE':
      return formAround(text, entity, ZIPCODE_FORM);
    case 'BUILDINGNUM':
      return formAround(text, entity, BUILDINGNUM_FORM);
    case 'CATASTO':
      return CATASTO_WORD.test(text.slice(Math.max(0, entity.start - CATASTO_REACH), entity.end));
    default:
      return true;
  }
}

/**
 * A house number with a postcode close to it is an address, even when the
 * street was missed; far apart in a long text they are two numbers.
 */
function isAddress(entities: readonly PiiEntity[]): boolean {
  const zips = entities.filter((entity) => entity.kind === 'ZIPCODE');
  const numbers = entities.filter((entity) => entity.kind === 'BUILDINGNUM');
  return zips.some((zip) => numbers.some((number) => Math.max(zip.start, number.start) - Math.min(zip.end, number.end) <= ADDRESS_REACH));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where the ignored names appear in the text, as whole words, whatever the case
 * and the spaces between their words: a FULLNAME inside one of these is a piece
 * of the name (`net` of «Claude Sonnet», `a` of «arianna»), never a person.
 */
function nameSpans(text: string, names: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const name of names) {
    const words = name.split(' ').map(escapeRegExp).join('\\s+');
    for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'giu'))) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  return spans;
}

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
    let names: [number, number][] | undefined;
    const kept: PiiEntity[] = [];
    for (const entity of found) {
      if (entity.kind === 'FULLNAME') {
        if (ignored.has(normalizeName(text.slice(entity.start, entity.end)))) continue;
        names ??= nameSpans(text, [...ignored]);
        if (names.some(([start, end]) => start <= entity.start && entity.end <= end)) continue;
      }
      if (isCodeIdentifier(text, entity)) continue;
      if (!hasForm(text, entity)) continue;
      kept.push(entity);
    }
    const kinds = new Set(kept.map((entity) => entity.kind));
    for (const kind of kinds) {
      if (!PII_NON_BLOCKING.includes(kind)) findings.push({ kind, fragment });
    }
    if (isAddress(kept)) findings.push({ kind: 'ADDRESS', fragment });
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
