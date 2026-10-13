import { type Card, COMMITMENT_MOVE_TEXT, dueText, moveRefusal, type MoveTarget, plannedText } from './cardwall.ts';
import { dayLabel } from './commitments.ts';

/**
 * The mini cardwall above the secretary's conversation (I-12, D-156): the
 * open commitments and the user's open cards with a day, in four columns by
 * day (In ritardo, Oggi, Domani, Prossimi giorni), "+N più avanti" for those
 * further on and the line "Fatti oggi". Read from `GET /api/cards`, the same
 * list as the cardwall; pure helpers only.
 */

export type MiniColumnId = 'late' | 'today' | 'tomorrow' | 'next';

export const MINI_COLUMNS: readonly { id: MiniColumnId; title: string }[] = [
  { id: 'late', title: 'In ritardo' },
  { id: 'today', title: 'Oggi' },
  { id: 'tomorrow', title: 'Domani' },
  { id: 'next', title: 'Prossimi giorni' },
];

/** "Prossimi giorni": the seven days after tomorrow; the later ones are only counted. */
export const NEXT_DAYS = 7;

function addDays(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, date + days));
  return at.toISOString().slice(0, 10);
}

/** The local day ("YYYY-MM-DD") of an instant, on this Mac: the core's local day is the same clock. */
export function localDayOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

type Dated = Pick<Card, 'kind' | 'status' | 'assignee' | 'due' | 'planned'>;

/** Whether the card is still to do: an open commitment, or a task neither done nor failed. */
function isOpen(card: Pick<Card, 'kind' | 'status'>): boolean {
  return card.kind === 'commitment' ? card.status === 'open' : card.status !== 'done' && card.status !== 'failed';
}

/** Commitments always; of the cards, only the user's with a due day or a planned day. */
function belongs(card: Dated): boolean {
  return card.kind === 'commitment' || (card.assignee === 'user' && (card.due !== null || card.planned !== null));
}

/**
 * The day a card counts on. A commitment: its day. A card past its due day is
 * late, whatever its planned day (as on the cardwall). Otherwise "Data
 * esecuzione" when it has one, else the due day; a planned day already gone
 * with a due day still to come counts as today (not late, to do now).
 */
export function wallDay(card: Pick<Card, 'kind' | 'due' | 'planned'>, today: string): string | null {
  if (card.kind === 'commitment') return card.due;
  if (card.due !== null && card.due < today) return card.due;
  const day = card.planned ?? card.due;
  if (day !== null && day < today && card.due !== null && card.due >= today) return today;
  return day;
}

/** The column of an open card on the mini wall, 'later' beyond "Prossimi giorni", undefined when it is not there. */
export function miniColumn(card: Dated, today: string): MiniColumnId | 'later' | undefined {
  if (!belongs(card) || !isOpen(card)) return undefined;
  const day = wallDay(card, today);
  if (day === null) return undefined;
  if (day < today) return 'late';
  if (day === today) return 'today';
  const tomorrow = addDays(today, 1);
  if (day === tomorrow) return 'tomorrow';
  return day <= addDays(tomorrow, NEXT_DAYS) ? 'next' : 'later';
}

/** Inside a column: by day, then the time (those without one after), then priority (highest first), then the title. */
export function compareMini(today: string): (a: Card, b: Card) => number {
  return (a, b) => {
    const dayA = wallDay(a, today) ?? '';
    const dayB = wallDay(b, today) ?? '';
    if (dayA !== dayB) return dayA.localeCompare(dayB);
    if (a.time !== b.time) return a.time === null ? 1 : b.time === null ? -1 : a.time.localeCompare(b.time);
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.title.localeCompare(b.title, 'it');
  };
}

export interface MiniWall {
  columns: { id: MiniColumnId; title: string; items: Card[] }[];
  /** How many open ones come after "Prossimi giorni". */
  later: number;
  /** Closed today: the commitments done and the user's cards done, newest first. */
  doneToday: Card[];
  /** Every open one on the mini wall, the later ones included. */
  open: number;
}

/** The mini wall from the cards of `GET /api/cards`. `dayOf` turns `updatedAt` into a local day (tests pass their own). */
export function miniWall(cards: readonly Card[], today: string, dayOf: (iso: string) => string = localDayOf): MiniWall {
  const columns = MINI_COLUMNS.map((column) => ({ ...column, items: [] as Card[] }));
  let later = 0;
  const doneToday: Card[] = [];
  for (const card of cards) {
    if (card.status === 'done' && belongs(card) && dayOf(card.updatedAt) === today) {
      doneToday.push(card);
      continue;
    }
    const id = miniColumn(card, today);
    if (id === undefined) continue;
    if (id === 'later') later += 1;
    else columns.find((column) => column.id === id)?.items.push(card);
  }
  const order = compareMini(today);
  for (const column of columns) column.items.sort(order);
  doneToday.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { columns, later, doneToday, open: later + columns.reduce((sum, column) => sum + column.items.length, 0) };
}

/** The day line of an item: the day where the column does not say it (late, next days), the time of a commitment. */
export function miniWhen(card: Card, column: MiniColumnId, today: string): string | undefined {
  const showsDay = column === 'late' || column === 'next';
  if (card.kind === 'commitment') {
    if (showsDay) return dueText(card, today);
    return card.time ?? undefined;
  }
  if (!showsDay) return undefined;
  return card.planned !== null ? plannedText(card, today) : card.due === null ? undefined : dayLabel(card.due, today);
}

/** What a drop on "Fatti oggi" does: a commitment is marked done, a card moved to done; or why not. */
export type MiniDrop = { kind: 'commitment-done' } | { kind: 'move'; to: MoveTarget } | { kind: 'noop' } | { kind: 'refuse'; message: string };

export function miniDropDone(card: Pick<Card, 'kind' | 'status' | 'assignee' | 'started'>): MiniDrop {
  if (card.kind === 'commitment') return card.status === 'open' ? { kind: 'commitment-done' } : { kind: 'refuse', message: COMMITMENT_MOVE_TEXT };
  if (card.status === 'done') return { kind: 'noop' };
  const refusal = moveRefusal(card, 'done');
  return refusal === undefined ? { kind: 'move', to: 'done' } : { kind: 'refuse', message: refusal };
}

// Folded or open, remembered in this browser (localStorage, in try/catch: it may be missing or refuse).
const FOLDED_KEY = 'arianna.secretary.wall.folded';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Open by default. */
export function loadFolded(storage: StorageLike | undefined): boolean {
  try {
    return storage?.getItem(FOLDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveFolded(storage: StorageLike | undefined, folded: boolean): void {
  try {
    storage?.setItem(FOLDED_KEY, folded ? '1' : '0');
  } catch {
    // Not remembered: the panel still works.
  }
}
