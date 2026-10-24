import { dueText, type Card } from './cardwall.ts';
import { dayLabel } from './commitments.ts';
import type { Label } from './types.ts';

/**
 * The milestones of a project on the cardwall (D-313): chosen a project, the
 * board shows the columns of always in one band per milestone, in order, and
 * at the end the band «Senza milestone». Pure helpers: the types of
 * `GET /api/cards`, the bands, the words of a band, the bands folded in this
 * browser and what a drag into another band changes.
 */

export interface MilestoneRef {
  id: string;
  title: string;
  status: 'open' | 'closed';
}

export interface Milestone {
  id: string;
  project: string;
  title: string;
  description: string | null;
  /** "YYYY-MM-DD". */
  due: string | null;
  late: boolean;
  position: number;
  label: Label;
  status: 'open' | 'closed';
  closedAt: string | null;
  cards: { done: number; total: number };
  dependsOn: MilestoneRef[];
  blockedBy: MilestoneRef[];
  /** The pending approval that asks to close it: «La chiudo?». */
  proposal: string | null;
}

/** The id of the band of the cards of a project in no milestone: one per project, folded on its own. */
export function noMilestoneId(project: string): string {
  return `none:${project}`;
}
export const NO_MILESTONE_TITLE = 'Senza milestone';

export interface Band {
  /** The milestone's id, or noMilestoneId(project). */
  id: string;
  milestone: Milestone | null;
  cards: Card[];
}

/** The project the filter chose ("p:<name>"), or null for every project or the general cards. */
export function chosenProject(filter: string): string | null {
  return filter.startsWith('p:') && filter.length > 2 ? filter.slice(2) : null;
}

/**
 * The bands of a project: its milestones in their order (as the core gives
 * them), then «Senza milestone». A card whose milestone is not among them
 * (gone from the list) is shown without one rather than lost.
 */
export function wallBands(cards: readonly Card[], milestones: readonly Milestone[], project: string): Band[] {
  const own = milestones.filter((milestone) => milestone.project === project);
  const ids = new Set(own.map((milestone) => milestone.id));
  const bands: Band[] = own.map((milestone) => ({ id: milestone.id, milestone, cards: cards.filter((card) => card.milestone === milestone.id) }));
  bands.push({ id: noMilestoneId(project), milestone: null, cards: cards.filter((card) => card.milestone === null || card.milestone === undefined || !ids.has(card.milestone)) });
  return bands;
}

/** "2 di 3 fatte", "1 di 1 fatta", "Nessuna card". */
export function progressText(milestone: Pick<Milestone, 'cards'>): string {
  const { done, total } = milestone.cards;
  if (total === 0) return 'Nessuna card';
  return `${String(done)} di ${String(total)} ${total === 1 ? 'fatta' : 'fatte'}`;
}

/** From 0 to 100, for the bar. */
export function progressValue(milestone: Pick<Milestone, 'cards'>): number {
  const { done, total } = milestone.cards;
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

/** "bloccata da: Accessi, Pagamenti" while those are open. */
export function milestoneBlockedText(milestone: Pick<Milestone, 'blockedBy' | 'status'>): string | undefined {
  if (milestone.status !== 'open' || milestone.blockedBy.length === 0) return undefined;
  return `bloccata da: ${milestone.blockedBy.map((item) => item.title).join(', ')}`;
}

/** The due day as a card says it ("scade oggi", "scaduta il …"). */
export function milestoneDueText(milestone: Pick<Milestone, 'due'>, today: string): string | undefined {
  return dueText({ due: milestone.due, time: null }, today);
}

export const CLOSE_QUESTION = 'Nessuna card aperta: la chiudo?';
export const MILESTONE_NOTE = 'Tutte le sue card sono in Fatto. Con «No» resta aperta e non te lo richiedo finché non cambiano le sue card.';

/** The card of an approval of kind `milestone`: the title and project it names, or undefined. */
export function milestoneClosing(approval: { kind: string; detail: Record<string, unknown> }): { title: string; project: string } | undefined {
  if (approval.kind !== 'milestone') return undefined;
  const { title, project } = approval.detail;
  return typeof title === 'string' && typeof project === 'string' ? { title, project } : undefined;
}
export const CLOSE_YES = 'Sì, chiudila';
export const CLOSE_NO = 'No, lasciala aperta';

// A milestone Arianna proposes in the chat (D-313, seguito 2): nothing is created before «Crea la milestone».

export const PROPOSAL_YES = 'Crea la milestone';
export const PROPOSAL_NO = 'Non ora';
export const PROPOSAL_NOTE = 'Le card nascono in Inbox, assegnate a te: nessuna parte da sola. La milestone resta su questo Mac (Privato).';

export interface MilestoneProposalCard {
  title: string;
  project: string;
  description: string | null;
  /** "venerdì 30 ottobre", as a card says its day. */
  due: string | null;
  cards: string[];
}

/** The card of an approval of kind `milestone_plan`, or undefined when it is not a whole one. */
export function milestoneProposal(approval: { kind: string; detail: Record<string, unknown> }, today: string): MilestoneProposalCard | undefined {
  if (approval.kind !== 'milestone_plan') return undefined;
  const { title, project, description, due, cards } = approval.detail;
  if (typeof title !== 'string' || typeof project !== 'string' || !Array.isArray(cards)) return undefined;
  return {
    title,
    project,
    description: typeof description === 'string' && description.trim() !== '' ? description : null,
    due: typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due) ? dayLabel(due, today) : null,
    cards: (cards as unknown[]).filter((card): card is string => typeof card === 'string'),
  };
}

