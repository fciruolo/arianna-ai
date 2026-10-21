// The second scanner of personal data (D-113, stage 2): what Rizzo-PII found
// in the texts that are about to leave towards a cloud target. Only upwards: a
// finding blocks the exit, nothing here lowers or decides a label. The model
// runs in apps/guard; the core asks it and hands the answer to the gateway as
// a `PiiCheck`, which only the functions of this file can make.
import { piiExemptions, piiScanTexts } from './catalog-texts.ts';
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

/**
 * Words of the trade the model takes for a person in a brief (D-236): «landing
 * page con hero» gave a FULLNAME «hero» at 0.97 and stopped a plan to Claude.
 * Only the words the trial showed, and only alone and whole, like the names of
 * one word: «Hero Rossi» is still a person, and so is «Rossi» next to «Hero».
 */
export const PII_WORK_WORDS: readonly string[] = ['hero', 'skeleton', 'vite', 'tailwind', 'figma', 'redis'];

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
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const LOCAL_IPV4 = new RegExp(
  `^(?:127(?:\\.${OCTET}){3}|10(?:\\.${OCTET}){3}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.${OCTET}){2}|192\\.168(?:\\.${OCTET}){2}|0\\.0\\.0\\.0)$`,
);

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
  if (/[A-Za-z0-9_@-]/.test(text.charAt(start - 1)) || /[A-Za-z_@-]/.test(text.charAt(end))) return false;
  return LOCAL_IPV4.test(text.slice(start, end).replace(/\.$/, ''));
}

/**
 * True when the entity lies inside an identifier of code: a UUID (the id of a
 * run in the path of the notes was read once as an IBAN) or a lowercase
 * hexadecimal word of 12-64 characters with digits and letters mixed (a
 * sha256, the version of a skill: `[739de001433318de]`, read once as a
 * document), or a local IPv4 address. Personal data never take that form:
 * shorter words, the shape of a document or a plate (letters, digits, letters), the shape of a codice
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
const REACH = 48;
/** Between characters of a form: up to two spaces (any, after normalization), dots, slashes, underscores or hyphens. */
const SEP = '[ ._/-]{0,2}';
/**
 * A codice fiscale: the 16 characters of a person (any month letter, so a typo
 * still counts; separators allowed between characters; also glued to a word,
 * `codicefiscaleRSSMRA85T10A562S`), its first 11 characters with real digits
 * (`RSSMRA85T10`, a codice fiscale written in part), or the 11 digits of a
 * company (also after `IT`).
 */
const CF_FORM = new RegExp(
  `(?:${['[A-Z]', '[A-Z]', '[A-Z]', '[A-Z]', '[A-Z]', '[A-Z]', OMO, OMO, '[A-Z]', OMO, OMO, '[A-Z]', OMO, OMO, OMO, '[A-Z]'].join(SEP)}|${['[A-Z]', '[A-Z]', '[A-Z]', '[A-Z]', '[A-Z]', '[A-Z]', '\\d', '\\d', '[A-Z]', '\\d', '\\d'].join(SEP)}|(?<!\\d)\\d{11}(?!\\d))`,
  'gi',
);
/**
 * An Italian plate: the cars since 1994 (AB 123 CD), the motorbikes since 1999
 * and the provincial plates before 1994 (MI 123456, MI A12345, ROMA 123456).
 */
const TARGA_FORM = new RegExp(`${START}(?:[A-Z]{2}${SEP}\\d{3}${SEP}[A-Z]{2}|[A-Z]{2}${SEP}[0-9A-Z]?\\d{4,6}|ROMA${SEP}[0-9A-Z]?\\d{4,6})${END}`, 'gi');
/** A postcode: five digits, not a piece of a decimal or of a version (`0.83.0`, `1.20121`). */
const ZIPCODE_FORM = new RegExp(`${START}(?<!\\d[.,])\\d{5}(?![.,]\\d)${END}`, 'g');
/** A house number: up to four digits, maybe a letter (14, 14b, 14/A), not a piece of a decimal or of a version. */
const BUILDINGNUM_FORM = new RegExp(`${START}(?<!\\d[.,])\\d{1,4}(?![.,]?\\d)(?:[ /]?[A-Za-z]${END})?`, 'g');
/**
 * Cadastral data are numbers alone (`foglio 12, particella 345`): they count only
 * with a word of the cadastre near them (80 characters before, 30 after, or in
 * them), never in «riga 78». The abbreviations of a visura count with a number
 * (`fg. 12`, `F. 12 P. 345`).
 */
