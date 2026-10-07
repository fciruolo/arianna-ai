import { isAtMost, type Label, type LabelRules } from '@arianna/policy';

import type { Queryable, Sql } from './db/client.ts';
import { eachKbPage } from './knowledge.ts';
import { eachInboxNote, noteSummary } from './notes.ts';
import { KB_INBOX, parsePage } from './orchestrator/kb.ts';

/**
 * "Cerca" of the web chat (D-089): one query over conversation titles, the
 * texts of the messages, the notes of kb/inbox and the pages of kb/. Plain
 * and deterministic: a substring, case and the common accents folded, no
 * ranking. It shows what the private chat shows, up to L2: anything above is
 * never matched and only counted in `hidden`, a total that does not depend on
 * the query (every item above L2 in what was searched), so it tells nothing
 * of their content. The query is never logged nor written anywhere.
 */
export const MIN_QUERY = 2;
export const MAX_QUERY = 200;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SNIPPET = 160;
/** Budget of the file part (notes and pages) and of each database statement. */
export const SEARCH_BUDGET_MS = 2_000;

// The same table in JavaScript and in SQL (translate), so both sides fold alike.
const ACCENTED = 'àáâãäåāèéêëēìíîïīòóôõöōùúûüūýÿçñ';
const PLAIN = 'aaaaaaaeeeeeiiiiioooooouuuuuyycn';
const FOLD = new Map(Array.from(ACCENTED).map((char, index) => [char, PLAIN[index] ?? char]));

export type SearchErrorCode = 'invalid';

/** Messages name fixed reasons, never the query. */
export class SearchError extends Error {
  override name = 'SearchError';
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Lowercase, accents of FOLD dropped, one UTF-16 unit for one: the index of a
 * match in the folded text is its index in the original.
 */
export function foldText(text: string): string {
  let out = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    const same = lower.length === char.length ? lower : char;
    const folded = FOLD.get(same) ?? same;
    out += folded.length === char.length ? folded : same;
  }
  return out;
}

/** The query trimmed, folded and checked: 2-200 characters, one line. */
export function checkQuery(raw: unknown): string {
  if (typeof raw !== 'string') throw new SearchError('invalid', 'q is required');
  const query = raw.trim().replace(/\s+/g, ' ');
  const length = Array.from(query).length;
  if (length < MIN_QUERY) throw new SearchError('invalid', `q must be at least ${String(MIN_QUERY)} characters`);
  if (length > MAX_QUERY) throw new SearchError('invalid', `q must be at most ${String(MAX_QUERY)} characters`);
  if (/\p{Cc}/u.test(query)) throw new SearchError('invalid', 'q holds a control character');
  return foldText(query);
}

