import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { otherSeriesNames, SERIES_PERSONAS, seriesLinesSource, seriesNamesOf, seriesSource } from '@arianna/agents';
import { scanText, type KnownSecrets } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { CloudTextError, type AskCloudText } from './cloud-text.ts';
import { cutAtSentence, parseWikiquote, WIKIQUOTE_HOST, WIKIQUOTE_LIMITED_WAIT_MS, WIKIQUOTE_PAGES, WIKIQUOTE_PAUSE_MS, WIKIQUOTE_SPEAKERS, WikiquoteError, wikiquoteName, type WikiquoteGet } from './wikiquote.ts';

/**
 * The archive of real lines of each person of the series (D-224): collected
 * by Claude (Sonnet) through the gateway from the name of the character and
 * of the series alone (L0), a hundred at a time on the user's click, numbered,
 * without doubles, up to MAX_SERIES_LINES. At each answer the core, not the
 * model, draws a few lines not used lately in that conversation
 * (`draw`): a model at temperature 0 always picks the same. A line that names
 * someone else of the series goes in a private step only (`named`), as the
 * scene of D-223. Fan content for personal use: data/characters/serie-lines,
 * outside git like the packs of third parties. Claude does not remember them
 * (second trial): the real ones come from Italian Wikiquote (`importWikiquote`,
 * see wikiquote.ts), after the user said yes once to what leaves.
 */

export const SERIES_LINES_DIR = 'serie-lines';
export const MAX_SERIES_LINES = 1000;
/** Asked to Claude each time. */
export const SERIES_LINES_BATCH = 100;
/** A line longer than this is not a line: refused. */
export const MAX_LINE_LENGTH = 200;
/** Nor is a name alone («Jordan.», «Bobbo.»), seen in the first trial: at least two words and this many characters. */
export const MIN_LINE_LENGTH = 12;
/** The user's yes to the downloads from Wikiquote, asked once (D-224). */
export const WIKIQUOTE_CONSENT_FILE = 'wikiquote.json';
/** A page of Wikiquote read for one character serves the others of the series for this long. */
const PAGE_CACHE_MS = 60 * 60_000;
/** Drawn for an answer. */
export const LINES_PER_ANSWER = 5;
/** The lines drawn lately in a conversation, not drawn again while others are left. */
const RECENT_PER_CONVERSATION = 40;
/** Conversations remembered at once; the oldest is forgotten first. */
const CONVERSATIONS_REMEMBERED = 500;

export interface SeriesLine {
  /** Its number in the archive: never given again, also after «togli». */
  n: number;
  text: string;
  /** The episode as Claude gave it («1x04»), when it knew it. */
  episode?: string;
  /** It names someone else (Claude's list or ours): private steps only. */
  named: boolean;
  /** Written by the user in its card, not collected by Claude. */
  own?: boolean;
  /** Taken from the page of the series on it.wikiquote.org, not from Claude. */
  origin?: 'wikiquote';
}

export interface WikiquoteStatus {
  /** The name of the pages of the series on Wikiquote, null when it has none. */
  page: string | null;
  host: string;
  /** The user already said yes to the download. */
  consent: boolean;
}

export interface SeriesLinesStatus {
  character: string;
  lines: SeriesLine[];
  max: number;
  running: boolean;
  /** Who collects now, or collected last in this run of the core. */
  job: 'claude' | 'wikiquote' | null;
  wikiquote: WikiquoteStatus;
  /** Why the last collection stopped, in Italian; null when it went well. */
  stopped: string | null;
  /** Lines added by the last collection, when one ended in this run of the core. */
  added: number | null;
}

export class SeriesLinesError extends Error {
  override name = 'SeriesLinesError';
  readonly code: 'unknown' | 'full' | 'missing' | 'invalid' | 'double' | 'consent' | 'unavailable';

