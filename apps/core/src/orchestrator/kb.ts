import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canRead, isAtMost, labelForKbPage, labelForPath, maxLabel, type Context, type Label, type LabelRules } from '@arianna/policy';

/**
 * The knowledge base as the orchestrator's tools see it (task 1.10, D-053):
 * markdown pages under `kb/` of ARIANNA_HOME, each labeled by the folder
 * rules of labels.toml and by its own `label:` header, which can only raise
 * it. Pages above the context's clearance are never opened, not even to
 * search them. Search is plain word matching: hybrid retrieval is Phase 2.
 */
export const KB_DIR = 'kb';
/** Where an agent with autonomy A1 may write (docs/AGENT-CARDS.md). */
export const KB_INBOX = 'kb/inbox';

const MAX_PAGE_BYTES = 200_000;
const MAX_PAGES = 5_000;
const SNIPPET = 220;

export type KbErrorCode = 'invalid-path' | 'not-found' | 'above-clearance' | 'not-allowed' | 'exists' | 'too-large';

/** Messages name paths the model chose and fixed reasons, never page content. */
export class KbError extends Error {
  override name = 'KbError';
  readonly code: KbErrorCode;

  constructor(code: KbErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface KbPage {
  /** Relative to ARIANNA_HOME, e.g. kb/private/casa/caldaia.md. */
  path: string;
  label: Label;
  title: string;
  body: string;
}

export interface KbHit {
  path: string;
  title: string;
  snippet: string;
  label: Label;
}

export interface KbSearch {
  hits: KbHit[];
  /** True when pages above the clearance exist and were left out, whatever they contain. */
  skippedAbove: boolean;
}

export interface Kb {
  read(path: string, context: Context): KbPage;
  search(query: string, context: Context, limit?: number): KbSearch;
  /** Writes a page under kb/inbox with the label of what it was written from. */
  write(path: string, content: string, label: Label, source: string): { path: string; label: Label };
}

const SEGMENT = /^[\p{L}\p{N}_][\p{L}\p{N} ._-]*$/u;

/** A page path the tools accept: under kb/, plain segments, ending in .md. */
export function checkPagePath(path: string): string {
  const trimmed = path.trim();
  const segments = trimmed.split('/');
  if (
    segments[0] !== KB_DIR ||
    segments.length < 2 ||
    !trimmed.endsWith('.md') ||
    trimmed.length > 300 ||
    !segments.slice(1).every((segment) => SEGMENT.test(segment) && !segment.endsWith(' ') && !segment.includes('..'))
  ) {
    throw new KbError('invalid-path', `${JSON.stringify(path)} is not a page path: pages look like kb/folder/name.md`);
  }
  return trimmed;
}

interface Header {
  title?: string;
  source?: string;
  /** Every `label:` line; `invalid` for a header that may hide one (L3 then). */
  labels: string[];
}

/**
 * The `---` header: `key: value` lines, keys in any case; the rest of the page
 * is the body. A header that looks meant but cannot be read safely (no closing
 * line, a line mentioning a label that does not parse) counts as an invalid
 * label, which labelForKbPage turns into L3: a page must never fall back to
 * its folder's label when its author raised it.
 */
export function parsePage(text: string): { header: Header; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!/^---[ \t]*\n/.test(normalized)) return { header: { labels: [] }, body: normalized };
  const start = normalized.indexOf('\n') + 1;
  const end = normalized.indexOf('\n---', start - 1);
  if (end < 0) return { header: { labels: ['invalid'] }, body: normalized };
  const header: Header = { labels: [] };
  for (const line of normalized.slice(start, end).split('\n')) {
    const match = /^\s*([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    const key = match?.[1]?.toLowerCase();
    const value = match?.[2]?.trim() ?? '';
    if (key === 'label') header.labels.push(value);
    // A key that looks like a label (x-label, labels) may hide one; a value may say "label" freely (a URL).
    else if (key !== undefined && /label/i.test(key)) header.labels.push('invalid');
    else if (key === 'title') header.title = unquote(value);
    else if (key === 'source') header.source = value;
    else if (key === undefined && /label/i.test(line)) header.labels.push('invalid');
  }
  return { header, body: normalized.slice(end + 4).replace(/^[^\n]*\n/, '').replace(/^\n+/, '') };
}

/** A YAML double-quoted title (as captures write it) read without its quotes; anything else as it is. */
function unquote(value: string): string {
  if (!/^".*"$/.test(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

/** Lowercase, without accents: "Caparra" and "càparra" match. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function terms(query: string): string[] {
  return [...new Set(fold(query).split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3))];
}

function count(haystack: string, needle: string): number {
  let found = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) found += 1;
  return found;
}

function snippetOf(body: string, words: readonly string[]): string {
  const folded = fold(body);
  const positions = words.map((word) => folded.indexOf(word)).filter((at) => at >= 0);
  const at = positions.length === 0 ? 0 : Math.min(...positions);
  const start = Math.max(0, at - SNIPPET / 3);
  const piece = body.slice(start, start + SNIPPET).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${piece}${start + SNIPPET < body.length ? '…' : ''}`;
}

export function createKb(options: { home: string; rules: LabelRules }): Kb {
  const root = join(options.home, KB_DIR);

  /** The file of a page, refusing symbolic links anywhere under kb/. */
  function fileOf(path: string): string {
    const file = join(options.home, ...path.split('/'));
    let real: string;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) throw new KbError('not-found', `page ${path} not found`);
      if (stat.size > MAX_PAGE_BYTES) throw new KbError('too-large', `page ${path} is too large to read`);
      real = realpathSync(file);
    } catch (error) {
      if (error instanceof KbError) throw error;
      throw new KbError('not-found', `page ${path} not found`);
    }
    if (real !== join(realpathSync(root), ...path.split('/').slice(1))) throw new KbError('not-found', `page ${path} not found`);
    return file;
  }

  function load(path: string): KbPage {
    const { header, body } = parsePage(readFileSync(fileOf(path), 'utf8'));
    return {
      path,
      label: header.labels.length === 0 ? labelForPath(options.rules, path) : maxLabel(...header.labels.map((declared) => labelForKbPage(options.rules, path, declared))),
      title: header.title ?? path.split('/').at(-1)?.replace(/\.md$/, '') ?? path,
      body,
    };
  }

  /** Every page path under kb/, without following links or entering hidden folders. */
  function list(): string[] {
    const found: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (found.length >= MAX_PAGES || entry.name.startsWith('.')) continue;
        const path = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(join(dir, entry.name), path);
        else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
      }
    };
    walk(root, KB_DIR);
    return found;
  }

  return {
    read(path, context) {
      const checked = checkPagePath(path);
      // The folder label first: above the clearance the file is not touched,
      // so the answer is the same whether the page exists or not.
      const refuse = () =>
        new KbError('above-clearance', `page ${checked} is above what this conversation may read: for private documents open a private conversation`);
      if (!canRead(context, labelForPath(options.rules, checked))) throw refuse();
      const page = load(checked);
      if (!canRead(context, page.label)) {
        throw refuse();
      }
      return page;
    },

    search(query, context, limit = 5) {
      const words = terms(query);
      let skippedAbove = false;
      const scored: (KbHit & { score: number })[] = [];
      for (const path of list()) {
        // Folders above the clearance are skipped without opening their pages.
        if (!canRead(context, labelForPath(options.rules, path))) {
          skippedAbove = true;
          continue;
        }
        let page: KbPage;
        try {
          page = load(path);
        } catch {
          continue;
        }
        // A header that raises the page above the clearance: its body is not used.
        if (!canRead(context, page.label)) {
          skippedAbove = true;
          continue;
        }
        const head = fold(`${page.title} ${path}`);
        const body = fold(page.body);
        const score = words.reduce((sum, word) => sum + 3 * count(head, word) + count(body, word), 0);
        if (score > 0) scored.push({ path, title: page.title, snippet: snippetOf(page.body, words), label: page.label, score });
      }
      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      const hits = scored.slice(0, Math.max(1, Math.min(20, limit))).map(({ path, title, snippet, label }) => ({ path, title, snippet, label }));
      return { hits, skippedAbove };
    },

    write(path, content, label, source) {
      const checked = checkPagePath(path);
      if (!checked.startsWith(`${KB_INBOX}/`)) {
        throw new KbError('not-allowed', `with autonomy A1 pages can only be written under ${KB_INBOX}/`);
      }
      // A folder rule may label the inbox higher than what the page was written from.
      const stored = maxLabel(label, labelForKbPage(options.rules, checked, undefined));
      if (!isAtMost(stored, 'L2')) throw new KbError('not-allowed', `${checked} would be labeled ${stored}`);
      const segments = checked.split('/');
      // Every folder from kb/ down must be a real folder: a link would take the page elsewhere.
      let dir = options.home;
      for (const [index, segment] of segments.slice(0, -1).entries()) {
        dir = join(dir, segment);
        let stat;
        try {
          stat = lstatSync(dir);
        } catch {
          if (index === 0) throw new KbError('invalid-path', `${checked}: there is no kb/ folder`);
          mkdirSync(dir, { mode: 0o700 });
          continue;
        }
        if (!stat.isDirectory()) throw new KbError('invalid-path', `${checked} is outside kb/`);
      }
      const file = join(dir, segments.at(-1) ?? '');
      let exists = true;
      try {
        const stat = lstatSync(file);
        if (!stat.isFile()) throw new KbError('invalid-path', `${checked} is not a page`);
      } catch (error) {
        if (error instanceof KbError) throw error;
        exists = false;
      }
      // Only the task that wrote a page may write it again (a step that runs twice).
      if (exists && parsePage(readFileSync(file, 'utf8')).header.source !== source) {
        throw new KbError('exists', `page ${checked} already exists: choose another path`);
      }
      // O_NOFOLLOW: a link put there meanwhile is refused, not followed.
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, `---\nlabel: ${stored}\nsource: ${source}\n---\n\n${content.trim()}\n`);
      } finally {
        closeSync(fd);
      }
      return { path: checked, label: stored };
    },
  };
}
