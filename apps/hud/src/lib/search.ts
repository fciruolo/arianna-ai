import type { Label } from './types.ts';

/**
 * "Cerca" of the left bar (D-097) over `GET /api/search` (D-089): what the
 * core answers, the rows the window lists and where each one leads. Pure:
 * the window asks and draws, this decides.
 */
export const MIN_QUERY = 2;
export const MAX_QUERY = 200;
/** Results per kind the window asks for. */
export const SEARCH_LIMIT = 8;
/** The wait after the last key before asking the core. */
export const SEARCH_DEBOUNCE_MS = 200;

export interface Highlight {
  start: number;
  length: number;
}

export interface ConversationHit {
  id: string;
  title: string;
  mode: string;
  origin: string;
  label: Label;
  archived: boolean;
  pinned: boolean;
  lastMessageAt: string | null;
}

export interface MessageHit {
  conversationId: string;
  messageId: string;
  title: string | null;
  role: string;
  at: string;
  label: Label;
  archived: boolean;
  snippet: string;
  highlight: Highlight | null;
}

export interface NoteHit {
  name: string;
  path: string;
  title: string | null;
  tags: string[];
  status: string | null;
  capturedAt: string | null;
  label: Label;
  field: string;
  snippet: string;
  highlight: Highlight | null;
}

export interface PageHit {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  label: Label;
  updatedAt: string;
  field: string;
  snippet: string;
  highlight: Highlight | null;
}

export interface SearchResult {
  conversations: ConversationHit[];
  messages: MessageHit[];
  notes: NoteHit[];
  pages: PageHit[];
  hidden: number;
  truncated: boolean;
}

/** Where a row leads: a conversation (and a message in it) or a node of the knowledge graph. */
export type SearchTarget = { conversation: string; message?: string } | { graph: string };

export type SearchKind = 'conversation' | 'message' | 'note' | 'page';

export interface SearchRow {
  key: string;
  kind: SearchKind;
  title: string;
  /** Under the title: the excerpt around the match, or nothing. */
  snippet: string | null;
  highlight: Highlight | null;
  /** A short note on the right: "archiviata", the folder, who wrote. */
  meta: string | null;
  label: Label;
  target: SearchTarget;
}

export interface SearchGroup {
  kind: SearchKind;
  title: string;
  rows: SearchRow[];
}

export const GROUP_TEXT: Record<SearchKind, string> = {
  conversation: 'Conversazioni',
  message: 'Messaggi',
  note: 'Pensieri e note',
  page: 'Pagine della conoscenza',
};

/** The query as the core will take it, or undefined when it is too short or too long to ask. */
export function searchQuery(raw: string): string | undefined {
  const query = raw.trim().replace(/\s+/g, ' ');
  const length = Array.from(query).length;
  return length < MIN_QUERY || length > MAX_QUERY ? undefined : query;
}

/** The excerpt cut in plain and marked parts; a highlight outside the text marks nothing. */
export function highlightParts(snippet: string, highlight: Highlight | null): { text: string; mark: boolean }[] {
  if (highlight === null || highlight.length <= 0 || highlight.start < 0 || highlight.start + highlight.length > snippet.length) {
    return snippet === '' ? [] : [{ text: snippet, mark: false }];
  }
  const end = highlight.start + highlight.length;
  return [
    { text: snippet.slice(0, highlight.start), mark: false },
    { text: snippet.slice(highlight.start, end), mark: true },
    { text: snippet.slice(end), mark: false },
  ].filter((part) => part.text !== '');
}

/** A note of kb/inbox is a node of the graph by its path under kb/ (`kb/inbox/x.md` → `inbox/x.md`). */
export function noteGraphId(note: Pick<NoteHit, 'path' | 'name'>): string {
  return note.path.startsWith('kb/') ? note.path.slice(3) : `inbox/${note.name}`;
}

const ROLE_TEXT: Record<string, string> = { user: 'tu', assistant: 'Arianna', system: 'sistema' };