/** A LIKE pattern matching `folded` anywhere, with `\`, `%` and `_` taken literally. */
export function likePattern(folded: string): string {
  return `%${folded.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export interface Snippet {
  /** At most MAX_SNIPPET characters, white space collapsed, `…` where the text was cut. */
  snippet: string;
  /** Where the query is in `snippet` (UTF-16 units), for highlighting; null when not found there. */
  highlight: { start: number; length: number } | null;
}

/** Up to MAX_SNIPPET characters of `text` around the first match of `folded`; the start of the text when there is none. */
export function snippetAround(text: string, folded: string): Snippet {
  const at = foldText(text).indexOf(folded);
  const room = MAX_SNIPPET - 2;
  let start = at < 0 ? 0 : Math.max(0, at - Math.floor((room - folded.length) / 3));
  let end = Math.min(text.length, start + room);
  start = Math.max(0, Math.min(start, end - room));
  // Never half of a surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '')) start += 1;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end -= 1;
  const middle = text.slice(start, end).replace(/\s+/g, ' ');
  const snippet = `${start > 0 ? '…' : ''}${start > 0 ? middle.trimStart() : middle}${end < text.length ? '…' : ''}`.trim();
  const found = foldText(snippet).indexOf(folded);
  return { snippet, highlight: found < 0 ? null : { start: found, length: folded.length } };
}

export interface ConversationHit {
  id: string;
  title: string;
  mode: string;
  origin: string;
  /** The clearance of the conversation: the label its title carries. */
  label: Label;
  archived: boolean;
  pinned: boolean;
  lastMessageAt: Date | null;
}

export interface MessageHit extends Snippet {
  conversationId: string;
  messageId: string;
  /** The title of the conversation; null for one without a title yet. */
  title: string | null;
  role: string;
  at: Date;
  label: Label;
  archived: boolean;
}

export type MatchedField = 'title' | 'tags' | 'body';

export interface NoteHit extends Snippet {
  name: string;
  path: string;
  title: string | null;
  tags: string[];
  status: string | null;
  capturedAt: string | null;
  label: Label;
  field: MatchedField;
}

export interface PageHit extends Snippet {
  /** Relative to kb/, as GET /api/knowledge/page takes it. */
  id: string;
  title: string;
  folder: string;
  tags: string[];
  label: Label;
  updatedAt: string;
  field: MatchedField;
}

export interface SearchResult {
  conversations: ConversationHit[];
  messages: MessageHit[];
  notes: NoteHit[];
  pages: PageHit[];
  /**
   * Items above L2 in what was searched (messages, notes, pages): never
   * matched, never named. With `truncated` it is partial: a part that ran out
   * of time adds nothing (the database) or only what it reached (the files),
   * so it may then be lower than the total; it still never counts matches.
   */
  hidden: number;
  /** True when a part ran out of time: the result may miss something. */
  truncated: boolean;
}

export interface SearchOptions {
  /** Per kind. */
  limit: number;
  /** The home whose kb/ is searched, with its folder rules; without it only the database. */
  kb?: { home: string; rules: LabelRules };
  budgetMs?: number;
  now?: () => number;
}

const TIMEOUT = '57014';

/** `work` with a statement timeout; undefined when it ran out of time. */
async function bounded<T>(sql: Sql, budgetMs: number, work: (tx: Queryable) => Promise<T>): Promise<T | undefined> {
  try {
    let result: T | undefined;
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${String(Math.max(1, Math.floor(budgetMs)))}`);
      result = await work(tx);
    });
    return result;
  } catch (error) {
    if ((error as { code?: unknown }).code === TIMEOUT) return undefined;
    throw error;
  }
}

function fieldMatch(folded: string, title: string | null, tags: readonly string[], body: string): MatchedField | undefined {
  if (title !== null && foldText(title).includes(folded)) return 'title';
  if (tags.some((tag) => foldText(tag).includes(folded))) return 'tags';
  if (foldText(body).includes(folded)) return 'body';
  return undefined;
}

function snippetFor(field: MatchedField, folded: string, title: string | null, tags: readonly string[], body: string): Snippet {
  if (field === 'body') return snippetAround(body, folded);
  if (field === 'tags') return snippetAround(tags.map((tag) => `#${tag}`).join(' '), folded);
  return snippetAround(body.trim() === '' ? (title ?? '') : body, folded);
}