  constructor(code: SeriesLinesError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface SeriesLines {
  status(character: string): SeriesLinesStatus;
  /** Starts collecting SERIES_LINES_BATCH more in the background; nothing while a collection of it runs. */
  generate(character: string): SeriesLinesStatus;
  /**
   * Starts taking the lines of the character from the page of its series on
   * it.wikiquote.org in the background. Refused («consent») until the user
   * said yes once: `consent` true is that yes, remembered in data/.
   */
  importWikiquote(character: string, consent: boolean): SeriesLinesStatus;
  /** Takes line `n` out for good. */
  remove(character: string, n: number): SeriesLinesStatus;
  /** A line the user writes by hand, numbered after the others; refused when it is no line, a double or personal data. */
  add(character: string, text: string): SeriesLinesStatus;
  /** Whether a draw would give anything for a step that admits named lines or not. */
  has(character: string, named: boolean): boolean;
  /** A few lines for one answer in `conversation`, not drawn there lately. */
  draw(character: string, options: { conversation: string; named: boolean; count?: number }): string[];
  idle(): Promise<void>;
}

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** The text of a line as kept: one line, no fences of the prompt, two words or more, within MIN/MAX_LINE_LENGTH; undefined otherwise. */
export function lineText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  const length = Array.from(text).length;
  if (HIDDEN.test(text) || /[<>]/.test(text) || length < MIN_LINE_LENGTH || length > MAX_LINE_LENGTH || text.split(' ').length < 2) return undefined;
  return text;
}

/** Words that open a line with a comma without being a name («Ciao, novellino»): not marked. */
const OPENERS = new Set(['ciao', 'senti', 'ascolta', 'ascoltami', 'guarda', 'allora', 'bene', 'ecco', 'okay', 'ehi', 'bravo', 'brava', 'dai', 'aspetta', 'scusa', 'scusate', 'grazie', 'insomma', 'beh', 'sai', 'certo', 'perfetto', 'sentite', 'ragazzi', 'gente', 'amico', 'bello', 'tesoro', 'pivello', 'novellino']);

/** The same line written a little differently: case, accents, punctuation and spaces aside. */
export function lineKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Whether a line names someone (D-224): a name of another person of the
 * series, or any capitalized word inside a sentence other than the
 * character's own names. Wide on purpose: a work step may end in a brief to
 * the cloud, where a name would be a person for the second scanner (D-113).
 */
export function namesSomeone(character: string, text: string): boolean {
  if (otherSeriesNames(character, text).length > 0) return true;
  const self = Object.hasOwn(SERIES_PERSONAS, character) ? SERIES_PERSONAS[character] : undefined;
  const own = new Set((self === undefined ? [] : seriesNamesOf(self)).flatMap((name) => [name, ...name.split(' ')]));
  const other = (word: string): boolean => /^\p{Lu}/u.test(word) && !own.has(word) && !own.has(word.replace(/\.$/, ''));
  for (const sentence of text.split(/(?<=[.!?…:;])\s+/u)) {
    const raw = sentence.split(/\s+/);
    const words = raw.map((word) => word.replace(/^[^\p{L}]+|[^\p{L}.]+$/gu, ''));
    if (words.slice(1).some(other)) return true;
    // A first word called out with a comma is often a name («Kelso, …»): marked, unless a word of the language
    // that opens a line (OPENERS) or one of three letters or fewer («No, no, no!»).
    const first = words[0] ?? '';
    if (/^[^\p{L}]*\p{Lu}\p{L}*,$/u.test(raw[0] ?? '') && Array.from(first).length > 3 && !OPENERS.has(first.toLowerCase()) && other(first)) return true;
  }
  return false;
}

/**
 * The instructions to Claude (L0, ours). The lines already kept go apart,
 * L1 (`collect`): the file is in data/ and a line may have been written by
 * hand, so it is the user's text, as the rewrite of D-223.
 */
export function linesPrompt(name: string, show: string, known: number): string {
  return [
    `Collect real lines of the character "${name}" of the TV series "${show}", for a personal role-play.`,
    `Give ${String(SERIES_LINES_BATCH)} lines the character really says in the series, as many as you can up to that: its famous quotes (widely quoted online), catchphrases and running gags, the openings of its rants, the way it answers or teases the others, short bits of its dialogue from the episodes you remember. Short quotations for a personal role-play.`,
    'They must be real lines of the series, not invented in its style: leave out a line only when you do not remember it being said.',
    'Each line is at least one whole sentence of the character: never a name or a nickname alone, never a single word.',
    'Write them in Italian: the words of the Italian dub when you know them, else a faithful translation.',
    `Each line at most ${String(MAX_LINE_LENGTH - 40)} characters, the character's words only (no stage directions, no speaker names before the line)${known > 0 ? `; none of the ${String(known)} lines already collected, in the JSON array of the next part` : ''}.`,
    'Answer with only a JSON array of objects {"text": "...", "episode": "1x04" or "" when unsure, "names": ["other characters the line mentions"]}.',
  ].join('\n');
}

/** The lines of Claude's answer: objects with a text that passes `lineText`, the rest left out; undefined when it is no JSON array. */
export function parseLines(answer: string): { text: string; episode?: string; names: string[] }[] | undefined {
  const start = answer.indexOf('[');
  const end = answer.lastIndexOf(']');
  if (start === -1 || end < start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const text = lineText(record.text);
    if (text === undefined) return [];
    const episode = typeof record.episode === 'string' ? record.episode.trim() : '';
    const names = Array.isArray(record.names) ? record.names.filter((name): name is string => typeof name === 'string' && name.trim() !== '') : [];
    return [{ text, ...(episode !== '' && episode.length <= 20 && !HIDDEN.test(episode) && !/[<>]/.test(episode) ? { episode } : {}), names }];
  });
}