/** The milestones a card may go in: the open ones of its project, and the one it is in. */
export function milestoneChoices(card: Pick<Card, 'kind' | 'project' | 'milestone'>, milestones: readonly Milestone[]): Milestone[] {
  if (card.kind !== 'task' || card.project === null) return [];
  return milestones.filter((milestone) => milestone.project === card.project && (milestone.status === 'open' || milestone.id === card.milestone));
}

/** The milestones another one may wait for: of the same project, not itself. */
export function blockerChoices(milestone: Pick<Milestone, 'id' | 'project'>, milestones: readonly Milestone[]): Milestone[] {
  return milestones.filter((other) => other.project === milestone.project && other.id !== milestone.id);
}

export const COMMITMENT_BAND_TEXT = 'Un impegno non sta in una milestone.';
export const CLOSED_BAND_TEXT = 'La milestone è chiusa: riaprila prima di spostarci una card.';

/**
 * A drag that ends in another band: the milestone the card goes in (null:
 * none), `same` when the band is its own, or a refusal.
 */
export function bandDrop(card: Pick<Card, 'kind' | 'milestone'>, band: Pick<Band, 'id' | 'milestone'>): { kind: 'same' } | { kind: 'change'; milestone: string | null } | { kind: 'refuse'; message: string } {
  const target = band.milestone === null ? null : band.milestone.id;
  if ((card.milestone ?? null) === target) return { kind: 'same' };
  if (card.kind !== 'task') return { kind: 'refuse', message: COMMITMENT_BAND_TEXT };
  if (band.milestone !== null && band.milestone.status !== 'open') return { kind: 'refuse', message: CLOSED_BAND_TEXT };
  return { kind: 'change', milestone: target };
}

// The bands folded, per browser: a closed milestone starts folded, an open one unfolded.

const FOLD_KEY = 'arianna.cardwall.milestones';
const MAX_FOLDS = 200;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Folds = Record<string, boolean>;

export function loadFolds(storage: StorageLike | undefined): Folds {
  try {
    const raw = storage?.getItem(FOLD_KEY);
    if (raw === null || raw === undefined) return {};
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const folds: Folds = {};
    for (const [id, folded] of Object.entries(value as Record<string, unknown>).slice(-MAX_FOLDS)) if (typeof folded === 'boolean' && id.length <= 64) folds[id] = folded;
    return folds;
  } catch {
    return {};
  }
}

export function saveFolds(storage: StorageLike | undefined, folds: Folds): void {
  try {
    const entries = Object.entries(folds).slice(-MAX_FOLDS);
    storage?.setItem(FOLD_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Private window or blocked storage: the bands fold until the page closes.
  }
}

/** Whether a band is folded: the user's choice, else folded only for a closed milestone. */
export function isFolded(band: Pick<Band, 'id' | 'milestone'>, folds: Folds): boolean {
  return folds[band.id] ?? band.milestone?.status === 'closed';
}

/** The fold turned round; the choice is kept by id. */
export function toggleFold(band: Pick<Band, 'id' | 'milestone'>, folds: Folds): Folds {
  // The last choice goes at the end, so that the oldest are the first to go past MAX_FOLDS.
  const next: Folds = Object.fromEntries(Object.entries(folds).filter(([id]) => id !== band.id));
  next[band.id] = !isFolded(band, folds);
  return next;
}
