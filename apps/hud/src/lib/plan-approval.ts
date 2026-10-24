/**
 * The card of a plan of Arianna in the chat (D-159, D-235): the rows read
 * from the approval, edited before the decision (title, goal, who does it,
 * «bloccata da», criteria, complexity; rows added and removed), and the
 * rows «Avvia subito» sent with the decision. Pure: the component and the
 * tests share it. The core checks everything again.
 */
import { dayLabel } from './commitments.ts';
import { agentTitle } from './italian.ts';

export const COMPLEXITIES = ['S', 'M', 'L'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

/** As the menu of a row says it. */
export const COMPLEXITY_TEXT: Record<Complexity, string> = { S: 'S · piccola', M: 'M · media', L: 'L · grande' };

/** As the core counts them (MIN_PLAN_CARDS, MAX_PLAN_CARDS of @arianna/agents). */
export const MIN_PLAN_ROWS = 2;
export const MAX_PLAN_ROWS = 12;
const MAX_TITLE = 120;
const MAX_TEXT = 500;

export interface PlanDraftRow {
  title: string;
  goal: string;
  /** 'user' or the name of an agent. */
  assignee: string;
  /** Earlier rows it waits for, by their number (1 is the first). */
  blockedBy: number[];
  criteria: string;
  complexity: Complexity;
  /** «Avvia subito»: only an agent's row starts with the decision. */
  start: boolean;
}

export interface PlanDraft {
  title: string;
  rows: PlanDraftRow[];
  /** How many times the user edited the plan: sent with the decision, so that nothing starts unseen. */
  revision: number;
}

/** What «Crea le card» sends with the decision (D-235): the rows «Avvia subito» and the plan's revision. */
export interface PlanChoice {
  starts: readonly number[];
  revision: number;
}

/** What PUT /api/approvals/:id/plan takes: the arguments of `task.plan`. */
export interface PlanBody {
  title: string;
  cards: { title: string; goal: string; assignee: string; blocked_by: number[]; criteria: string; complexity: Complexity }[];
}

/** Who does a row, as the card writes it. */
export function whoText(assignee: string): string {
  return assignee === 'user' ? 'Tu' : agentTitle(assignee);
}

/** «Avvia subito» by default: an agent's row that waits for no card. */
export function startsByDefault(row: Pick<PlanDraftRow, 'assignee' | 'blockedBy'>): boolean {
  return row.assignee !== 'user' && row.blockedBy.length === 0;
}

/**
 * «Scritto da Sonnet: Opus è spento» (D-235): the core's note of a plan
 * written by another model than the project asked for; undefined otherwise.
 */
export function planWrittenBy(detail: Record<string, unknown>): string | undefined {
  return typeof detail.writtenBy === 'string' && detail.writtenBy.trim() !== '' ? detail.writtenBy : undefined;
}

/** The milestone a «/progetta» named (D-313, seguito 3), with its due day as the chat writes it; undefined when none. */
export function planMilestone(detail: Record<string, unknown>, today: string): { title: string; due: string | null } | undefined {
  const milestone = detail.milestone;
  if (typeof milestone !== 'object' || milestone === null) return undefined;
  const { title, due } = milestone as Record<string, unknown>;
  if (typeof title !== 'string' || title.trim() === '') return undefined;
  return { title, due: typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due) ? dayLabel(due, today) : null };
}

/** The plan in an approval's detail, as rows to show and edit; undefined when the detail is not a plan. */
export function planDraft(detail: Record<string, unknown>): PlanDraft | undefined {
  const { title, cards } = detail;
  if (typeof title !== 'string' || !Array.isArray(cards) || cards.length === 0) return undefined;
  const rows: PlanDraftRow[] = [];
  for (const [index, item] of (cards as unknown[]).entries()) {
    if (typeof item !== 'object' || item === null) return undefined;
    const card = item as Record<string, unknown>;
    if (typeof card.title !== 'string' || typeof card.assignee !== 'string') return undefined;
    const blockedBy = Array.isArray(card.blockedBy) ? (card.blockedBy as unknown[]).filter((on): on is number => typeof on === 'number' && Number.isInteger(on) && on >= 1 && on <= index) : [];
    const complexity = COMPLEXITIES.find((size) => size === card.complexity) ?? 'M';
    const row = {
      title: card.title,
      goal: typeof card.goal === 'string' ? card.goal : '',
      assignee: card.assignee,
      blockedBy,
      criteria: typeof card.criteria === 'string' ? card.criteria : '',
      complexity,
    };
    rows.push({ ...row, start: startsByDefault(row) });
  }
  const revision = typeof detail.revision === 'number' && Number.isInteger(detail.revision) && detail.revision >= 0 ? detail.revision : 0;
  return { title, rows, revision };
}

/**
 * The plan read again (a refresh of the chat): the user's ticks «Avvia
 * subito» stay row by row while it is the same version; an edit made
 * elsewhere brings the new rows with their defaults.
 */
