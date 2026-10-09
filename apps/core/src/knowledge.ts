import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { isAtMost, labelForPath, maxLabel, type Label, type LabelRules } from '@arianna/policy';

import { headerFields, NoteError, noteLabel } from './notes.ts';
import { checkPagePath, KB_DIR, KB_PROJECT_NOTES, parsePage } from './orchestrator/kb.ts';

/** kb/progetti as an id relative to kb/ (D-145). */
const PROJECT_NOTES_ID = KB_PROJECT_NOTES.slice(KB_DIR.length + 1);

/**
 * The graph of the knowledge base for the "Conoscenza" page (D-087): every
 * markdown page of kb/ up to L2 as a node, wikilinks and shared tags as
 * edges. Pages above L2 (and those whose label cannot be read) are only
 * counted: never a node, never the end of an edge. The listing holds header
 * fields only; the text of a page is read one at a time, like the notes.
 */
export const MAX_GRAPH_PAGES = 2_000;
export const MAX_GRAPH_PAGE_BYTES = 200_000;
/** A tag on more pages than this gets a node of its own instead of a clique. */
export const TAG_CLIQUE_LIMIT = 12;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;

export type EdgeType = 'link' | 'tag';

export interface GraphNode {
  /** Relative to kb/, e.g. inbox/2026-10-05-pane.md; `tag:<name>` for a tag node. */
  id: string;
  title: string;
  /** First folder under kb/ ('' at the root, '#' for a tag node). */
  folder: string;
  kind: string | null;
  tags: string[];
  label: Label;
  degree: number;
  updatedAt: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Pages left out: above L2, unreadable label, too large. */
  hidden: number;
  /** True when kb/ holds more pages than MAX_GRAPH_PAGES. */
  truncated: boolean;
}

/** What the graph needs of a page, kept between builds while its file does not change. */
export interface PageFacts {
  title: string;
  kind: string | null;
  tags: string[];
  label: Label;
  links: string[];
}

export type GraphCache = Map<string, { mtimeMs: number; size: number; facts: PageFacts | null }>;

/** The tags of a header: a JSON list (as the organizer writes it), a `[a, b]` list or `a, b`. */
export function parseTags(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  let items: unknown[];
  try {
    const parsed: unknown = JSON.parse(value);
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    items = value.replace(/^\[|\]$/g, '').split(',');
  }
  const tags = items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().replace(/^["']|["']$/g, '').replace(/^#/, '').trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag.length <= MAX_TAG_LENGTH && /^[\p{L}\p{N}_/-]+$/u.test(tag));
  return [...new Set(tags)].slice(0, MAX_TAGS);
}

/** The targets of `[[target]]`, `[[target|alias]]`, `[[target#heading]]` and `![[target]]`, in order. */
export function wikilinkTargets(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/\[\[([^[\]\n]{1,300})\]\]/g)) {
    const target = (match[1] ?? '').split('|')[0]?.split('#')[0]?.trim() ?? '';
    if (target !== '') found.push(target);
  }
  return found;
}

/** Lowercase, `.md` added, `kb/` and `./` dropped: the form ids are compared in. */
function linkKey(target: string): string {
  let key = target.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (key.startsWith(`${KB_DIR}/`)) key = key.slice(KB_DIR.length + 1);
  if (!key.toLowerCase().endsWith('.md')) key += '.md';
  return key.toLowerCase();
}

/**
 * The id a wikilink points to among `ids` (the visible pages only): the full
 * path relative to kb/ first, then the file name when only one page has it,
 * as Obsidian does. Undefined when there is none or it is ambiguous.
 */
export function resolveWikilink(target: string, ids: readonly string[]): string | undefined {
  const key = linkKey(target);
  const exact = ids.find((id) => id.toLowerCase() === key);
  if (exact !== undefined) return exact;
  if (key.includes('/')) {
    const suffix = ids.filter((id) => id.toLowerCase().endsWith(`/${key}`));
    return suffix.length === 1 ? suffix[0] : undefined;
  }
  const byName = ids.filter((id) => (id.split('/').at(-1) ?? '').toLowerCase() === key);
  return byName.length === 1 ? byName[0] : undefined;
}

/** kb/ of this home when it is a real folder. */
function kbRoot(home: string): string | undefined {
  const root = join(home, KB_DIR);
  try {
    return lstatSync(root).isDirectory() ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Page ids (relative to kb/) without following links or entering hidden folders; at most `limit` + 1. */
export function listPageIds(root: string, limit = MAX_GRAPH_PAGES): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length > limit) return;
      if (entry.name.startsWith('.')) continue;
      const id = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      // readdir reports links as links: neither branch takes them.
      // kb/progetti is the knowledge of the projects (D-145), read with their own folder labels, never twice.
      if (entry.isDirectory()) {
        if (id.toLowerCase() !== PROJECT_NOTES_ID) walk(join(dir, entry.name), id);
      }
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(id);
    }
  };
  walk(root, '');
  return found;
}

