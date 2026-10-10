import { ApiError } from './api.ts';
import { dayLabel } from './commitments.ts';
import { agentTitle, errorText, relativeTimeText } from './italian.ts';
import { CHOICE_TEXT, EXCLUDED_TEXT, EXCLUDED_WORK_TEXT } from './labels.ts';
import type { ExecutorChoice, Label, TaskStatus } from './types.ts';

/**
 * The page "Cardwall" (I-13 tappa C2, D-152): the cards (tasks without a
 * conversation) and the commitments of the secretary in columns or in a list.
 * Pure helpers: the types of `GET /api/cards` and `GET /api/cards/:id`, the
 * columns the user sees (five by default, two more on request, any hidden),
 * the moves the core allows by hand, the filters and the order, the user's
 * choices in this browser and the Italian words.
 */

export const CARDWALL_PATH = '/cardwall';

export function isCardwallPath(pathname: string): boolean {
  return pathname === CARDWALL_PATH || pathname === `${CARDWALL_PATH}/`;
}

/** The precise column of a card, as the core gives it. */
export type CardColumn = 'inbox' | 'ready' | 'running' | 'waiting' | 'to_verify' | 'done' | 'failed';
export type CommitmentStatus = 'open' | 'done' | 'not_done' | 'postponed' | 'cancelled';

export interface CardRef {
  id: string;
  title: string;
  status: TaskStatus;
}

export interface Card {
  kind: 'task' | 'commitment';
  id: string;
  title: string;
  column: CardColumn;
  status: TaskStatus | CommitmentStatus;
  project: string | null;
  /** 'user' or an agent. */
  assignee: string;
  /** "YYYY-MM-DD". */
  due: string | null;
  /** "HH:MM", commitments only. */
  time: string | null;
  late: boolean;
  label: Label;
  waitingReason: string | null;
  note: string | null;
  reason: string | null;
  blockedBy: CardRef[];
  dependsOn: CardRef[];
  /** 0 none, 1 Bassa, 2 Media, 3 Alta, 4 Altissima. */
  priority: number;
  /** "YYYY-MM-DD", "Data esecuzione". */
  planned: string | null;
  /** The engine has had it: it keeps who does it and does not go back to Da fare by hand. */
  started: boolean;
  hasBody: boolean;
  links: number;
  files: number;
  checklist: { done: number; total: number };
  updatedAt: string;
}

export interface CardWall {
  today: string;
  cards: Card[];
  projects: string[];
  agents: string[];
}

// The card in full (`GET /api/cards/:id`), tasks only.
export interface CardLink {
  id: string;
  url: string;
  title: string | null;
  createdAt: string;
}

export interface ChecklistItem {
  id: string;
  body: string;
  done: boolean;
}

export interface CardFile {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  label: Label;
  createdAt: string;
}