/** The groups of the window, in a fixed order, empty ones left out. */
export function searchGroups(result: SearchResult): SearchGroup[] {
  const groups: SearchGroup[] = [
    {
      kind: 'conversation',
      title: GROUP_TEXT.conversation,
      rows: result.conversations.map((hit) => ({
        key: `c-${hit.id}`,
        kind: 'conversation',
        title: hit.title,
        snippet: null,
        highlight: null,
        meta: hit.archived ? 'archiviata' : hit.pinned ? 'fissata' : hit.origin === 'system' ? 'di sistema' : hit.mode === 'work' ? 'lavoro' : 'privata',
        label: hit.label,
        target: { conversation: hit.id },
      })),
    },
    {
      kind: 'message',
      title: GROUP_TEXT.message,
      rows: result.messages.map((hit) => ({
        key: `m-${hit.messageId}`,
        kind: 'message',
        title: hit.title ?? 'Nuova conversazione',
        snippet: hit.snippet,
        highlight: hit.highlight,
        meta: [ROLE_TEXT[hit.role] ?? hit.role, hit.archived ? 'archiviata' : null].filter((part) => part !== null).join(' · '),
        label: hit.label,
        target: { conversation: hit.conversationId, message: hit.messageId },
      })),
    },
    {
      kind: 'note',
      title: GROUP_TEXT.note,
      rows: result.notes.map((hit) => ({
        key: `n-${hit.name}`,
        kind: 'note',
        title: hit.title ?? hit.name,
        snippet: hit.snippet,
        highlight: hit.highlight,
        meta: hit.tags.length > 0 ? hit.tags.slice(0, 3).map((tag) => `#${tag}`).join(' ') : null,
        label: hit.label,
        target: { graph: noteGraphId(hit) },
      })),
    },
    {
      kind: 'page',
      title: GROUP_TEXT.page,
      rows: result.pages.map((hit) => ({
        key: `p-${hit.id}`,
        kind: 'page',
        title: hit.title,
        snippet: hit.snippet,
        highlight: hit.highlight,
        meta: hit.folder === '' ? null : hit.folder,
        label: hit.label,
        target: { graph: hit.id },
      })),
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

/** The next row for the arrows, wrapping around; -1 when there is none. */
export function moveSelection(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

/** The note at the foot of the window: what was not searched or not finished, never what it holds. */
export function searchFootnote(result: Pick<SearchResult, 'hidden' | 'truncated'>): string | null {
  const parts: string[] = [];
  if (result.hidden > 0) parts.push(`${String(result.hidden)} ${result.hidden === 1 ? 'elemento sopra L2 non è cercato' : 'elementi sopra L2 non sono cercati'}`);
  if (result.truncated) parts.push('la ricerca si è fermata dopo 2 secondi: potrebbe mancare qualcosa');
  if (parts.length === 0) return null;
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The state of the window. Every change of the text starts a new round
 * (`round`): answers of an older round are dropped, the selection is cleared
 * at once, and Invio opens a row only once the answer of the current round
 * is in, never a row of an older query.
 */
export interface SearchState {
  round: number;
  phase: 'idle' | 'waiting' | 'loading' | 'done' | 'failed';
  /** The last answer; kept while the next query is waited for, gone after an error or an empty text. */
  result: SearchResult | null;
  problem: string | null;
  selected: number;
}

export const IDLE_SEARCH: SearchState = { round: 0, phase: 'idle', result: null, problem: null, selected: -1 };

/** The text changed: a new round, waiting for the pause (or idle when the text cannot be asked). */
export function textChanged(state: SearchState, raw: string): SearchState {
  const round = state.round + 1;
  if (searchQuery(raw) === undefined) return { round, phase: 'idle', result: null, problem: null, selected: -1 };
  return { ...state, round, phase: 'waiting', selected: -1 };
}

/** The request of `round` left. */
export function searchStarted(state: SearchState, round: number): SearchState {
  return round === state.round ? { ...state, phase: 'loading' } : state;
}

/** The answer of `round`: ignored when a later round started. */
export function searchAnswered(state: SearchState, round: number, result: SearchResult): SearchState {
  if (round !== state.round) return state;
  const count = searchGroups(result).reduce((total, group) => total + group.rows.length, 0);
  return { ...state, phase: 'done', result, problem: null, selected: count > 0 ? 0 : -1 };
}

/** The error of `round`: no stale results stay under it. */
export function searchFailed(state: SearchState, round: number, problem: string): SearchState {
  if (round !== state.round) return state;
  return { ...state, phase: 'failed', result: null, problem, selected: -1 };
}

/** The row Invio opens: only with the answer of the current round in. */
export function enterRow(state: SearchState, count: number): number | undefined {
  return state.phase === 'done' && state.selected >= 0 && state.selected < count ? state.selected : undefined;
}

/** What the live region says. */
export function resultsText(state: SearchState, count: number): string {
  if (state.phase === 'waiting' || state.phase === 'loading') return 'Cerco…';
  if (state.phase === 'failed') return 'Ricerca non riuscita';
  if (state.phase !== 'done') return '';
  return count === 0 ? 'Nessun risultato' : count === 1 ? '1 risultato' : `${String(count)} risultati`;
}
