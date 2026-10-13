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

/** The descriptions of the roles of the catalog of agents (D-185, request of the user of 2026-10-13): the same way. */
export const ROLE_TRANSLATIONS_FILE = 'agents.it.json';
export const ROLE_TRANSLATE_PROMPT = [
  'Translate into Italian the short descriptions of roles of AI agents (what an assistant specialized in a job does) below.',
  'Keep product names, technologies, standards, file names and code as they are; plain, clear Italian; no additions, no comments.',
  'The input is a JSON array of strings. Answer with only a JSON array of the same length, the Italian text of each item in the same order.',
].join('\n');

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
  /** The Italian text of one description, when it was translated (an agent made from a role shows it). */
  lookup(description: string): string | undefined;
  /**
   * Starts translating what is missing, in the background; nothing when all
   * are there, a run is on, or the same missing ones already came back
   * unreadable in this run of the core (tried again after a restart or when
   * the missing descriptions change).
   */
  translateMissing(): TranslationsStatus;
  idle(): Promise<void>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const HIDDEN = /[\p{Cc}\p{Cf}]/u;

/** Said by the chat when Sonnet's answer for some descriptions could not be read. */
export const UNREADABLE_STOP = 'la risposta di Claude per alcune descrizioni non si legge: riprovo al prossimo riavvio di Arianna o quando cambiano le skill';

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

/** Said by the chat when Sonnet's answer for some descriptions of roles could not be read. */
export const ROLE_UNREADABLE_STOP = 'la risposta di Claude per alcune descrizioni non si legge: riprovo al prossimo riavvio di Arianna o quando cambiano i ruoli';

/** What is translated: the skills (D-185) by default, or the roles of the catalog of agents. */
const KINDS = {
  skills: { file: TRANSLATIONS_FILE, prompt: TRANSLATE_PROMPT, source: 'skills-catalog:descriptions', what: 'skill', stop: UNREADABLE_STOP, note: 'Descrizioni delle skill in italiano (D-185), per impronta della descrizione inglese.' },
  roles: { file: ROLE_TRANSLATIONS_FILE, prompt: ROLE_TRANSLATE_PROMPT, source: 'agents-catalog:descriptions', what: 'ruoli', stop: ROLE_UNREADABLE_STOP, note: 'Descrizioni dei ruoli del catalogo agenti in italiano (D-185), per impronta della descrizione inglese.' },
} as const;

export function createSkillTranslations(options: {
  dir: string;
  list: () => readonly { id: string; description: string }[];
  ask: AskCloudText;
  onEvent?: (kind: string, payload: Record<string, string | number>) => void;
  /** `roles`: the descriptions of the roles of the catalog of agents, in their own file; the events start with `agents.`. */
  kind?: keyof typeof KINDS;
}): SkillTranslations {
  const kind = KINDS[options.kind ?? 'skills'];
  const prefix = options.kind === 'roles' ? 'agents' : 'skills';
  const path = join(options.dir, kind.file);
  let running = false;
  let stopped: string | null = null;
  let work: Promise<void> = Promise.resolve();
  /** The missing set left by a run with unreadable answers: not asked again automatically while it stays the same. */
  let unreadableSet: string | null = null;

  const setKey = (todo: Map<string, string>): string => sha256([...todo.keys()].sort().join('\n'));

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
    writeFileSync(temporary, `${JSON.stringify({ note: kind.note, translations: table }, null, 2)}\n`);
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
    const left = missing(table).size;
    // Nothing left to translate: a past stop says nothing any more.
    return { translations, missing: left, running, stopped: left > 0 ? stopped : null };
  }

  async function run(): Promise<void> {
    const todo = [...missing(stored()).entries()];
    let unreadable = false;
    for (let at = 0; at < todo.length; at += BATCH) {
      const batch = todo.slice(at, at + BATCH);
      const answer = await options.ask({
        parts: [
          { text: kind.prompt, source: 'arianna:skill-translation' },
          { text: JSON.stringify(batch.map(([, text]) => text)), source: kind.source },
        ],
        purpose: `traduzione di ${String(batch.length)} descrizioni di ${kind.what}`,
        timeoutMs: 4 * 60_000,
      });
      const texts = parseTranslations(answer, batch.length);
      if (texts === undefined) {
        // The good batches stay saved; this one is not asked again in a loop.
        unreadable = true;
        options.onEvent?.(`${prefix}.translation_unreadable`, { count: batch.length });
        continue;
      }
      // Read again before writing: what another batch saved stays.
      const table = stored();
      batch.forEach(([key], index) => {
        const text = texts[index];
        if (text !== undefined) table[key] = text;
      });
      save(table);
      options.onEvent?.(`${prefix}.translated`, { count: batch.length });
    }
    unreadableSet = unreadable ? setKey(missing(stored())) : null;
    if (unreadable) stopped = kind.stop;
  }

  return {
    status,
    lookup(description) {
      const text = description.trim();
      return text === '' ? undefined : stored()[sha256(text)];
    },
    translateMissing() {
      const todo = missing(stored());
      if (!running && todo.size > 0 && setKey(todo) !== unreadableSet) {
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