export interface HistoryEntry {
  at: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface CardDetailData {
  id: string;
  title: string;
  goal: string | null;
  criteria: string | null;
  links: CardLink[];
  checklist: ChecklistItem[];
  files: CardFile[];
  history: HistoryEntry[];
  /** What the agent reported (D-159): its last delegation that ended well, or its last answer on the local model. */
  report: CardReport | null;
  /** Where the user chose the card runs, the last time it was asked (D-159). */
  executor: string | null;
}

export interface CardReport {
  text: string;
  label: Label;
  executor: string | null;
  model: string | null;
  /** Paths in the project the agent changed. */
  files: string[];
  at: string;
}

/** The longest texts the core takes (cardwall.ts, card-details.ts). */
export const MAX_TITLE = 200;
export const MAX_GOAL = 10_000;
export const MAX_CRITERIA = 2_000;
export const MAX_ITEM = 300;
/** Largest attached file: 20 MB, checked here too before sending it. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Where a drop or a button sends a task: the body of `POST /api/cards/:id/move`. */
export type MoveTarget = 'ready' | 'waiting_user' | 'done' | 'failed';

/** The columns the user sees. "Inbox" and "Falliti" exist only when split. */
export type WallColumnId = 'inbox' | 'todo' | 'running' | 'waiting' | 'failed' | 'to_verify' | 'done';
export const WALL_COLUMN_IDS: readonly WallColumnId[] = ['inbox', 'todo', 'running', 'waiting', 'failed', 'to_verify', 'done'];

export interface WallColumn {
  id: WallColumnId;
  title: string;
  /** The precise columns of the cards it holds. */
  holds: CardColumn[];
  /** Where a card dropped here goes; null: no drop. */
  drop: MoveTarget | null;
}

export interface WallPrefs {
  /** "Inbox a parte": Inbox apart from Da fare. */
  splitInbox: boolean;
  /** "Falliti a parte": Falliti apart from Aspetta. */
  splitFailed: boolean;
  hidden: WallColumnId[];
}

/** The columns in order, split as the user chose; the hidden ones included (the page lists them to show them again). */
export function wallColumns(prefs: Pick<WallPrefs, 'splitInbox' | 'splitFailed'>): WallColumn[] {
  const columns: WallColumn[] = [];
  // A card enters the inbox only at birth: nothing is dropped there.
  if (prefs.splitInbox) columns.push({ id: 'inbox', title: 'Inbox', holds: ['inbox'], drop: null });
  columns.push({ id: 'todo', title: 'Da fare', holds: prefs.splitInbox ? ['ready'] : ['inbox', 'ready'], drop: 'ready' });
  columns.push({ id: 'running', title: 'In corso', holds: ['running'], drop: null });
  columns.push({ id: 'waiting', title: 'Aspetta', holds: prefs.splitFailed ? ['waiting'] : ['waiting', 'failed'], drop: 'waiting_user' });
  if (prefs.splitFailed) columns.push({ id: 'failed', title: 'Falliti', holds: ['failed'], drop: 'failed' });
  columns.push({ id: 'to_verify', title: 'Da verificare', holds: ['to_verify'], drop: null });
  columns.push({ id: 'done', title: 'Fatto', holds: ['done'], drop: 'done' });
  return columns;
}

/** The name of the column of a task's status, as the wall says it (the dependencies, the history). */
export const STATUS_COLUMN_TEXT: Record<TaskStatus, string> = {
  inbox: 'Da fare',
  ready: 'Da fare',
  running: 'In corso',
  waiting_user: 'Aspetta',
  to_verify: 'Da verificare',
  done: 'Fatto',
  failed: 'Falliti',
};

const COLUMN_TEXT: Record<CardColumn, string> = {
  inbox: 'Inbox',
  ready: 'Da fare',
  running: 'In corso',
  waiting: 'Aspetta',
  to_verify: 'Da verificare',
  done: 'Fatto',
  failed: 'Falliti',
};

export const COMMITMENT_STATUS_TEXT: Record<CommitmentStatus, string> = {
  open: 'Aperto',
  done: 'Fatto',
  not_done: 'Non fatto',
  postponed: 'Rinviato',
  cancelled: 'Annullato',
};

/** "Stato" of a card: the name of its column; a closed commitment says how it closed. */
export function stateText(card: Pick<Card, 'kind' | 'column' | 'status'>): string {
  if (card.kind === 'commitment') return card.status === 'open' ? 'Da fare' : COMMITMENT_STATUS_TEXT[card.status as CommitmentStatus];
  return COLUMN_TEXT[card.column];
}

// Priority.
export const PRIORITY_TEXT: readonly string[] = ['Nessuna', 'Bassa', 'Media', 'Alta', 'Altissima'];
/** Soft colours from the tokens; 0 has no chip. */
export const PRIORITY_CLASS: readonly string[] = ['', 'text-muted border-line-strong', 'text-info border-info/40', 'text-warn border-warn/40', 'text-danger border-danger/40'];

export function priorityText(priority: number): string | undefined {
  return priority >= 1 && priority <= 4 ? PRIORITY_TEXT[priority] : undefined;
}

// The moves the user makes by hand: the same rules as `userMovesInto` and `moveCard` of the core.
const MOVES_FROM: Record<MoveTarget, readonly TaskStatus[]> = {
  ready: ['inbox', 'waiting_user', 'failed'],
  waiting_user: ['inbox', 'ready'],
  done: ['inbox', 'ready', 'waiting_user', 'to_verify'],
  failed: ['inbox', 'ready', 'waiting_user', 'to_verify'],
};

export const AGENT_DONE_TEXT = 'La card di un agente si chiude da «Da verificare», con le sue prove.';
export const RUNNING_TEXT = 'La card è al lavoro: la sposta il motore, non si trascina.';
export const NOT_BY_HAND_TEXT = 'Questo spostamento non si fa a mano.';

type Movable = Pick<Card, 'kind' | 'status' | 'assignee' | 'started'>;

/** Why the core would refuse to move `card` to `to`; undefined: it allows it. */
export function moveRefusal(card: Movable, to: MoveTarget): string | undefined {
  if (card.kind !== 'task') return NOT_BY_HAND_TEXT;
  const status = card.status as TaskStatus;
  if (status === 'running') return RUNNING_TEXT;
  if (!MOVES_FROM[to].includes(status)) return NOT_BY_HAND_TEXT;
  if (to === 'done' && card.assignee !== 'user' && status !== 'to_verify') return AGENT_DONE_TEXT;
  // A card the engine stopped goes back to do as "Riprendi" or "Riprova" (D-159): the core does it.
  return undefined;
}

/** The buttons of the detail that set a card going (D-159). */
export type CardAction = 'start' | 'resume' | 'retry';

export const CARD_ACTION_TEXT: Record<CardAction, string> = { start: 'Avvia', resume: 'Riprendi', retry: 'Riprova' };

type Actionable = Pick<Card, 'kind' | 'status' | 'assignee' | 'started'> & { waitingApprovalId?: string | null };

/**
 * What the detail offers to set a card going, as the core allows it (D-159):
 * "Avvia" for an agent's card the engine never had, still to do; "Riprendi"
 * for one it had, waiting in Aspetta and not for a decision; "Riprova" for
 * one it had that failed. None for a commitment or a card of the user's.
 */
export function cardActions(card: Actionable, waitsForDecision: boolean): CardAction[] {
  if (card.kind !== 'task') return [];
  const status = card.status as TaskStatus;
  if (!card.started) return card.assignee !== 'user' && (status === 'inbox' || status === 'ready') ? ['start'] : [];
  if (status === 'waiting_user' && !waitsForDecision) return ['resume'];
  if (status === 'failed') return ['retry'];
  return [];
}

/** Who does a card stays once the engine had it, once done, or while it is at work. */
export function assigneeLocked(card: Pick<Card, 'kind' | 'status' | 'started'>): boolean {
  return card.kind !== 'task' || card.started || card.status === 'done' || card.status === 'running';
}

/** Closed columns read newest first; the others by due day (late first), the cards without one last. */
function compareCards(closed: boolean): (a: Card, b: Card) => number {
  return (a, b) => {
    if (closed) return b.updatedAt.localeCompare(a.updatedAt);
    if (a.late !== b.late) return a.late ? -1 : 1;
    if (a.due !== b.due) return a.due === null ? 1 : b.due === null ? -1 : a.due.localeCompare(b.due);
    if (a.time !== b.time) return a.time === null ? 1 : b.time === null ? -1 : a.time.localeCompare(b.time);
    return 0;
  };
}

// The order: the menu on top (board and list) and the headers of the list.
export type SortKey = 'due' | 'priority' | 'planned' | 'recent' | 'title' | 'project' | 'status' | 'assignee' | 'files';
export const SORT_KEYS: readonly SortKey[] = ['due', 'priority', 'planned', 'recent', 'title', 'project', 'status', 'assignee', 'files'];

export interface CardSort {
  key: SortKey;
  desc: boolean;
}

export const DEFAULT_SORT: CardSort = { key: 'due', desc: false };

/** The direction a key starts with: the most important, the newest, the most files first. */
export function startsDescending(key: SortKey): boolean {
  return key === 'priority' || key === 'recent' || key === 'files';
}

const COLUMN_ORDER: readonly CardColumn[] = ['inbox', 'ready', 'running', 'waiting', 'to_verify', 'done', 'failed'];

function sortValue(card: Card, key: SortKey): string | number | null {
  switch (key) {
    case 'due':
      return card.due === null ? null : `${card.due} ${card.time ?? '99:99'}`;
    case 'priority':
      return card.priority === 0 ? null : card.priority;
    case 'planned':
      return card.planned;
    case 'recent':
      return card.updatedAt;
    case 'title':
      return card.title.toLocaleLowerCase('it');
    case 'project':
      return card.project === null ? null : card.project.toLocaleLowerCase('it');
    case 'status':
      return COLUMN_ORDER.indexOf(card.column);
    case 'assignee':
      return card.assignee === 'user' ? '' : card.assignee.toLocaleLowerCase('it');
    case 'files':
      return card.files;
  }
}

/** A comparison by one key; the cards without a value go last whatever the direction. */
export function compareBy(sort: CardSort): (a: Card, b: Card) => number {
  return (a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'it');
    return sort.desc ? -order : order;
  };
}

