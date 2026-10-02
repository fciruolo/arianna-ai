// Difficulty by rules (D-020): the agent card's default, corrected by keywords,
// the number of files involved and failed attempts. No model is asked.
import { DIFFICULTIES, type Difficulty } from '@arianna/agents';

export interface DifficultySignals {
  /** The card's default. */
  base: Difficulty;
  /** Text the keyword rules read. It may be private: nothing of it ends up in the result. */
  text?: string;
  /** Files the step touches, when known. */
  files?: number;
  /** Earlier attempts of this step that failed. */
  failedAttempts?: number;
}

export interface DifficultyEstimate {
  difficulty: Difficulty;
  /** Names of the rules that changed the default, for the decision log. */
  rules: string[];
}

/** Files at which a step counts as hard. */
export const HARD_FILES = 10;

const HARD_WORDS = new Set([
  'architettura',
  'architecture',
  'migrazione',
  'migrazioni',
  'migration',
  'migrations',
  'sicurezza',
  'security',
  'concorrenza',
  'concurrency',
  'crittografia',
  'cryptography',
]);

const TRIVIAL_WORDS = new Set([
  'typo',
  'typos',
  'refuso',
  'refusi',
  'rinomina',
  'rename',
  'readme',
  'commento',
  'commenti',
  'comment',
  'comments',
  'formattazione',
  'formatting',
]);

function level(difficulty: Difficulty): number {
  return DIFFICULTIES.indexOf(difficulty);
}

function atLevel(index: number): Difficulty {
  return DIFFICULTIES[Math.min(Math.max(index, 0), DIFFICULTIES.length - 1)] ?? 'critical';
}

function words(text: string): string[] {
  return text.toLowerCase().match(/\p{L}+/gu) ?? [];
}

/**
 * In order: a trivial keyword lowers `normal` to `trivial` when at most one
 * file is involved and nothing hard is mentioned; a hard keyword or at least
 * HARD_FILES files raise to at least `hard`; each failed attempt raises one level.
 */
export function estimateDifficulty(signals: DifficultySignals): DifficultyEstimate {
  const rules: string[] = [];
  let current = level(signals.base);
  if (current === -1) throw new TypeError(`not a difficulty: ${JSON.stringify(signals.base)}`);

  const found = words(signals.text ?? '');
  const hardWord = found.some((word) => HARD_WORDS.has(word));
  const trivialWord = found.some((word) => TRIVIAL_WORDS.has(word));
  const files = signals.files;
  if (files !== undefined && (!Number.isSafeInteger(files) || files < 0)) {
    throw new TypeError('files must be an integer of at least 0');
  }

  if (trivialWord && !hardWord && (files === undefined || files <= 1) && current === level('normal')) {
    current = level('trivial');
    rules.push('trivial-keyword');
  }
  if (hardWord && current < level('hard')) {
    current = level('hard');
    rules.push('hard-keyword');
  }
  if (files !== undefined && files >= HARD_FILES && current < level('hard')) {
    current = level('hard');
    rules.push('many-files');
  }
  const failed = signals.failedAttempts ?? 0;
  if (!Number.isSafeInteger(failed) || failed < 0) throw new TypeError('failedAttempts must be an integer of at least 0');
  if (failed > 0 && current < level('critical')) {
    current += failed;
    rules.push('failed-attempts');
  }
  return { difficulty: atLevel(current), rules };
}
