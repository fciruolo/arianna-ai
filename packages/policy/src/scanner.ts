// Deterministic scanner (docs/PRIVACY-POLICY-SPEC.md, "Scanner deterministico").
// Defense in depth, not the primary control: labels decide first, and a match
// blocks an exit even when the label says L1. False positives are preferred to
// misses, except where a checksum keeps ordinary identifiers (hashes, ids) out.

export type FindingKind = 'iban' | 'tax-code' | 'card-number' | 'private-key' | 'token';

/** What was found and where; never the matched text, which must not reach a log. */
export interface Finding {
  kind: FindingKind;
  /** Which pattern matched, e.g. `github` for a token. */
  name: string;
  /** Offset in the normalized string where it was found. */
  index: number;
}

interface Pattern {
  kind: FindingKind;
  name: string;
  regex: RegExp;
  /** Extra check on the match; without one every match counts. */
  valid?: (match: string) => boolean;
}

// IBAN: country, check digits, 11-30 characters, compact or in groups of four.
// The mod-97 checksum keeps git hashes and similar tokens from matching.
function validIban(match: string): boolean {
  const iban = match.replace(/ /g, '').toUpperCase();
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

// Card numbers: 13-19 digits with spaces, dots or hyphens, a card network prefix
// (2-6: millisecond timestamps start with 1) and a valid Luhn checksum.
function validCard(match: string): boolean {
  const digits = match.replace(/[ .-]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

// Italian tax code, also with omocodia (digits replaced by LMNPQRSTUV). The
// check letter is not verified: the structure is specific enough, and a miss
// costs more than an extra approval.
const OMO = '[0-9LMNPQRSTUV]';

// A grouped IBAN may swallow the next short word as a last group ("... 1332 per"):
// drop trailing groups until the checksum holds or too few characters are left.
function validGroupedIban(match: string): boolean {
  const groups = match.split(' ');
  for (let end = groups.length; end >= 2; end--) {
    const candidate = groups.slice(0, end).join('');
    if (candidate.length < 15) return false;
    if (validIban(candidate)) return true;
  }
  return false;
}

// Boundaries: not inside a run of letters or digits. Unlike `\b`, an underscore
// still delimits (`iban_IT60...`).
const START = '(?<![A-Za-z0-9])';
const END = '(?![A-Za-z0-9])';
const bounded = (body: string, flags: string): RegExp => new RegExp(`${START}${body}${END}`, flags);

const PATTERNS: readonly Pattern[] = [
  { kind: 'iban', name: 'iban', regex: bounded('[A-Z]{2}\\d{2}[A-Z0-9]{11,30}', 'gi'), valid: validIban },
  {
    kind: 'iban',
    name: 'iban',
    regex: bounded('[A-Z]{2}\\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?', 'gi'),
    valid: validGroupedIban,
  },
  {
    kind: 'tax-code',
    name: 'codice-fiscale',
    regex: bounded(`[A-Z]{6}${OMO}{2}[ABCDEHLMPRST]${OMO}{2}[A-Z]${OMO}{3}[A-Z]`, 'gi'),
  },
  { kind: 'card-number', name: 'card', regex: bounded('[2-6]\\d{3}(?:[ .-]?\\d){9,15}', 'g'), valid: validCard },
  { kind: 'private-key', name: 'pem', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/g },
  { kind: 'private-key', name: 'age', regex: /\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b/g },
  { kind: 'token', name: 'aws', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'token', name: 'github', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: 'token', name: 'gitlab', regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'token', name: 'api-key', regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'token', name: 'stripe', regex: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { kind: 'token', name: 'slack', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'token', name: 'google', regex: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'token', name: 'telegram', regex: /\b\d{8,10}:AA[0-9A-Za-z_-]{33}/g },
  { kind: 'token', name: 'npm', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'token', name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // A password inside a URL, e.g. postgres://user:password@host.
  { kind: 'token', name: 'url-password', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
];

// Invisible characters that would split a match without changing what a reader sees.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200D\u2060\uFEFF]/g;

/**
 * Compatibility form (full-width digits become digits, ligatures letters)
 * without invisible characters: the text is matched as a reader would see it.
 */
export function normalizeForScan(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '');
}

/** Every match in the text, in pattern order. Empty when the text is clean. */
export function scanText(text: string): Finding[] {
  const normalized = normalizeForScan(text);
  const findings: Finding[] = [];
  for (const pattern of PATTERNS) {
    for (const match of normalized.matchAll(pattern.regex)) {
      if (pattern.valid === undefined || pattern.valid(match[0])) {
        findings.push({ kind: pattern.kind, name: pattern.name, index: match.index });
      }
    }
  }
  return findings;
}