/** The list view: every card in one order. */
export function sortCards(cards: readonly Card[], sort: CardSort): Card[] {
  return [...cards].sort(compareBy(sort));
}

/** The cards of each column, in its order. A card whose column is not shown is in none. */
export function groupCards(cards: readonly Card[], columns: readonly WallColumn[], sort: CardSort = DEFAULT_SORT): Map<WallColumnId, Card[]> {
  const groups = new Map<WallColumnId, Card[]>();
  const byDue = sort.key === 'due' && !sort.desc;
  for (const column of columns) {
    const items = cards.filter((card) => column.holds.includes(card.column));
    groups.set(column.id, items.sort(byDue ? compareCards(column.id === 'done' || column.id === 'failed') : compareBy(sort)));
  }
  return groups;
}

/** What a drop of `card` on `column` does. */
export type DropAction = { kind: 'none' } | { kind: 'noop' } | { kind: 'move'; to: MoveTarget } | { kind: 'commitment-done' } | { kind: 'refuse'; message: string };

export const COMMITMENT_MOVE_TEXT = 'Un impegno si chiude solo con «Fatto»: per rinviarlo o dire perché non è fatto, scrivilo alla Segretaria.';

export function dropAction(card: Pick<Card, 'kind' | 'status' | 'column' | 'assignee' | 'started'>, column: Pick<WallColumn, 'drop' | 'holds'>): DropAction {
  const to = column.drop;
  if (to === null) return { kind: 'none' };
  if (column.holds.includes(card.column)) return { kind: 'noop' };
  if (card.kind === 'commitment') {
    if (to !== 'done') return { kind: 'refuse', message: COMMITMENT_MOVE_TEXT };
    return card.status === 'open' ? { kind: 'commitment-done' } : { kind: 'noop' };
  }
  if (card.status === to) return { kind: 'noop' };
  const refusal = moveRefusal(card, to);
  return refusal === undefined ? { kind: 'move', to } : { kind: 'refuse', message: refusal };
}