export async function searchAll(sql: Sql, rawQuery: unknown, options: SearchOptions): Promise<SearchResult> {
  const folded = checkQuery(rawQuery);
  const limit = options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) throw new SearchError('invalid', `limit must be 1-${String(MAX_SEARCH_LIMIT)}`);
  const budget = options.budgetMs ?? SEARCH_BUDGET_MS;
  const now = options.now ?? Date.now;
  const pattern = likePattern(folded);
  let truncated = false;
  let hidden = 0;

  const conversations =
    (await bounded(sql, budget, (tx) =>
      // No clearance filter: a title carries the clearance of its conversation, L1 or L2 by schema (0004).
      tx.unsafe<ConversationHit[]>(
        `SELECT c.id::text, c.title, c.mode, c.origin, c.clearance AS label,
           c.archived_at IS NOT NULL AS archived, c.pinned_at IS NOT NULL AS pinned,
           (SELECT max(m.ts) FROM messages m WHERE m.conversation_id = c.id) AS "lastMessageAt"
         FROM conversations c
         WHERE c.purged_at IS NULL AND NOT c.incognito AND c.title IS NOT NULL
           AND translate(lower(c.title), $2, $3) LIKE $1 ESCAPE '\\'
         ORDER BY c.archived_at IS NOT NULL, c.pinned_at DESC NULLS LAST, c.created_at DESC
         LIMIT $4`,
        [pattern, ACCENTED, PLAIN, limit],
      ),
    ));
  if (conversations === undefined) truncated = true;

  // The bodies above L2 are excluded before matching; their number alone, whatever the query, goes to `hidden`.
  const messages = await bounded(sql, budget, async (tx) => {
    const rows = await tx.unsafe<(Omit<MessageHit, 'snippet' | 'highlight'> & { body: string })[]>(
      `SELECT m.id::text AS "messageId", m.conversation_id::text AS "conversationId", c.title, m.role, m.ts AS at,
         m.label, c.archived_at IS NOT NULL AS archived, m.body
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.purged_at IS NULL AND NOT c.incognito AND m.label <= 'L2'
         AND translate(lower(m.body), $2, $3) LIKE $1 ESCAPE '\\'
       ORDER BY m.id DESC
       LIMIT $4`,
      [pattern, ACCENTED, PLAIN, limit],
    );
    const [above] = await tx<{ count: string }[]>`
      SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.purged_at IS NULL AND NOT c.incognito AND m.label > 'L2'`;
    hidden += Number(above?.count ?? 0);
    return rows.map(({ body, ...row }) => ({ ...row, ...snippetAround(body, folded) }));
  });
  if (messages === undefined) truncated = true;

  const notes: NoteHit[] = [];
  const pages: PageHit[] = [];
  if (options.kb !== undefined) {
    const { home, rules } = options.kb;
    const deadline = now() + budget;
    let noteHidden = 0;
    const { aboveByFolder } = eachInboxNote(home, rules, (path, raw) => {
      if (now() > deadline) {
        truncated = true;
        return false;
      }
      const summary = noteSummary(rules, path, raw);
      if (!isAtMost(summary.label, 'L2')) {
        noteHidden += 1;
        return true;
      }
      // Every note is looked at, also past the limit: `hidden` must not depend on the query.
      if (notes.length >= limit) return true;
      const body = parsePage(raw).body;
      const field = fieldMatch(folded, summary.title, summary.tags, body);
      if (field === undefined) return true;
      notes.push({
        name: summary.name,
        path: summary.path,
        title: summary.title,
        tags: summary.tags,
        status: summary.status,
        capturedAt: summary.capturedAt,
        label: summary.label,
        field,
        ...snippetFor(field, folded, summary.title, summary.tags, body),
      });
      return true;
    });
    hidden += noteHidden + aboveByFolder;

    // The notes of kb/inbox are searched above, as notes.
    const inbox = `${KB_INBOX.split('/').slice(1).join('/')}/`;
    const kb = eachKbPage(
      home,
      rules,
      (page) => {
        if (now() > deadline) {
          truncated = true;
          return false;
        }
        if (pages.length >= limit) return true;
        const field = fieldMatch(folded, page.title, page.tags, page.body);
        if (field === undefined) return true;
        pages.push({
          id: page.id,
          title: page.title,
          folder: page.folder,
          tags: page.tags,
          label: page.label,
          updatedAt: page.updatedAt,
          field,
          ...snippetFor(field, folded, page.title, page.tags, page.body),
        });
        return true;
      },
      (id) => id.startsWith(inbox),
    );
    hidden += kb.hidden;
    if (kb.truncated) truncated = true;
  }

  return {
    conversations: [...(conversations ?? [])],
    messages: messages ?? [],
    notes,
    pages,
    hidden,
    truncated,
  };
}