const CATASTO_WORD = /(?<![\p{L}\p{N}])(?:foglio|fogli|particella|particelle|mappale|mappali|subalterno|subalterni|catasto|catastale|catastali|nceu|nct|censuario|censuaria|(?:fg|part|mapp|map|sub)\.?\s*\d|[fp]\.\s*\d)/iu;
const CATASTO_BEFORE = 80;
const CATASTO_AFTER = 30;
/** A postcode and a house number make an address when this close (characters between them). */
const ADDRESS_REACH = 100;

// Invisible characters that would split a form without changing what a reader sees (as the first scanner).
const INVISIBLE = /^[\u00AD\u180E\u200B-\u200D\u2060\uFEFF]$/;

/**
 * The text as a reader sees it, as the first scanner reads it: compatibility
 * form (full-width digits become digits), no invisible characters, every space
 * (a no-break one, a newline) a plain space. `at[i]` is where the character `i`
 * of the result starts in `text`, and `at[length]` is the end of `text`.
 */
function normalized(text: string): { text: string; at: number[] } {
  let out = '';
  const at: number[] = [];
  let index = 0;
  for (const char of text) {
    if (!INVISIBLE.test(char)) {
      const plain = /^\s$/u.test(char) ? ' ' : char.normalize('NFKC');
      for (let i = 0; i < plain.length; i++) at.push(index);
      out += plain;
    }
    index += char.length;
  }
  at.push(index);
  return { text: out, at };
}

/**
 * True when a match of `form` (a global regex) overlaps the entity, looked for
 * within REACH of it in the normalized text. Only that window is read, so a
 * long brief costs the same as a short one; at its edges a cut word may look
 * like a whole one, which can only make a form appear, never hide one.
 */
function formAround(text: string, entity: PiiEntity, form: RegExp): boolean {
  const from = Math.max(0, entity.start - REACH);
  const window = normalized(text.slice(from, Math.min(text.length, entity.end + REACH)));
  const start = entity.start - from;
  const end = entity.end - from;
  for (const match of window.text.matchAll(form)) {
    const matchStart = window.at[match.index] ?? 0;
    const matchEnd = window.at[match.index + match[0].length] ?? 0;
    if (matchStart < end && matchEnd > start) return true;
  }
  return false;
}

/**
 * A site the model took for an email (https://www.comune.torino.it/, D-268):
 * the span is a host name alone (labels and a top-level domain of letters,
 * no local part), and no at sign in any form is near it. Every other EMAIL
 * counts, IP addresses (marked EMAIL too) included: the scanner has no rule
 * for emails, so this is the only check of them. The forms are looked for in
 * the text around the span, normalized (NFKC, so ＠ and ﹫ are @) and in
 * their encoded and written-out forms: %40 (also encoded again, %2540, as in
 * the links of newsletters), &#64;, &commat;, «chiocciola»,
 * «(at)», « at ».
 */
const HOST_ONLY = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const AT_FORMS = /@|%(?:25)*40|&#0*64;|&#x0*40;|&commat;|chiocciola|[([{]\s*at\s*[)\]}]|[\s_.-]at[\s_.-]/i;
const SITE_REACH = 64;

function siteNotEmail(text: string, entity: PiiEntity): boolean {
  if (!HOST_ONLY.test(text.slice(entity.start, entity.end).trim())) return false;
  const around = text.slice(Math.max(0, entity.start - SITE_REACH), Math.min(text.length, entity.end + SITE_REACH)).normalize('NFKC');
  return !AT_FORMS.test(around);
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
    case 'EMAIL':
      return !siteNotEmail(text, entity);
    case 'CATASTO':
      return CATASTO_WORD.test(normalized(text.slice(Math.max(0, entity.start - CATASTO_BEFORE), Math.min(text.length, entity.end + CATASTO_AFTER))).text);
    default:
      return true;
  }
}

/**
 * A house number with a postcode close to it is an address, even when the
 * street was missed; far apart in a long text they are two numbers.
 */
function isAddress(entities: readonly PiiEntity[]): boolean {
  const parts = entities.filter((entity) => entity.kind === 'ZIPCODE' || entity.kind === 'BUILDINGNUM').sort((a, b) => a.start - b.start);
  // In order of start: the farthest end so far of each kind is enough to know whether one of the other kind is close.
  const lastEnd = { ZIPCODE: -Infinity, BUILDINGNUM: -Infinity };
  for (const part of parts) {
    const kind = part.kind as keyof typeof lastEnd;
    const other = kind === 'ZIPCODE' ? 'BUILDINGNUM' : 'ZIPCODE';
    if (part.start - lastEnd[other] <= ADDRESS_REACH) return true;
    lastEnd[kind] = Math.max(lastEnd[kind], part.end);
  }
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where the ignored names appear in the text, as whole words, whatever the case
 * and the spaces between their words: a FULLNAME inside one of these is a piece
 * of the name (`net` of «Claude Sonnet», `a` of «arianna»), never a person.
 * Only names of one word and names of a cloud assistant (the first word is
 * one of `ASSISTANT_NAMES`: «Claude Sonnet», «Codex Sol»): a name of two words
 * like a person's («Giulia Bianchi») is ignored only whole.
 */
function nameSpans(text: string, names: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  const assistants = new Set(ASSISTANT_NAMES.map(normalizeName));
  for (const name of names) {
    if (name.includes(' ') && !assistants.has(name.split(' ')[0] ?? '')) continue;
    const words = name.split(' ').map(escapeRegExp).join('\\s+');
    for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'giu'))) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  return spans;
}

