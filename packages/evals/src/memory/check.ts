import type { MemoryJudge, MemoryQuestion } from './types.ts';

/** Lower case, no accents, plain apostrophes, single spaces: how answers and expected words are compared. */
export function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `needle` is in `haystack`, compared normalized. */
export function contains(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

/** The ways an answer says "I don't know" (or "I can't say it here"). */
export const ABSTENTIONS: readonly string[] = [
  'non lo so',
  'non so',
  'non ricordo',
  'non posso',
  'non ho informazioni',
  'nessun ricordo',
  'non risulta',
];

/** An abstention as whole words: «non sono sicuro» is not «non so». */
export function abstains(answer: string): boolean {
  const words = ` ${normalize(answer).replace(/[^\p{L}\p{N}']+/gu, ' ')} `;
  return ABSTENTIONS.some((phrase) => words.includes(` ${phrase} `));
}

/**
 * The deterministic check of the expected words: all of `all`, one of `any`,
 * an abstention when `abstain`. False means "not confirmed", not "wrong":
 * the answer goes to the judge.
 */
export function matchesExpected(answer: string, expect: MemoryQuestion['expect']): boolean {
  if (expect.all !== undefined && !expect.all.every((word) => contains(answer, word))) return false;
  if (expect.any !== undefined && !expect.any.some((word) => contains(answer, word))) return false;
  if (expect.abstain === true && !abstains(answer)) return false;
  return true;
}

/** No judge yet (D-307): an answer the words do not confirm stays doubtful in the report. */
export const NO_JUDGE: MemoryJudge = {
  id: 'none',
  judge: () => Promise.resolve('doubtful'),
};