interface Stored {
  lines: SeriesLine[];
  next: number;
}

export function createSeriesLines(options: {
  /** data/characters: the archive goes in its serie-lines folder. */
  dir: string;
  ask: AskCloudText;
  onEvent?: (kind: string, payload: Record<string, string | number>) => void;
  /** A number in [0, 1); Math.random by default (tests give theirs). */
  random?: () => number;
  secrets?: KnownSecrets;
  /** The wikitext of a page of it.wikiquote.org; without it the import says Wikiquote cannot be reached. */
  wikiquote?: WikiquoteGet;
  /** Between two pages of Wikiquote; WIKIQUOTE_PAUSE_MS by default (tests give 0). */
  pauseMs?: number;
  /** After «too many requests», before asking the page once more; WIKIQUOTE_LIMITED_WAIT_MS by default (tests give 0). */
  limitedWaitMs?: number;
}): SeriesLines {
  const folder = join(options.dir, SERIES_LINES_DIR);
  const random = options.random ?? Math.random;
  const secrets = options.secrets ?? knownSecrets;
  const running = new Map<string, Promise<void>>();
  const stopped = new Map<string, string>();
  const added = new Map<string, number>();
  const jobs = new Map<string, 'claude' | 'wikiquote'>();
  /**
   * One download from Wikiquote at a time for all the characters, with the
   * pause between two, and the pages read in the last hour kept in memory:
   * five people of Scrubs ask the same nine pages once (D-224).
   */
  let wikiquoteQueue: Promise<unknown> = Promise.resolve();
  let lastDownload = 0;
  /** A page read, or missing (null), with when; and the downloads under way, shared by who asks the same page meanwhile. */
  const pageCache = new Map<string, { at: number; text: string | null }>();
  const pending = new Map<string, Promise<string>>();
  const pageOf = (title: string, get: WikiquoteGet): Promise<string> => {
    const hit = pageCache.get(title);
    if (hit !== undefined && Date.now() - hit.at < PAGE_CACHE_MS) {
      return hit.text === null ? Promise.reject(new WikiquoteError('missing', 'la pagina non c’è su Wikiquote')) : Promise.resolve(hit.text);
    }
    const already = pending.get(title);
    if (already !== undefined) return already;
    const turn = wikiquoteQueue.then(async () => {
      const wait = lastDownload + (options.pauseMs ?? WIKIQUOTE_PAUSE_MS) - Date.now();
      if (lastDownload > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        let text: string;
        try {
          text = await get(title);
        } catch (error) {
          // «Too many requests»: one more time after a minute, then the import stops with what it read (D-245).
          if (!(error instanceof WikiquoteError && error.code === 'limited')) throw error;
          // unref: a wait does not keep the core alive when it stops.
          await new Promise((resolve) => setTimeout(resolve, options.limitedWaitMs ?? WIKIQUOTE_LIMITED_WAIT_MS).unref());
          text = await get(title);
        }
        pageCache.set(title, { at: Date.now(), text });
        return text;
      } catch (error) {
        if (error instanceof WikiquoteError && error.code === 'missing') pageCache.set(title, { at: Date.now(), text: null });
        throw error;
      } finally {
        lastDownload = Date.now();
        pending.delete(title);
      }
    });
    pending.set(title, turn);
    wikiquoteQueue = turn.catch(() => undefined);
    return turn;
  };
  const consentPath = join(folder, WIKIQUOTE_CONSENT_FILE);
  const cache = new Map<string, { mtime: number; stored: Stored }>();
  /** conversation → character → numbers drawn lately, oldest first. */
  const recent = new Map<string, Map<string, number[]>>();

  const known = (character: string): (typeof SERIES_PERSONAS)[string] => {
    const person = Object.hasOwn(SERIES_PERSONAS, character) ? SERIES_PERSONAS[character] : undefined;
    if (person === undefined) throw new SeriesLinesError('unknown', `nessun personaggio delle serie si chiama ${character}`);
    return person;
  };
  const pathOf = (character: string): string => join(folder, `${character}.json`);
  // Written by hand, a line could hold personal data or a value of the vault: it is left out, as the persona's text (D-107).
  const clean = (text: string): boolean => scanText(text).length === 0 && secrets.find(text).length === 0;

  function read(character: string): Stored {
    const path = pathOf(character);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return { lines: [], next: 1 };
    }
    const hit = cache.get(character);
    if (hit?.mtime === mtime) return hit.stored;
    let stored: Stored = { lines: [], next: 1 };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { lines?: unknown; next?: unknown };
      const seen = new Set<number>();
      const lines = (Array.isArray(parsed.lines) ? parsed.lines : []).flatMap((item: unknown): SeriesLine[] => {
        if (typeof item !== 'object' || item === null) return [];
        const record = item as Record<string, unknown>;
        const text = lineText(record.text);
        const n = record.n;
        if (text === undefined || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || seen.has(n) || !clean(text)) return [];
        seen.add(n);
        const episode = typeof record.episode === 'string' && record.episode !== '' ? { episode: record.episode } : {};
        return [
          {
            n,
            text,
            ...episode,
            named: record.named === true || namesSomeone(character, text),
            ...(record.own === true ? { own: true } : {}),
            ...(record.origin === 'wikiquote' ? { origin: 'wikiquote' as const } : {}),
          },
        ];
      });
      const highest = lines.reduce((top, line) => Math.max(top, line.n), 0);
      const next = typeof parsed.next === 'number' && Number.isSafeInteger(parsed.next) && parsed.next > highest ? parsed.next : highest + 1;
      stored = { lines: lines.slice(0, MAX_SERIES_LINES), next };
    } catch {
      // Unreadable: no lines; the next collection writes it again.
    }
    cache.set(character, { mtime, stored });
    return stored;
  }

  function save(character: string, stored: Stored): void {
    mkdirSync(folder, { recursive: true });
    const path = pathOf(character);
    const temporary = `${path}.${String(Date.now())}.tmp`;
    const person = known(character);
    const note = `Battute vere di ${person.name} (${person.show}), da Wikiquote italiano, da Claude o scritte a mano (D-224). Uso personale, fuori da git.`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ note, next: stored.next, lines: stored.lines }, null, 2)}\n`);
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    cache.delete(character);
  }

  function consented(): boolean {
    try {
      return (JSON.parse(readFileSync(consentPath, 'utf8')) as { consent?: unknown }).consent === true;
    } catch {
      return false;
    }
  }

  function status(character: string): SeriesLinesStatus {
    const person = known(character);
    return {
      character,
      lines: read(character).lines,
      max: MAX_SERIES_LINES,
      running: running.has(character),
      job: jobs.get(character) ?? null,
      wikiquote: { page: wikiquoteName(person.show) ?? null, host: WIKIQUOTE_HOST, consent: consented() },
      stopped: stopped.get(character) ?? null,
      added: added.get(character) ?? null,
    };
  }

  async function collect(character: string): Promise<void> {
    const person = known(character);
    const plain = read(character)
      .lines.filter((line) => !line.named)
      .map((line) => line.text);
    const answer = await options.ask({
      // The sources of the character (D-214, D-224): its names and those of the series are no person for the second
      // scanner there, which otherwise stops «Dr. Cox» as a full name (seen in the trial). A kept line that names
      // someone else stays home: Claude may give it again, the doubles are dropped here.
      parts: [
        { text: linesPrompt(person.name, person.show, plain.length), source: seriesSource(character) },
        ...(plain.length === 0 ? [] : [{ text: JSON.stringify(plain), source: seriesLinesSource(character), label: 'L1' as const }]),
      ],
      purpose: `citazioni vere di un personaggio delle serie (${character})`,
      timeoutMs: 8 * 60_000,
    });
    const found = parseLines(answer);
    if (found === undefined) {
      options.onEvent?.('series.lines_unreadable', { character });
      throw new CloudTextError('failed', 'la risposta di Claude non si legge: riprova');
    }
    // Read again before writing: a «togli» made meanwhile stays.
    const stored = read(character);
    const keys = new Set(stored.lines.map((line) => lineKey(line.text)));
    const lines = [...stored.lines];
    let next = stored.next;
    for (const line of found) {
      if (lines.length >= MAX_SERIES_LINES) break;
      const key = lineKey(line.text);
      if (key === '' || keys.has(key) || !clean(line.text)) continue;
      keys.add(key);
      const named = line.names.length > 0 || namesSomeone(character, line.text);
      lines.push({ n: next, text: line.text, ...(line.episode === undefined ? {} : { episode: line.episode }), named });
      next += 1;
    }
    const count = lines.length - stored.lines.length;
    save(character, { lines, next });
    added.set(character, count);
    options.onEvent?.('series.lines_added', { character, count });
  }

  async function fromWikiquote(character: string): Promise<void> {
    const person = known(character);
    const get = options.wikiquote;
    if (get === undefined) throw new WikiquoteError('upstream', 'Wikiquote non si raggiunge da questo core');
    const pages = Object.hasOwn(WIKIQUOTE_PAGES, person.show) ? (WIKIQUOTE_PAGES[person.show] ?? []) : [];
    const speakers = Object.hasOwn(WIKIQUOTE_SPEAKERS, character) ? (WIKIQUOTE_SPEAKERS[character] ?? []) : [];
    const found: { text: string; episode?: string }[] = [];
    let pagesRead = 0;
    let cut: WikiquoteError | undefined;
    for (const page of pages) {
      let wikitext: string;
      try {
        wikitext = await pageOf(page.title, get);
      } catch (error) {
        // A missing page of a season is skipped; any other failure stops, with what was read so far kept.
        if (error instanceof WikiquoteError && error.code === 'missing') continue;
        if (found.length === 0) throw error;
        cut = error instanceof WikiquoteError ? error : new WikiquoteError('upstream', 'Wikiquote si è interrotto');
        break;
      }
      pagesRead += 1;
      found.push(...parseWikiquote(wikitext, speakers, page));
    }
    if (pagesRead === 0) throw new WikiquoteError('missing', `su Wikiquote non c’è la pagina di ${person.show}`);
    // Read again before writing: a «togli» made meanwhile stays.
    const stored = read(character);
    const keys = new Set(stored.lines.map((line) => lineKey(line.text)));
    const lines = [...stored.lines];
    let next = stored.next;
    let usable = 0;
    for (const line of found) {
      const sentences = cutAtSentence(line.text, MAX_LINE_LENGTH);
      const text = sentences === undefined ? undefined : lineText(sentences);
      if (text === undefined || !clean(text)) continue;
      usable += 1;
      const key = lineKey(text);
      if (key === '' || keys.has(key) || lines.length >= MAX_SERIES_LINES) continue;
      keys.add(key);
      lines.push({ n: next, text, ...(line.episode === undefined ? {} : { episode: line.episode }), named: namesSomeone(character, text), origin: 'wikiquote' });
      next += 1;
    }
    if (usable === 0) throw new WikiquoteError('missing', `su Wikiquote non ci sono battute di ${person.name}`);
    const count = lines.length - stored.lines.length;
    save(character, { lines, next });
    added.set(character, count);
    options.onEvent?.('series.lines_wikiquote', { character, count });
    if (cut !== undefined) throw new WikiquoteError(cut.code, `${cut.message} (pagine lette: ${String(pagesRead)} su ${String(pages.length)}; battute aggiunte: ${String(count)}; riprova per le altre)`);
  }

  function start(character: string, job: 'claude' | 'wikiquote', work: () => Promise<void>): SeriesLinesStatus {
    stopped.delete(character);
    added.delete(character);
    jobs.set(character, job);
    const done = work()
      .catch((error: unknown) => {
        stopped.set(character, error instanceof CloudTextError || error instanceof WikiquoteError ? error.message : 'raccolta interrotta');
      })
      .finally(() => {
        running.delete(character);
      });
    running.set(character, done);
    return status(character);
  }

  function remember(conversation: string, character: string, numbers: readonly number[]): void {
    let byCharacter = recent.get(conversation);
    if (byCharacter === undefined) {
      byCharacter = new Map();
      if (recent.size >= CONVERSATIONS_REMEMBERED) {
        const oldest = recent.keys().next().value;
        if (oldest !== undefined) recent.delete(oldest);
      }
    } else {
      // The most recent conversation goes last: the oldest is forgotten first.
      recent.delete(conversation);
    }
    recent.set(conversation, byCharacter);
    byCharacter.set(character, [...(byCharacter.get(character) ?? []), ...numbers].slice(-RECENT_PER_CONVERSATION));
  }

  const pool = (character: string, named: boolean): SeriesLine[] => (Object.hasOwn(SERIES_PERSONAS, character) ? read(character).lines.filter((line) => named || !line.named) : []);

  return {
    status,
    generate(character) {
      known(character);
      if (running.has(character)) return status(character);
      if (read(character).lines.length >= MAX_SERIES_LINES) throw new SeriesLinesError('full', `l'archivio ha già ${String(MAX_SERIES_LINES)} citazioni: togline qualcuna prima`);
      return start(character, 'claude', () => collect(character));
    },
    importWikiquote(character, consent) {
      const person = known(character);
      if (wikiquoteName(person.show) === undefined) throw new SeriesLinesError('unavailable', `Wikiquote non ha una pagina di ${person.show}`);
      if (running.has(character)) return status(character);
      const asked = !consented();
      if (asked && !consent) throw new SeriesLinesError('consent', `prima conferma che Arianna può scaricare da ${WIKIQUOTE_HOST} la pagina della serie`);
      if (read(character).lines.length >= MAX_SERIES_LINES) throw new SeriesLinesError('full', `l'archivio ha già ${String(MAX_SERIES_LINES)} battute: togline qualcuna prima`);
      if (asked) {
        const temporary = `${consentPath}.${String(Date.now())}.tmp`;
        try {
          mkdirSync(folder, { recursive: true });
          writeFileSync(temporary, `${JSON.stringify({ consent: true, host: WIKIQUOTE_HOST, at: new Date().toISOString() }, null, 2)}\n`);
          renameSync(temporary, consentPath);
        } catch {
          throw new SeriesLinesError('invalid', 'non riesco a ricordare la conferma: controlla la cartella data/characters');
        } finally {
          rmSync(temporary, { force: true });
        }
      }
      return start(character, 'wikiquote', () => fromWikiquote(character));
    },
    remove(character, n) {
      known(character);
      const stored = read(character);
      if (!stored.lines.some((line) => line.n === n)) throw new SeriesLinesError('missing', `nessuna citazione numero ${String(n)}`);
      save(character, { lines: stored.lines.filter((line) => line.n !== n), next: stored.next });
      return status(character);
    },
    add(character, value) {
      known(character);
      const text = lineText(value);
      if (text === undefined) throw new SeriesLinesError('invalid', `una battuta è una frase intera di almeno ${String(MIN_LINE_LENGTH)} caratteri, al massimo ${String(MAX_LINE_LENGTH)}, senza < e >`);
      if (!clean(text)) throw new SeriesLinesError('invalid', 'la battuta sembra contenere un dato personale o un valore del vault');
      const stored = read(character);
      if (stored.lines.length >= MAX_SERIES_LINES) throw new SeriesLinesError('full', `l'archivio ha già ${String(MAX_SERIES_LINES)} battute: togline qualcuna prima`);
      if (stored.lines.some((line) => lineKey(line.text) === lineKey(text))) throw new SeriesLinesError('double', 'questa battuta c’è già');
      save(character, { lines: [...stored.lines, { n: stored.next, text, named: namesSomeone(character, text), own: true }], next: stored.next + 1 });
      return status(character);
    },
    has(character, named) {
      return pool(character, named).length > 0;
    },
    draw(character, { conversation, named, count = LINES_PER_ANSWER }) {
      const lines = pool(character, named);
      if (lines.length === 0) return [];
      const lately = new Set(recent.get(conversation)?.get(character) ?? []);
      const fresh = lines.filter((line) => !lately.has(line.n));
      // Past the lines not drawn lately, the others: never fewer than there are.
      const order = [...shuffled(fresh, random), ...shuffled(lines.filter((line) => lately.has(line.n)), random)];
      const chosen = order.slice(0, Math.min(count, lines.length));
      remember(conversation, character, chosen.map((line) => line.n));
      return chosen.map((line) => line.text);
    },
    async idle() {
      await Promise.all(running.values());
    },
  };
}

/** A copy in random order (Fisher-Yates). */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let at = copy.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [copy[at], copy[other]] = [copy[other] as T, copy[at] as T];
  }
  return copy;
}