/**
 * Where the names of one fragment (`fragmentNames`) appear in its text, as
 * whole words (D-227): a FULLNAME inside one of them is a piece of
 * that name (`verne` of «Laverne», `so` of «Dr. Kelso»), as the model sometimes
 * cuts a name it does not know. Names of two words too, since only the span
 * inside the occurrence passes: «Carla Bianchi» around «Carla» is still a person.
 */
function fragmentNameSpans(text: string, names: Iterable<string>): [number, number][] {
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
 * `ignoreNames` are names of the assistant, of the agents and of the cloud
 * models: a FULLNAME whose text is exactly one of them, or a piece of one of
 * them as `nameSpans` says, is not a person (`ASSISTANT_NAMES` always count;
 * `PII_WORK_WORDS` too, but only through `nameSpans`, as whole words).
 * `fragmentNames` are more names for one fragment alone, by position (D-214:
 * the name of a character of the series in its own piece of the prompt), and
 * only whole, or a piece inside one whole occurrence of it (D-227); in every
 * other fragment the same name is still a person.
 */
export function piiReport(texts: readonly string[], entities: unknown, ignoreNames: readonly string[] = [], fragmentNames: readonly (readonly string[] | undefined)[] = []): PiiCheck {
  if (!Array.isArray(texts) || !texts.every((text) => typeof text === 'string')) return piiUnavailable('malformed');
  if (!Array.isArray(entities) || entities.length !== texts.length) return piiUnavailable('malformed');
  const usable = (names: readonly string[]) => names.filter((name) => typeof name === 'string' && name.trim() !== '' && name.length <= MAX_NAME).map(normalizeName);
  const ignored = new Set(usable([...ASSISTANT_NAMES, ...ignoreNames]));
  // Only as whole words of the text: «Hero» marked inside «Heron» or «HeroRossi» is still a person.
  const work = usable(PII_WORK_WORDS);
  const findings: PiiFinding[] = [];
  for (const [fragment, text] of texts.entries()) {
    const found: unknown = entities[fragment];
    if (!Array.isArray(found) || !found.every((entity) => isEntity(entity, text.length))) return piiUnavailable('malformed');
    const own = Array.isArray(fragmentNames[fragment]) ? new Set(usable(fragmentNames[fragment] ?? [])) : undefined;
    let names: [number, number][] | undefined;
    let ownSpans: [number, number][] | undefined;
    const kept: PiiEntity[] = [];
    for (const entity of found) {
      if (entity.kind === 'FULLNAME') {
        const name = normalizeName(text.slice(entity.start, entity.end));
        if (ignored.has(name) || own?.has(name) === true) continue;
        names ??= nameSpans(text, [...ignored, ...work]);
        if (names.some(([start, end]) => start <= entity.start && entity.end <= end)) continue;
        if (own !== undefined) {
          ownSpans ??= fragmentNameSpans(text, own);
          if (ownSpans.some(([start, end]) => start <= entity.start && entity.end <= end)) continue;
        }
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
 * uses it: a test of apps/core fails if its sources name it. As the core
 * does, it reads a marked catalog text as empty (D-250): what `entities` says
 * of that fragment is never seen, as the model never sees the text.
 */
export function fakePiiCheck(payload: readonly { value: unknown }[], entities?: readonly (readonly PiiEntity[])[]): PiiCheck {
  const texts = Array.isArray(payload) ? payload.map((fragment) => payloadText((fragment as { value?: unknown } | null)?.value) ?? '') : [];
  const exempt = piiExemptions(payload);
  // A list of the wrong length stays as it is: the check is malformed, as before.
  const answer: unknown =
    entities === undefined
      ? texts.map(() => [])
      : !Array.isArray(entities) || entities.length !== texts.length
        ? entities
        : entities.map((found: readonly PiiEntity[], index) => (exempt[index] === true ? [] : found));
  return piiReport(piiScanTexts(texts, exempt), answer);
}
