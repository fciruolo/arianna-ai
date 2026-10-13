import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { labelForPath, maxLabel, type Label, type LabelRules } from '@arianna/policy';

/**
 * Arianna's own documents as knowledge (D-155): the documents of docs/ and
 * CHANGELOG.md, read where they are (never copied, never written), cut into
 * pages a search can find and a read can hold. Each decision of
 * DECISIONS.md (a `| D-NNN |` row) is a page, each section of a document
 * (`##` and `###`) is one, each version of CHANGELOG.md is one. Paths look
 * like `arianna/decisioni/D-144.md`, `arianna/proposte/I-11.md`,
 * `arianna/SPEC/privacy.md`.
 *
 * Every page is L2 at least, fixed here: a header in a document cannot lower
 * it, and a rule of labels.toml on docs/ can only raise it. HANDOFF.md (hand
 * offs between sessions, not stable knowledge) and docs/mockups/ are out.
 * The text of the documents is data, never instructions.
 */
export const ARIANNA_PAGES = 'arianna';
export const ARIANNA_DOCS_LABEL: Label = 'L2';
export const DOCS_DIR = 'docs';
export const CHANGELOG_FILE = 'CHANGELOG.md';
/** Documents of docs/ that are not knowledge. */
export const EXCLUDED_DOCS: readonly string[] = ['HANDOFF.md'];
const DECISIONS_FILE = 'DECISIONS.md';
const PROPOSALS_FILE = 'PROPOSTE.md';
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_DOCS = 100;
const MAX_TITLE = 140;
const MAX_MENTIONS = 40;
/** Longest page body: under MAX_READ of orchestrator/tools.ts, with the lines that link the parts. */
export const PAGE_CHARS = 5_500;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}\.md$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DECISION_ID = /^D-\d{1,4}[a-z]?$/;
const OWN_ID = /^((?:D|I)-\d{1,4}[a-z]?)(?![\w-])/;

export interface AriannaPage {
  /** e.g. arianna/decisioni/D-144.md */
  path: string;
  title: string;
  /** decisioni, proposte, changelog, or the name of the document (SPEC, ROADMAP…). */
  folder: string;
  kind: 'decisione' | 'proposta' | 'versione' | 'sezione';
  body: string;
  label: Label;
  /** Decisions (D-NNN) and ideas (I-NN) the page mentions, other than itself. */
  mentions: string[];
  /** The document it comes from, relative to ARIANNA_HOME. */
  source: string;
  updatedAt: string;
}

export type AriannaDocsErrorCode = 'invalid' | 'not-found';

export class AriannaDocsError extends Error {
  override name = 'AriannaDocsError';
  readonly code: AriannaDocsErrorCode;

  constructor(code: AriannaDocsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A page path of this source: `arianna/<folder>/<page>.md`, plain segments only. */
export function isAriannaPagePath(path: string): boolean {
  const segments = path.split('/');
  if (segments.length !== 3 || segments[0] !== ARIANNA_PAGES || !path.endsWith('.md')) return false;
  return segments.slice(1).every((segment) => SEGMENT.test(segment) && !segment.includes('..'));
}

type Unit = Pick<AriannaPage, 'title' | 'body' | 'kind'> & { slug: string; self?: string };

/** Cells of a markdown table row, `\|` kept inside its cell and unescaped. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function shorten(text: string, max = MAX_TITLE): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The title of a decision: its opening bold phrase, or its first words. */
function decisionHeading(text: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(text);
  const head = bold?.[1] ?? text.split(/(?<=[.!?])\s/)[0] ?? text;
  return shorten(head.replace(/[.:]\s*$/, '').replace(/\*\*/g, ''), MAX_TITLE - 10);
}

/** The rows `| D-NNN | data | decisione | motivo | stato |` of DECISIONS.md; the first of an id wins. */
export function decisionUnits(text: string): Unit[] {
  const units: Unit[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('| D-')) continue;
    const row = cells(line);
    if (row.length < 5) continue;
    // An unescaped `|` is more often in the long decision than in the reason or the status: the cells in between are the decision.
    const [id = '', date = ''] = row;
    const [reason = '', state = ''] = row.slice(-2);
    const decision = row.slice(2, -2).join(' | ');
    if (!DECISION_ID.test(id) || seen.has(id) || decision === '') continue;
    seen.add(id);
    // Status and reason first: a long decision is cut at the end of a read, never its status.
    const body = [
      `**Stato:** ${state === '' ? '—' : state}`,
      '',
      `**Data:** ${date === '' ? '—' : date}`,
      '',
      '### Motivo',
      '',
      reason === '' ? '—' : reason,
      '',
      '### Decisione',
      '',
      decision,
    ].join('\n');
    units.push({ slug: id, self: id, title: `${id} · ${decisionHeading(decision)}`, body, kind: 'decisione' });
  }
  return units;
}

/** A path segment from a heading: an id (D-078, I-11) as it is, a version without brackets, else plain words. */
function headingSlug(heading: string): string {
  const id = OWN_ID.exec(heading)?.[1];
  if (id !== undefined) return id;
  const version = /^\[([^\]]{1,40})\]/.exec(heading)?.[1] ?? heading;
  const slug = version
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 60)
    .replace(/[-.]+$/, '');
  return slug === '' ? 'sezione' : slug;
}