/**
 * The moves the detail of a task offers as buttons: only those the core
 * allows. "Da fare" for a card in the inbox only when Inbox is its own column
 * (otherwise it is already in Da fare).
 */
export function moveButtons(card: Movable, splitInbox = false): { to: MoveTarget; text: string }[] {
  if (card.kind !== 'task') return [];
  const all: { to: MoveTarget; text: string }[] = [
    { to: 'ready', text: 'Da fare' },
    { to: 'waiting_user', text: 'Aspetta' },
    { to: 'done', text: 'Fatto' },
    { to: 'failed', text: 'Fallito' },
  ];
  // A card the engine stopped goes back to do with "Riprendi" or "Riprova" (cardActions), not with a second button.
  const restarts = card.started && (card.status === 'waiting_user' || card.status === 'failed');
  return all.filter(
    ({ to }) => card.status !== to && !(to === 'ready' && ((card.status === 'inbox' && !splitInbox) || restarts)) && moveRefusal(card, to) === undefined,
  );
}

// Filters (the bar on top). Projects and agents carry a prefix so no name can be taken for "all".
export type DueFilter = 'all' | 'today' | 'week' | 'late' | 'none';
export type PriorityFilter = 'all' | '0' | '1' | '2' | '3' | '4';

export interface CardFilters {
  /** 'all', 'general' (no project) or `p:<name>`. */
  project: string;
  kind: 'all' | 'task' | 'commitment';
  /** 'all', 'user' or `a:<agent>`. */
  assignee: string;
  due: DueFilter;
  label: 'all' | Label;
  /** '0': no priority. */
  priority: PriorityFilter;
}

export const ALL_FILTERS: CardFilters = { project: 'all', kind: 'all', assignee: 'all', due: 'all', label: 'all', priority: 'all' };