/** The folder of a page when kb/ and every folder down to it are real folders, not links. */
export function pageFolder(home: string, id: string): string | undefined {
  let dir = home;
  for (const segment of [KB_DIR, ...id.split('/').slice(0, -1)]) {
    dir = join(dir, segment);
    try {
      if (!lstatSync(dir).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  return dir;
}

/**
 * The text of a page under kb/: a plain file opened without following a link,
 * every folder on the way a real folder, within MAX_GRAPH_PAGE_BYTES.
 * Undefined for anything else.
 */
function readPageFile(home: string, id: string): { raw: string; mtimeMs: number; size: number } | undefined {
  const segments = id.split('/');
  const dir = pageFolder(home, id);
  if (dir === undefined) return undefined;
  const file = join(dir, segments.at(-1) ?? '');
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_GRAPH_PAGE_BYTES) return undefined;
    if (realpathSync(file) !== join(realpathSync(home), KB_DIR, ...segments)) return undefined;
    return { raw: readFileSync(fd, 'utf8'), mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function factsOf(rules: LabelRules, id: string, raw: string): PageFacts {
  const { header, body } = parsePage(raw);
  const fields = headerFields(raw);
  return {
    title: header.title?.trim() || (id.split('/').at(-1)?.replace(/\.md$/, '') ?? id),
    kind: fields.get('kind')?.trim() || null,
    tags: parseTags(fields.get('tags')),
    label: noteLabel(rules, `${KB_DIR}/${id}`, raw),
    links: wikilinkTargets(body),
  };
}

/** A page id the routes and the walk accept: what checkPagePath takes, relative to kb/. */
function validId(id: string): boolean {
  try {
    return checkPagePath(`${KB_DIR}/${id}`) === `${KB_DIR}/${id}`;
  } catch {
    return false;
  }
}

/** The graph from page facts already filtered to ≤ L2: pure, for the tests. */
export function graphOf(pages: readonly { id: string; facts: PageFacts; updatedAt: string | null }[], hidden: number, truncated = false): KnowledgeGraph {
  const nodes: GraphNode[] = pages.map(({ id, facts, updatedAt }) => ({
    id,
    title: facts.title,
    folder: id.includes('/') ? (id.split('/')[0] ?? '') : '',
    kind: facts.kind,
    tags: facts.tags,
    label: facts.label,
    degree: 0,
    updatedAt,
  }));
  const ids = nodes.map((node) => node.id);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, type: EdgeType): void => {
    if (source === target) return;
    const [a, b] = source < target ? [source, target] : [target, source];
    const key = `${type}\u0000${a}\u0000${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source, target, type });
  };
  for (const { id, facts } of pages) {
    for (const target of facts.links) {
      const resolved = resolveWikilink(target, ids);
      if (resolved !== undefined) add(id, resolved, 'link');
    }
  }
  const byTag = new Map<string, string[]>();
  for (const node of nodes) for (const tag of node.tags) byTag.set(tag, [...(byTag.get(tag) ?? []), node.id]);
  const labelOf = new Map(nodes.map((node) => [node.id, node.label]));
  for (const [tag, members] of [...byTag].sort(([a], [b]) => a.localeCompare(b))) {
    if (members.length < 2) continue;
    if (members.length <= TAG_CLIQUE_LIMIT) {
      for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) add(members[i] ?? '', members[j] ?? '', 'tag');
      continue;
    }
    const tagId = `tag:${tag}`;
    nodes.push({
      id: tagId,
      title: `#${tag}`,
      folder: '#',
      kind: 'tag',
      tags: [],
      // Named by the pages that carry it: as high as the highest of them.
      label: maxLabel(...members.map((member) => labelOf.get(member) ?? 'L2')),
      degree: 0,
      updatedAt: null,
    });
    for (const member of members) add(member, tagId, 'tag');
  }
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  for (const node of nodes) node.degree = degree.get(node.id) ?? 0;
  return { nodes, edges, hidden, truncated };
}

/**
 * The graph of kb/ of this home. `cache` keeps what was read of each page
 * while its mtime and size do not change.
 */
export function buildKnowledgeGraph(home: string, rules: LabelRules, cache?: GraphCache): KnowledgeGraph {
  const root = kbRoot(home);
  if (root === undefined) return { nodes: [], edges: [], hidden: 0, truncated: false };
  const listed = listPageIds(root);
  const truncated = listed.length > MAX_GRAPH_PAGES;
  const pages: { id: string; facts: PageFacts; updatedAt: string | null }[] = [];
  let hidden = 0;
  const present = new Set<string>();
  for (const id of listed.slice(0, MAX_GRAPH_PAGES)) {
    if (!validId(id)) continue;
    present.add(id);
    // Above L2 by its folder: the file is not opened.
    if (!isAtMost(labelForPath(rules, `${KB_DIR}/${id}`), 'L2')) {
      hidden += 1;
      continue;
    }
    let facts: PageFacts | null;
    let mtimeMs: number;
    const cached = cache?.get(id);
    let stat: { mtimeMs: number; size: number } | undefined;
    // A folder on the way swapped for a link since the walk: the page is left out, cached or not.
    const folder = pageFolder(home, id);
    if (folder === undefined) {
      cache?.delete(id);
      continue;
    }
    try {
      const found = lstatSync(join(folder, id.split('/').at(-1) ?? ''));
      stat = found.isFile() ? { mtimeMs: found.mtimeMs, size: found.size } : undefined;
    } catch {
      stat = undefined;
    }
    if (stat === undefined) continue;
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      facts = cached.facts;
      mtimeMs = cached.mtimeMs;
    } else {
      const file = readPageFile(home, id);
      facts = file === undefined ? null : factsOf(rules, id, file.raw);
      mtimeMs = file?.mtimeMs ?? stat.mtimeMs;
      cache?.set(id, { mtimeMs, size: file?.size ?? stat.size, facts });
    }
    // Too large, a link swapped in, or a label above L2 or unreadable (L3).
    if (facts === null || !isAtMost(facts.label, 'L2')) {
      hidden += 1;
      continue;
    }
    pages.push({ id, facts, updatedAt: new Date(mtimeMs).toISOString() });
  }
  if (cache !== undefined) for (const id of [...cache.keys()]) if (!present.has(id)) cache.delete(id);
  return graphOf(pages, hidden, truncated);
}