export function keepTicks(fresh: PlanDraft, shown: PlanDraft | undefined): PlanDraft {
  if (shown === undefined || shown.revision !== fresh.revision || shown.rows.length !== fresh.rows.length) return fresh;
  return { ...fresh, rows: fresh.rows.map((row, index) => ({ ...row, start: row.assignee !== 'user' && (shown.rows[index]?.start ?? row.start) })) };
}

/** A copy to edit, so that «Annulla» finds the plan as it was. */
export function cloneDraft(draft: PlanDraft): PlanDraft {
  return { title: draft.title, rows: draft.rows.map((row) => ({ ...row, blockedBy: [...row.blockedBy] })), revision: draft.revision };
}

/** A new row at the end: the user's, waiting for nothing. */
export function addRow(draft: PlanDraft): PlanDraft {
  if (draft.rows.length >= MAX_PLAN_ROWS) return draft;
  return { ...draft, rows: [...draft.rows, { title: '', goal: '', assignee: 'user', blockedBy: [], criteria: '', complexity: 'M', start: false }] };
}

/** Row `number` (1-based) removed: the others no longer wait for it, and the later ones are numbered again. */
export function removeRow(draft: PlanDraft, number: number): PlanDraft {
  const rows = draft.rows
    .filter((_, index) => index + 1 !== number)
    .map((row) => ({ ...row, blockedBy: row.blockedBy.filter((on) => on !== number).map((on) => (on > number ? on - 1 : on)) }));
  return { ...draft, rows };
}

/** Row `number` waits, or no longer waits, for the earlier row `on`. */
export function toggleBlockedBy(row: PlanDraftRow, number: number, on: number): PlanDraftRow {
  if (on < 1 || on >= number) return row;
  const blockedBy = row.blockedBy.includes(on) ? row.blockedBy.filter((other) => other !== on) : [...row.blockedBy, on].sort((a, b) => a - b);
  return { ...row, blockedBy };
}

/** Who does a row changes: «Avvia subito» follows the default for the new assignee (never for the user). */
export function withAssignee(row: PlanDraftRow, assignee: string): PlanDraftRow {
  const next = { ...row, assignee };
  return { ...next, start: assignee === 'user' ? false : row.assignee === 'user' ? startsByDefault(next) : row.start };
}

/** The body of the edit: the arguments of `task.plan`, trimmed. */
export function planBody(draft: PlanDraft): PlanBody {
  return {
    title: draft.title.trim(),
    cards: draft.rows.map((row) => ({
      title: row.title.trim(),
      goal: row.goal.trim(),
      assignee: row.assignee,
      blocked_by: [...row.blockedBy],
      criteria: row.criteria.trim(),
      complexity: row.complexity,
    })),
  };
}

/** The rows «Avvia subito» sent with «Crea le card»: agents' rows only. */
export function planStarts(draft: PlanDraft): number[] {
  return draft.rows.flatMap((row, index) => (row.start && row.assignee !== 'user' ? [index + 1] : []));
}

/** Why the edited plan cannot be saved yet, in Italian; undefined when the core may check it. */
export function draftProblem(draft: PlanDraft): string | undefined {
  const title = draft.title.trim();
  if (title === '' || Array.from(title).length > MAX_TITLE) return `Il piano vuole un titolo (al massimo ${String(MAX_TITLE)} caratteri).`;
  if (draft.rows.length < MIN_PLAN_ROWS || draft.rows.length > MAX_PLAN_ROWS) return `Un piano ha da ${String(MIN_PLAN_ROWS)} a ${String(MAX_PLAN_ROWS)} card.`;
  for (const [index, row] of draft.rows.entries()) {
    const which = `Card ${String(index + 1)}`;
    if (row.title.trim() === '' || Array.from(row.title.trim()).length > MAX_TITLE) return `${which}: manca il titolo (al massimo ${String(MAX_TITLE)} caratteri).`;
    if (row.goal.trim() === '' || Array.from(row.goal.trim()).length > MAX_TEXT) return `${which}: manca l’obiettivo (al massimo ${String(MAX_TEXT)} caratteri).`;
    if (row.criteria.trim() === '' || Array.from(row.criteria.trim()).length > MAX_TEXT) {
      return `${which}: manca il criterio di completamento (al massimo ${String(MAX_TEXT)} caratteri).`;
    }
    if (row.blockedBy.some((on) => on < 1 || on > index)) return `${which}: «bloccata da» può indicare solo card precedenti.`;
  }
  return undefined;
}

/** «/progetta» (D-235): why it does not work in this conversation, in Italian; undefined where it does. */
export function planCommandProblem(where: { ariannaChat: boolean; incognito: boolean; mode: string; workspace: string | null }): string | undefined {
  if (!where.ariannaChat) return '/progetta vale solo in una conversazione con Arianna.';
  if (where.incognito) return '/progetta non funziona in incognito: le card resterebbero dopo la conversazione.';
  if (where.mode === 'work' && where.workspace === null) return '/progetta, in una conversazione di lavoro, vuole un progetto: aprine una con il progetto.';
  return undefined;
}