function utc(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

/** Monday and Sunday ("YYYY-MM-DD") of the week of `today`. */
export function weekOf(today: string): { from: string; to: string } {
  const at = utc(today);
  const back = (at.getUTCDay() + 6) % 7;
  const monday = new Date(at.getTime() - back * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

export function matches(card: Card, filters: CardFilters, today: string): boolean {
  if (filters.project === 'general' && card.project !== null) return false;
  if (filters.project.startsWith('p:') && card.project !== filters.project.slice(2)) return false;
  if (filters.kind !== 'all' && card.kind !== filters.kind) return false;
  if (filters.assignee === 'user' && card.assignee !== 'user') return false;
  if (filters.assignee.startsWith('a:') && card.assignee !== filters.assignee.slice(2)) return false;
  if (filters.label !== 'all' && card.label !== filters.label) return false;
  if (filters.priority !== 'all' && card.priority !== Number(filters.priority)) return false;
  switch (filters.due) {
    case 'today':
      return card.due === today;
    case 'week': {
      const week = weekOf(today);
      return card.due !== null && card.due >= week.from && card.due <= week.to;
    }
    case 'late':
      return card.late;
    case 'none':
      return card.due === null;
    default:
      return true;
  }
}

export function filtersActive(filters: CardFilters): boolean {
  return (Object.keys(ALL_FILTERS) as (keyof CardFilters)[]).some((key) => filters[key] !== ALL_FILTERS[key]);
}

// The user's choices, a convenience of this browser (localStorage): anything unexpected reads as the default.
const KEY = 'arianna.cardwall';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type WallView = 'board' | 'list';

export interface WallState {
  prefs: WallPrefs;
  filters: CardFilters;
  view: WallView;
  sort: CardSort;
}

export function defaultState(): WallState {
  return { prefs: { splitInbox: false, splitFailed: false, hidden: [] }, filters: { ...ALL_FILTERS }, view: 'board', sort: { ...DEFAULT_SORT } };
}

const DUES: readonly DueFilter[] = ['all', 'today', 'week', 'late', 'none'];
const LABELS: readonly CardFilters['label'][] = ['all', 'L0', 'L1', 'L2', 'L3'];
const PRIORITIES: readonly PriorityFilter[] = ['all', '0', '1', '2', '3', '4'];

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length <= 120 ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
}

export function loadState(storage: StorageLike | undefined): WallState {
  const state = defaultState();
  try {
    const raw = storage?.getItem(KEY);
    if (raw === null || raw === undefined) return state;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return state;
    const saved = value as Record<string, unknown>;
    const prefs = record(saved.prefs);
    const filters = record(saved.filters);
    const sort = record(saved.sort);
    state.prefs.splitInbox = prefs.splitInbox === true;
    state.prefs.splitFailed = prefs.splitFailed === true;
    state.prefs.hidden = Array.isArray(prefs.hidden) ? WALL_COLUMN_IDS.filter((id) => (prefs.hidden as unknown[]).includes(id)) : [];
    const project = text(filters.project, 'all');
    state.filters.project = project === 'all' || project === 'general' || project.startsWith('p:') ? project : 'all';
    state.filters.kind = filters.kind === 'task' || filters.kind === 'commitment' ? filters.kind : 'all';
    const assignee = text(filters.assignee, 'all');
    state.filters.assignee = assignee === 'all' || assignee === 'user' || assignee.startsWith('a:') ? assignee : 'all';
    state.filters.due = DUES.find((due) => due === filters.due) ?? 'all';
    state.filters.label = LABELS.find((label) => label === filters.label) ?? 'all';
    state.filters.priority = PRIORITIES.find((priority) => priority === filters.priority) ?? 'all';
    state.view = saved.view === 'list' ? 'list' : 'board';
    const key = SORT_KEYS.find((item) => item === sort.key);
    state.sort = key === undefined ? { ...DEFAULT_SORT } : { key, desc: sort.desc === true };
    return state;
  } catch {
    return defaultState();
  }
}

export function saveState(storage: StorageLike | undefined, state: WallState): void {
  try {
    storage?.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private window or blocked storage: the choice lasts until the page closes.
  }
}

// What a card says.

/** "aspetta: <title>", "+N" for the others; undefined when it waits for no card. */
export function blockedText(card: Pick<Card, 'column' | 'blockedBy'>): string | undefined {
  const [first, ...rest] = card.blockedBy;
  if (card.column !== 'waiting' || first === undefined) return undefined;
  return rest.length === 0 ? `aspetta: ${first.title}` : `aspetta: ${first.title} +${String(rest.length)}`;
}

/** The due day as the user reads it, with the time of a commitment. */
export function dueText(card: Pick<Card, 'due' | 'time'>, today: string): string | undefined {
  if (card.due === null) return undefined;
  const day = dayLabel(card.due, today);
  return card.time === null ? day : `${day}, ${card.time}`;
}

/** "Data esecuzione" as the user reads it. */
export function plannedText(card: Pick<Card, 'planned'>, today: string): string | undefined {
  return card.planned === null ? undefined : dayLabel(card.planned, today);
}

export function assigneeText(assignee: string, name: (agent: string) => string): string {
  return assignee === 'user' ? 'Tu' : name(assignee);
}

/** The small marks under a card: body, checklist, links, files; only those there are. */
export function cardMarks(card: Pick<Card, 'hasBody' | 'checklist' | 'links' | 'files'>): { icon: 'card-body' | 'checklist' | 'link' | 'attach'; text: string; title: string }[] {
  const marks: { icon: 'card-body' | 'checklist' | 'link' | 'attach'; text: string; title: string }[] = [];
  if (card.hasBody) marks.push({ icon: 'card-body', text: '', title: 'Ha una descrizione' });
  if (card.checklist.total > 0) marks.push({ icon: 'checklist', text: `${String(card.checklist.done)}/${String(card.checklist.total)}`, title: `Checklist: ${String(card.checklist.done)} su ${String(card.checklist.total)}` });
  if (card.links > 0) marks.push({ icon: 'link', text: String(card.links), title: card.links === 1 ? '1 link' : `${String(card.links)} link` });
  if (card.files > 0) marks.push({ icon: 'attach', text: String(card.files), title: card.files === 1 ? '1 allegato' : `${String(card.files)} allegati` });
  return marks;
}

/** The cards `card` may wait for: other open tasks, not already among its dependencies. */
export function dependencyChoices(card: Card, cards: readonly Card[]): Card[] {
  const taken = new Set(card.dependsOn.map((ref) => ref.id));
  return cards.filter((other) => other.kind === 'task' && other.id !== card.id && !taken.has(other.id) && other.status !== 'done' && other.status !== 'failed');
}

// Files.

/** Bytes as the page says them: "840 B", "2,1 kB", "1,4 MB". */
export function fileSizeText(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1).replace('.', ',')} kB`;
  return `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

/** Why a file is not sent, before reading it; undefined: it goes. */
export function fileRefusal(file: { name: string; size: number }): string | undefined {
  if (file.size > MAX_FILE_BYTES) return `«${file.name}» supera i 20 MB: non lo allego.`;
  return undefined;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** As INLINE_TYPES of apps/core/src/card-details.ts: not a PDF, which a sandboxed document cannot show. */
export const INLINE_TYPES = [...IMAGE_TYPES, 'text/plain'];

export function isImage(mediaType: string): boolean {
  return IMAGE_TYPES.includes(mediaType);
}

/** What the core shows in the browser; the rest is downloaded. */
export function opensInline(mediaType: string): boolean {
  return INLINE_TYPES.includes(mediaType);
}

/** "PDF", "PNG", "DOCX"…: the kind of a file, from its type or its name. */
export function fileKindText(file: Pick<CardFile, 'name' | 'mediaType'>): string {
  const dot = file.name.lastIndexOf('.');
  if (dot > 0 && dot < file.name.length - 1 && file.name.length - dot <= 6) return file.name.slice(dot + 1).toUpperCase();
  const sub = file.mediaType.split('/')[1] ?? '';
  return sub === 'octet-stream' || sub === '' ? 'File' : sub.toUpperCase();
}

/** The base64 of a `data:` URL (FileReader.readAsDataURL). */
export function dataUrlBase64(url: string): string {
  const comma = url.indexOf(',');
  return comma === -1 ? '' : url.slice(comma + 1);
}

/** Checklist progress, 0-100. */
export function progressPercent(items: readonly Pick<ChecklistItem, 'done'>[]): number {
  if (items.length === 0) return 0;
  return Math.round((items.filter((item) => item.done).length / items.length) * 100);
}

/** A link as shown: its title, or the address without the scheme. */
export function linkText(link: Pick<CardLink, 'url' | 'title'>): string {
  return link.title ?? link.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Whether a text is an http(s) address, as the core checks it. */
export function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// The history, written by the code from the events (ids and names only).

const CAUSE_TEXT: Record<string, string> = {
  user: 'da te',
  engine: 'dal motore',
  agent: 'da un agente',
  approval: 'con una decisione',
};

const FIELD_TEXT: Record<string, string> = {
  title: 'titolo',
  project: 'progetto',
  assignee: 'chi la fa',
  due: 'scadenza',
  goal: 'descrizione',
  criteria: '«Quando è finito»',
  priority: 'priorità',
  planned: 'data di esecuzione',
};

const PART_TEXT: Record<string, Record<string, string>> = {
  link: { added: 'Link aggiunto', removed: 'Link tolto' },
  item: { added: 'Voce della checklist aggiunta', removed: 'Voce della checklist tolta', changed: 'Voce della checklist modificata', ticked: 'Voce della checklist spuntata', unticked: 'Voce della checklist non più spuntata' },
  file: { added: 'Allegato aggiunto', removed: 'Allegato tolto' },
};

function statusName(value: unknown): string {
  return typeof value === 'string' && value in STATUS_COLUMN_TEXT ? STATUS_COLUMN_TEXT[value as TaskStatus] : 'uno stato sconosciuto';
}

function listText(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} e ${words.at(-1) ?? ''}`;
}

/** One line of the history in Italian; undefined for an event that repeats another (the card's birth). */
export function historyText(entry: Pick<HistoryEntry, 'kind' | 'payload'>): string | undefined {
  const payload = entry.payload;
  switch (entry.kind) {
    case 'task.created':
      return 'Creata';
    case 'task.status': {
      const cause = typeof payload.cause === 'string' ? CAUSE_TEXT[payload.cause] : undefined;
      const from = statusName(payload.from);
      const to = statusName(payload.to);
      const move = from === to ? `In «${to}»` : `Da «${from}» a «${to}»`;
      return cause === undefined ? move : `${move}, ${cause}`;
    }
    case 'task.blocked':
      return 'In attesa delle card da cui dipende';
    case 'task.unblocked':
      return 'Ripartita';
    case 'card.changed': {
      if (payload.created === true) return undefined;
      if (Array.isArray(payload.fields)) {
        const names = payload.fields.filter((field): field is string => typeof field === 'string').map((field) => FIELD_TEXT[field] ?? field);
        if (names.length === 0) return 'Modificata';
        return `${names.length === 1 ? 'Modificato' : 'Modificati'}: ${listText(names)}`;
      }
      if (typeof payload.dependsOn === 'string') return 'Aspetta un’altra card';
      if (typeof payload.removedDependency === 'string') return 'Non aspetta più una card';
      for (const part of ['link', 'item', 'file']) {
        const value = payload[part];
        if (typeof value === 'string') return PART_TEXT[part]?.[value] ?? 'Modificata';
      }
      return 'Modificata';
    }
    default:
      return undefined;
  }
}

export interface HistoryLine {
  at: string;
  text: string;
  when: string;
}

/** The history as the panel shows it, newest first (the order of the core). */
export function historyLines(history: readonly HistoryEntry[], now: Date): HistoryLine[] {
  const lines: HistoryLine[] = [];
  for (const entry of history) {
    const text = historyText(entry);
    if (text !== undefined) lines.push({ at: entry.at, text, when: relativeTimeText(entry.at, now) });
  }
  return lines;
}

// The refusals of the core in Italian.

const PART_NAMES: Record<string, string> = { links: 'link', items: 'voci', files: 'allegati' };

const CARD_ERRORS: [RegExp, string | ((match: RegExpExecArray) => string)][] = [
  [/^a card cannot move from running/, RUNNING_TEXT],
  [/^a card cannot move from \w+ to \w+ by hand/, NOT_BY_HAND_TEXT],
  [/^the card waits for a decision/, 'La card aspetta una tua decisione: decidila nella chat.'],
  [/^the card is at work/, 'La card è al lavoro: aspetta che finisca.'],
  [/^an agent's card is done only from Da verificare/, AGENT_DONE_TEXT],
  [/^a card already started or done keeps who does it/, 'Una card già partita o fatta non cambia chi la fa.'],
  // "Avvia", "Riprendi", "Riprova" (D-159).
  [/^only the card of an agent starts/, 'Si avvia solo la card di un agente: le tue le fai tu.'],
  [/^only a card still to do starts/, 'Si avvia solo una card ancora da fare.'],
  [/^the card has already started/, 'La card è già partita: riprendila o riprovala.'],
  [/^only a card in Aspetta resumes/, 'Si riprende solo una card in Aspetta.'],
  [/^the card never started/, 'La card non è mai partita: avviala, o spostala in Da fare.'],
  [/^the card waits for another card/, 'La card aspetta un’altra card: riparte da sola quando quella è fatta.'],
  [/^only a failed card is retried/, 'Si riprova solo una card fallita.'],
  [/^the two cards would wait for each other/, 'Le due card si aspetterebbero a vicenda.'],
  [/^a card waits for (\d+) cards at most/, (match) => `Una card aspetta al massimo ${match[1] ?? ''} card.`],
  [/^a card holds (\d+) (links|items|files) at most/, (match) => `Una card tiene al massimo ${match[1] ?? ''} ${PART_NAMES[match[2] ?? ''] ?? ''}.`],
  [/^only a card still to do waits/, 'Solo una card ancora da fare può aspettarne un’altra.'],
  [/^a card cannot wait for itself/, 'Una card non può aspettare sé stessa.'],
  [/^url (is not a web address|must be text)/, 'Il link deve essere un indirizzo web (http o https).'],
  [/^a file is (\d+) MB at most/, (match) => `Un allegato può essere al massimo di ${match[1] ?? ''} MB.`],
  [/^data must be base64/, 'Il file non è arrivato intero: riprova.'],
  [/^name (must|is not)/, 'Il nome del file non è valido.'],
  [/^no such link/, 'Questo link non c’è più.'],
  [/^no such item/, 'Questa voce non c’è più.'],
  [/^no such file/, 'Questo allegato non c’è più.'],
  [/^the file is missing/, 'Il file di questo allegato manca dal disco.'],
  [/^the file has changed on disk/, 'Il file di questo allegato è cambiato sul disco: non lo apro.'],
  [/^priority must be/, 'La priorità non è valida.'],
  [/^planned must be/, 'La data di esecuzione non è valida.'],
  [/^goal is longer than (\d+)/, (match) => `La descrizione supera i ${match[1] ?? ''} caratteri.`],
  [/^criteria is longer than (\d+)/, (match) => `«Quando è finito» supera i ${match[1] ?? ''} caratteri.`],
  [/^body must not be empty/, 'La voce è vuota.'],
  [/^body is longer than (\d+)/, (match) => `La voce supera i ${match[1] ?? ''} caratteri.`],
  [/^title is longer than (\d+)/, (match) => `Il titolo del link supera i ${match[1] ?? ''} caratteri.`],
  [/^done must be/, 'La spunta non è valida.'],
  [/^unknown project/, 'Questo progetto non è fra quelli approvati.'],
  [/^unknown assignee/, 'Questo agente non c’è.'],
  [/^title must be/, 'Il titolo va da 1 a 200 caratteri.'],
  [/^due must be/, 'La scadenza non è una data valida.'],
  [/^no such card/, 'La card non c’è più.'],
  [/^no such dependency/, 'Questa dipendenza non c’è più.'],
];

/** What the cardwall says when the core refuses a change. */
export function cardErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    for (const [pattern, said] of CARD_ERRORS) {
      const match = pattern.exec(cause.message);
      if (match !== null) return typeof said === 'string' ? said : said(match);
    }
    if (cause.status === 413) return 'Il file è troppo grande per arrivare al core.';
    if (cause.status === 409) return 'Questo spostamento non è permesso.';
  }
  return errorText(cause);
}

// The approvals of the cardwall in the chat (D-159): a plan of Arianna, the choice of where a card runs.

/** One card of a proposed plan, as the approval card shows it. */
export interface PlanRow {
  number: number;
  title: string;
  goal: string;
  /** "Tu", or the agent's name. */
  who: string;
  /** "bloccata da: 1. Grafica della landing", or undefined when it waits for none. */
  blockedBy: string | undefined;
}

/** The plan in an approval of kind plan; undefined when its detail is not one. */
export function planRows(detail: Record<string, unknown>): { title: string; rows: PlanRow[] } | undefined {
  const { title, cards } = detail;
  if (typeof title !== 'string' || !Array.isArray(cards) || cards.length === 0) return undefined;
  const titles: string[] = [];
  const rows: PlanRow[] = [];
  for (const [index, item] of (cards as unknown[]).entries()) {
    if (typeof item !== 'object' || item === null) return undefined;
    const card = item as Record<string, unknown>;
    if (typeof card.title !== 'string' || typeof card.assignee !== 'string') return undefined;
    titles.push(card.title);
    const blocked = Array.isArray(card.blockedBy) ? (card.blockedBy as unknown[]).filter((on): on is number => typeof on === 'number' && Number.isInteger(on) && on >= 1 && on <= index) : [];
    rows.push({
      number: index + 1,
      title: card.title,
      goal: typeof card.goal === 'string' ? card.goal : '',
      who: card.assignee === 'user' ? 'Tu' : agentTitle(card.assignee),
      blockedBy: blocked.length === 0 ? undefined : `bloccata da: ${blocked.map((on) => `${String(on)}. ${titles[on - 1] ?? ''}`).join(', ')}`,
    });
  }
  return { title, rows };
}

/** The ways offered in an approval of kind executor, and the ones left out with why (D-159). */
export function executorChoices(
  detail: Record<string, unknown>,
): { title: string; agent: string; options: ExecutorChoice[]; excluded: { executor: string; why: string }[] } | undefined {
  const { title, agent, options, excluded } = detail;
  if (typeof title !== 'string' || typeof agent !== 'string' || !Array.isArray(options)) return undefined;
  // A delegation of the chat names its delegation; a card does not.
  const whyText = typeof detail.delegation === 'string' ? EXCLUDED_WORK_TEXT : EXCLUDED_TEXT;
  const known: readonly string[] = ['claude', 'codex', 'local'];
  const offered = (options as unknown[]).filter((option): option is ExecutorChoice => typeof option === 'string' && known.includes(option));
  const left = Array.isArray(excluded)
    ? (excluded as unknown[]).flatMap((item) => {
        if (typeof item !== 'object' || item === null) return [];
        const { executor, reason } = item as Record<string, unknown>;
        return typeof executor === 'string' && typeof reason === 'string' ? [{ executor: CHOICE_TEXT[executor] ?? executor, why: whyText[reason] ?? reason }] : [];
      })
    : [];
  return offered.length === 0 ? undefined : { title, agent: agentTitle(agent), options: offered, excluded: left };
}
