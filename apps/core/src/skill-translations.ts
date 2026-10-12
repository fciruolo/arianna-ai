import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CloudTextError, type AskCloudText } from './cloud-text.ts';

/**
 * The descriptions of the skills in Italian (I-20, D-185, choice of the
 * user): translated by Claude Sonnet, a batch at a time, from public text,
 * and kept in data/catalogs/skills.it.json by the sha256 of the English
 * description: a description already translated never goes again, one that
 * changed is translated anew. Without a translation the window shows the
 * English one.
 */

export const TRANSLATIONS_FILE = 'skills.it.json';
const BATCH = 25;
const MAX_DESCRIPTION = 1500;
const MAX_TRANSLATION = 2000;

export const TRANSLATE_PROMPT = [
  'Translate into Italian the short descriptions of software "skills" (instructions for an AI agent) below.',
  'Keep product names, file names and code as they are; plain, clear Italian; no additions, no comments.',
  'The input is a JSON array of strings. Answer with only a JSON array of the same length, the Italian text of each item in the same order.',
].join('\n');

export interface TranslationsStatus {
  /** Italian description by skill id, for the skills translated. */
  translations: Record<string, string>;
  /** Descriptions still to translate. */
  missing: number;
  running: boolean;
  stopped: string | null;
}

export interface SkillTranslations {
  status(): TranslationsStatus;
  /** Starts translating what is missing, in the background; nothing when all are there or a run is on. */
  translateMissing(): TranslationsStatus;
  idle(): Promise<void>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const HIDDEN = /[\p{Cc}\p{Cf}]/u;

/** The answer for a batch: exactly one Italian string per item, plain text, or undefined. */
export function parseTranslations(answer: string, count: number): string[] | undefined {
  const start = answer.indexOf('[');
  const end = answer.lastIndexOf(']');
  if (start === -1 || end < start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== count) return undefined;
  const texts = parsed.map((item) => (typeof item === 'string' ? item.trim() : ''));
  return texts.every((text) => text !== '' && text.length <= MAX_TRANSLATION && !HIDDEN.test(text)) ? texts : undefined;
}

export function createSkillTranslations(options: { dir: string; list: () => readonly { id: string; description: string }[]; ask: AskCloudText; onEvent?: (kind: string, payload: Record<string, string | number>) => void }): SkillTranslations {
  const path = join(options.dir, TRANSLATIONS_FILE);
  let running = false;
  let stopped: string | null = null;
  let work: Promise<void> = Promise.resolve();

  function stored(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { translations?: unknown };
      const table = parsed.translations;
      if (typeof table !== 'object' || table === null || Array.isArray(table)) return {};
      return Object.fromEntries(Object.entries(table).filter((entry): entry is [string, string] => /^[0-9a-f]{64}$/.test(entry[0]) && typeof entry[1] === 'string'));
    } catch {
      return {};
    }
  }

  function save(table: Record<string, string>): void {
    mkdirSync(options.dir, { recursive: true });
    const temporary = `${path}.${String(Date.now())}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ note: 'Descrizioni delle skill in italiano (D-185), per impronta della descrizione inglese.', translations: table }, null, 2)}\n`);
    renameSync(temporary, path);
  }

  /** The descriptions to translate, once each, by their sha256. */
  function missing(table: Record<string, string>): Map<string, string> {
    const todo = new Map<string, string>();
    for (const skill of options.list()) {
      const text = skill.description.trim();
      if (text === '' || text.length > MAX_DESCRIPTION) continue;
      const key = sha256(text);
      if (table[key] === undefined) todo.set(key, text);
    }
    return todo;
  }

  function status(): TranslationsStatus {
    const table = stored();
    const translations: Record<string, string> = {};
    for (const skill of options.list()) {
      const found = table[sha256(skill.description.trim())];
      if (found !== undefined) translations[skill.id] = found;
    }
    return { translations, missing: missing(table).size, running, stopped };
  }

  async function run(): Promise<void> {
    const todo = [...missing(stored()).entries()];
    for (let at = 0; at < todo.length; at += BATCH) {
      const batch = todo.slice(at, at + BATCH);
      const answer = await options.ask({
        parts: [
          { text: TRANSLATE_PROMPT, source: 'arianna:skill-translation' },
          { text: JSON.stringify(batch.map(([, text]) => text)), source: 'skills-catalog:descriptions' },
        ],
        purpose: `traduzione di ${String(batch.length)} descrizioni di skill`,
        timeoutMs: 4 * 60_000,
      });
      const texts = parseTranslations(answer, batch.length);
      if (texts === undefined) continue;
      // Read again before writing: what another batch saved stays.
      const table = stored();
      batch.forEach(([key], index) => {
        const text = texts[index];
        if (text !== undefined) table[key] = text;
      });
      save(table);
      options.onEvent?.('skills.translated', { count: batch.length });
    }
  }

  return {
    status,
    translateMissing() {
      if (!running && missing(stored()).size > 0) {
        running = true;
        stopped = null;
        work = run()
          .catch((error: unknown) => {
            stopped = error instanceof CloudTextError ? error.message : 'traduzione interrotta';
          })
          .finally(() => {
            running = false;
          });
      }
      return status();
    },
    async idle() {
      await work;
    },
  };
}