/** Headings without markdown emphasis and code marks, for titles. */
function plainHeading(heading: string): string {
  return heading.replace(/\*\*|`/g, '').trim();
}

/**
 * The sections of a markdown document, cut at `##` (and `###` when `deep`),
 * never inside a code block. What comes before the first section is
 * "introduzione" when it has text. Empty sections (a `##` straight followed
 * by its `###`) are left out.
 */
export function sectionUnits(text: string, kind: Unit['kind'], deep: boolean): Unit[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let docTitle: string | undefined;
  const raw: { level: number; heading: string; lines: string[] }[] = [{ level: 0, heading: '', lines: [] }];
  let fence: string | undefined;
  for (const line of lines) {
    const fenceMark = /^\s{0,3}(```|~~~)/.exec(line)?.[1];
    if (fenceMark !== undefined) fence = fence === undefined ? fenceMark : fence === fenceMark ? undefined : fence;
    const match = fence === undefined && fenceMark === undefined ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    const level = match?.[1]?.length ?? 0;
    if (match !== null && level === 1 && docTitle === undefined) {
      docTitle = plainHeading(match[2] ?? '');
      continue;
    }
    if (match !== null && (level === 2 || (deep && level === 3))) {
      raw.push({ level, heading: plainHeading(match[2] ?? ''), lines: [] });
      continue;
    }
    raw.at(-1)?.lines.push(line);
  }
  const units: Unit[] = [];
  const taken = new Set<string>();
  const unique = (slug: string): string => {
    let candidate = slug;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${slug}-${String(n)}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  };
  let parent: { heading: string; slug: string } | undefined;
  for (const section of raw) {
    const body = section.lines.join('\n').trim();
    if (section.level === 0) {
      if (body !== '') units.push({ slug: unique('introduzione'), title: shorten(docTitle ?? 'Introduzione'), body, kind });
      continue;
    }
    const own = OWN_ID.exec(section.heading)?.[1];
    let slug: string;
    let title: string;
    if (section.level === 2 || parent === undefined) {
      slug = headingSlug(section.heading);
      title = section.heading;
      if (section.level === 2) parent = { heading: section.heading, slug };
    } else if (own !== undefined) {
      slug = own;
      title = section.heading;
    } else {
      slug = `${parent.slug}-${headingSlug(section.heading)}`.slice(0, 90).replace(/[-.]+$/, '');
      title = `${parent.heading} › ${section.heading}`;
    }
    const finalSlug = unique(slug);
    if (body === '') continue;
    units.push({ slug: finalSlug, ...(own === undefined ? {} : { self: own }), title: shorten(title), body, kind });
  }
  return units;
}

/** The decisions and ideas a text mentions, in order, without `self`. */
export function mentionsOf(text: string, self?: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![\w-])((?:D|I)-\d{1,4}[a-z]?)(?![\w-])/g)) {
    const id = match[1] ?? '';
    if (id !== self) found.add(id);
    if (found.size >= MAX_MENTIONS) break;
  }
  return [...found];
}

/** Which folder, kind and cut a document gets. */
function shapeOf(source: string): { folder: string; units: (text: string) => Unit[] } {
  if (source === `${DOCS_DIR}/${DECISIONS_FILE}`) return { folder: 'decisioni', units: decisionUnits };
  if (source === `${DOCS_DIR}/${PROPOSALS_FILE}`) return { folder: 'proposte', units: (text) => sectionUnits(text, 'proposta', true) };
  if (source === CHANGELOG_FILE) return { folder: 'changelog', units: (text) => sectionUnits(text, 'versione', false) };
  const name = source.split('/').at(-1)?.replace(/\.md$/, '') ?? source;
  return { folder: name, units: (text) => sectionUnits(text, 'sezione', true) };
}

/**
 * A body cut in parts of at most `max` characters, at a blank line when there
 * is one, else at a line end or a space: every page is read whole by `kb.read`.
 */
export function partsOf(body: string, max = PAGE_CHARS): string[] {
  const parts: string[] = [];
  let rest = body;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max / 3) cut = window.lastIndexOf('\n');
    if (cut < max / 3) cut = window.lastIndexOf(' ');
    if (cut < max / 3) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  parts.push(rest);
  return parts;
}

/** The pages of one document's text: pure, for the tests. A long unit is cut in parts that name each other. */
export function pagesOf(source: string, text: string, label: Label, updatedAt: string): AriannaPage[] {
  const { folder, units } = shapeOf(source);
  if (!SEGMENT.test(folder)) return [];
  const pages: AriannaPage[] = [];
  const all = units(text);
  const taken = new Set(all.map((unit) => unit.slug.toLowerCase()));
  for (const unit of all) {
    if (!SEGMENT.test(unit.slug) || unit.slug.includes('..')) continue;
    const parts = partsOf(unit.body);
    // A part takes a name no heading took ("Foo parte 2" beside a long "Foo"): "-bis" until it is free.
    const partSlug = (index: number): string => {
      let slug = `${unit.slug}-parte-${String(index + 1)}`;
      while (taken.has(slug.toLowerCase())) slug = `${slug}-bis`;
      taken.add(slug.toLowerCase());
      return slug;
    };
    const slugs = parts.map((_part, index) => (index === 0 ? unit.slug : partSlug(index)));
    const pathOf = (index: number): string => `${ARIANNA_PAGES}/${folder}/${slugs[index] ?? unit.slug}.md`;
    for (const [index, part] of parts.entries()) {
      const title = parts.length === 1 ? unit.title : shorten(`${unit.title} (${String(index + 1)}/${String(parts.length)})`);
      const body = [
        ...(index === 0 ? [] : [`_Seguito di ${pathOf(index - 1)}_`, '']),
        part,
        ...(index === parts.length - 1 ? [] : ['', `_Continua in ${pathOf(index + 1)}_`]),
      ].join('\n');
      pages.push({ path: pathOf(index), title, folder, kind: unit.kind, body, label, mentions: mentionsOf(`${unit.title}\n${part}`, unit.self), source, updatedAt });
    }
  }
  return pages;
}

/** Where a mention points among the pages: a decision first, then an idea of PROPOSTE. */
export function mentionPath(id: string): string {
  return `${ARIANNA_PAGES}/${id.startsWith('D-') ? 'decisioni' : 'proposte'}/${id}.md`;
}

export interface AriannaDocs {
  /** Every page, read again only when a document changes. */
  list(): AriannaPage[];
  /** One page; `invalid` for a path that is not of this source, `not-found` otherwise. */
  load(path: string): AriannaPage;
}

/** A plain file under ARIANNA_HOME, every folder on the way real, opened without following a link. */
function readDocument(home: string, rel: string): { text: string; mtimeMs: number; size: number } | undefined {
  const segments = rel.split('/');
  let dir = home;
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    try {
      if (!lstatSync(dir).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  const file = join(dir, segments.at(-1) ?? '');
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_DOC_BYTES) return undefined;
    if (realpathSync(file) !== join(realpathSync(home), ...segments)) return undefined;
    return { text: readFileSync(fd, 'utf8'), mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The documents of this source, relative to ARIANNA_HOME: docs/*.md (not in subfolders) and CHANGELOG.md. */
export function ariannaDocuments(home: string): string[] {
  const found: string[] = [];
  try {
    const docs = join(home, DOCS_DIR);
    if (lstatSync(docs).isDirectory()) {
      for (const entry of readdirSync(docs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        // readdir reports links as links: only plain files are taken.
        if (entry.isFile() && FILE_NAME.test(entry.name) && !EXCLUDED_DOCS.includes(entry.name)) found.push(`${DOCS_DIR}/${entry.name}`);
        if (found.length >= MAX_DOCS) break;
      }
    }
  } catch {
    // No docs/: only the changelog, if any.
  }
  return [...found, CHANGELOG_FILE];
}

export function createAriannaDocs(options: { home: string; rules: LabelRules }): AriannaDocs {
  const cache = new Map<string, { mtimeMs: number; size: number; pages: AriannaPage[] }>();

  function list(): AriannaPage[] {
    const pages: AriannaPage[] = [];
    const present = new Set<string>();
    for (const source of ariannaDocuments(options.home)) {
      present.add(source);
      let stat;
      try {
        stat = lstatSync(join(options.home, ...source.split('/')));
      } catch {
        cache.delete(source);
        continue;
      }
      const cached = cache.get(source);
      if (cached !== undefined && stat.isFile() && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        pages.push(...cached.pages);
        continue;
      }
      const document = readDocument(options.home, source);
      if (document === undefined) {
        cache.delete(source);
        continue;
      }
      // At least L2, fixed here; a rule of labels.toml on the document can only raise it.
      const label = maxLabel(ARIANNA_DOCS_LABEL, labelForPath(options.rules, source));
      const read = pagesOf(source, document.text, label, new Date(document.mtimeMs).toISOString());
      cache.set(source, { mtimeMs: document.mtimeMs, size: document.size, pages: read });
      pages.push(...read);
    }
    for (const source of [...cache.keys()]) if (!present.has(source)) cache.delete(source);
    return pages;
  }

  return {
    list,
    load(path) {
      if (!isAriannaPagePath(path)) throw new AriannaDocsError('invalid', `${JSON.stringify(path)} is not a page of Arianna's documents: they look like arianna/decisioni/D-144.md`);
      // Looked up among the pages the documents give: the path never names a file.
      const page = list().find((candidate) => candidate.path === path);
      if (page === undefined) throw new AriannaDocsError('not-found', `page ${path} not found`);
      return page;
    },
  };
}