/** A page of kb/ up to L2 as the search reads it (D-089). */
export interface VisiblePage {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  label: Label;
  updatedAt: string;
  body: string;
}

/**
 * Visits the pages of kb/ up to L2 with their text, in the order of the walk,
 * read as readKnowledgePage reads them. Pages above L2 (by folder, without
 * opening them, or by their header), unreadable or too large are counted in
 * `hidden`; `skip` leaves pages out before anything is read or counted.
 * `visit` returns false to stop.
 */
export function eachKbPage(
  home: string,
  rules: LabelRules,
  visit: (page: VisiblePage) => boolean,
  skip: (id: string) => boolean = () => false,
): { hidden: number; truncated: boolean } {
  const root = kbRoot(home);
  if (root === undefined) return { hidden: 0, truncated: false };
  const listed = listPageIds(root);
  let hidden = 0;
  for (const id of listed.slice(0, MAX_GRAPH_PAGES)) {
    if (!validId(id) || skip(id)) continue;
    if (!isAtMost(labelForPath(rules, `${KB_DIR}/${id}`), 'L2')) {
      hidden += 1;
      continue;
    }
    const file = readPageFile(home, id);
    const facts = file === undefined ? undefined : factsOf(rules, id, file.raw);
    if (file === undefined || facts === undefined || !isAtMost(facts.label, 'L2')) {
      hidden += 1;
      continue;
    }
    const page: VisiblePage = {
      id,
      title: facts.title,
      folder: id.includes('/') ? (id.split('/')[0] ?? '') : '',
      tags: facts.tags,
      label: facts.label,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      body: parsePage(file.raw).body,
    };
    if (!visit(page)) return { hidden, truncated: false };
  }
  return { hidden, truncated: listed.length > MAX_GRAPH_PAGES };
}

export interface KnowledgePage {
  id: string;
  title: string;
  folder: string;
  kind: string | null;
  tags: string[];
  label: Label;
  updatedAt: string;
  body: string;
}

/**
 * One page of kb/ with its text, only up to L2. Anything else (outside kb/,
 * a link, hidden, too large, above L2, missing) answers the same 404.
 */
export function readKnowledgePage(home: string, rules: LabelRules, id: string): KnowledgePage {
  const refuse = () => new NoteError('not-found', 'page not found');
  if (typeof id !== 'string' || id.length > 300 || !validId(id)) throw refuse();
  // The folder label first: above it the file is not touched, existing or not.
  if (!isAtMost(labelForPath(rules, `${KB_DIR}/${id}`), 'L2')) throw refuse();
  if (kbRoot(home) === undefined) throw refuse();
  const file = readPageFile(home, id);
  if (file === undefined) throw refuse();
  const facts = factsOf(rules, id, file.raw);
  if (!isAtMost(facts.label, 'L2')) throw refuse();
  return {
    id,
    title: facts.title,
    folder: id.includes('/') ? (id.split('/')[0] ?? '') : '',
    kind: facts.kind,
    tags: facts.tags,
    label: facts.label,
    updatedAt: new Date(file.mtimeMs).toISOString(),
    body: parsePage(file.raw).body,
  };
}
