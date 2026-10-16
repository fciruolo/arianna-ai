import { MAX_PLAN_CARDS, MIN_PLAN_CARDS, PLAN_COMPLEXITIES, type PlanComplexity } from '@arianna/agents';
import { isAtMost, scanText, type Label } from '@arianna/policy';

import { loadApproval, type StoredApproval } from './approvals.ts';
import { PROJECT_NAME } from './cardwall.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { enqueueJob } from './jobs.ts';
import { createTask, loadTask, moveTask, STEP_QUEUE, type Task } from './tasks.ts';

/**
 * The plans of Arianna (I-13 tappa C3, D-159; tappa C5, D-235): `task.plan`
 * and «/progetta» propose cards with their dependencies, and nothing is
 * created until the user approves the plan in the web chat (an approval of
 * kind `plan`, the cards in its detail). Until then the user may edit the
 * cards in the plan's card (editPlan), at the privacy of the conversation.
 * In the transaction of the decision the core creates them as children of
 * the chat task, all in the inbox (D-235), each with its criteria and
 * complexity; the rows the user ticked «Avvia subito» go to do with their
 * first step queued, as «Avvia» does: one that waits for another card is held
 * back by the engine until that one is done (D-152). Everything stays on this
 * machine: the events carry ids only.
 */

export interface PlannedCard {
  title: string;
  goal: string;
  /** 'user' or the name of an agent. */
  assignee: string;
  /** The earlier cards of the plan it waits for, by their number (1 is the first). */
  blockedBy: number[];
  /** When the card is done (D-235): its `done_criteria`; '' only in a plan written before D-235. */
  criteria: string;
  /** How large it is (D-235); null only in a plan written before D-235. */
  complexity: PlanComplexity | null;
}

export interface PlanProposal {
  title: string;
  cards: PlannedCard[];
}

/** A plan as an approval holds it: with the rows to start, once the user decided it (D-235). */
export interface StoredPlan extends PlanProposal {
  starts?: number[];
}

/**
 * What the chat sends with the decision on a plan (D-235): the rows
 * «Avvia subito» and the revision of the plan it showed. Unchecked here.
 */
export interface PlanDecision {
  starts?: unknown;
  revision?: unknown;
}

/** How many times the user edited the plan: 0 as the planner wrote it (D-235). */
export function planRevision(detail: Record<string, unknown>): number {
  const revision = detail.revision;
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

/** The action of an approval of kind `plan` (migration 0045). */
export const PLAN_ACTION = 'task.plan';

const MAX_TITLE = 120;
const MAX_GOAL = 500;
const MAX_CRITERIA = 500;

/** A refusal of the plan's routes: `not-found` 404, `invalid` 400, `conflict` 409. */
export class PlanError extends Error {
  override name = 'PlanError';
  readonly code: 'not-found' | 'invalid' | 'conflict';

  constructor(code: 'not-found' | 'invalid' | 'conflict', message: string) {
    super(message);
    this.code = code;
  }
}

function line(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' || Array.from(text).length > max ? undefined : text;
}

function complexityOf(value: unknown): PlanComplexity | undefined {
  return PLAN_COMPLEXITIES.find((candidate) => candidate === value);
}

/**
 * The plan in the arguments of `task.plan` (or of the user's edit), checked
 * again here (the server may not constrain decoding): a title, 2 to 12 cards,
 * each done by one of `assignees`, waiting only for earlier cards of the
 * plan, once each, so that the plan never has a cycle, with its criteria and
 * complexity. An error is for the model (or the chat) to read.
 */
export function checkPlan(args: Record<string, unknown>, assignees: readonly string[]): PlanProposal | { error: string } {
  const title = line(args.title, MAX_TITLE);
  if (title === undefined) return { error: `the plan needs a title of 1-${String(MAX_TITLE)} characters` };
  const raw = Array.isArray(args.cards) ? (args.cards as unknown[]) : [];
  if (raw.length < MIN_PLAN_CARDS || raw.length > MAX_PLAN_CARDS) {
    return { error: `a plan has ${String(MIN_PLAN_CARDS)} to ${String(MAX_PLAN_CARDS)} cards; for one card call task.create` };
  }
  const cards: PlannedCard[] = [];
  for (const [index, item] of raw.entries()) {
    const number = index + 1;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { error: `card ${String(number)} is not an object` };
    const card = item as Record<string, unknown>;
    const cardTitle = line(card.title, MAX_TITLE);
    if (cardTitle === undefined) return { error: `card ${String(number)} needs a title of 1-${String(MAX_TITLE)} characters` };
    const goal = line(card.goal, MAX_GOAL);
    if (goal === undefined) return { error: `card ${String(number)} needs a goal of 1-${String(MAX_GOAL)} characters` };
    if (typeof card.assignee !== 'string' || !assignees.includes(card.assignee)) {
      return { error: `card ${String(number)}: "assignee" must be one of ${assignees.join(', ')}` };
    }
    const blocked = Array.isArray(card.blocked_by) ? (card.blocked_by as unknown[]) : undefined;
    if (blocked === undefined) return { error: `card ${String(number)} needs "blocked_by" (use [] when it waits for no card)` };
    const blockedBy: number[] = [];
    for (const on of blocked) {
      if (typeof on !== 'number' || !Number.isInteger(on) || on < 1 || on >= number) {
        return { error: `card ${String(number)}: "blocked_by" may name only earlier cards of the plan, by their number (1 to ${String(number - 1)})` };
      }
      if (!blockedBy.includes(on)) blockedBy.push(on);
    }
    const criteria = line(card.criteria, MAX_CRITERIA);
    if (criteria === undefined) return { error: `card ${String(number)} needs "criteria": when it is done, 1-${String(MAX_CRITERIA)} characters` };
    const complexity = complexityOf(card.complexity);
    if (complexity === undefined) return { error: `card ${String(number)}: "complexity" must be S, M or L` };
    cards.push({ title: cardTitle, goal, assignee: card.assignee, blockedBy, criteria, complexity });
  }
  return { title, cards };
}

/** The plan of an approval of kind `plan`, or undefined when its detail is not one (purged, or written by hand). */
export function planOf(approval: Pick<StoredApproval, 'kind' | 'detail'>): StoredPlan | undefined {
  if (approval.kind !== 'plan') return undefined;
  const { title, cards, starts } = approval.detail;
  if (typeof title !== 'string' || !Array.isArray(cards) || cards.length === 0) return undefined;
  const parsed: PlannedCard[] = [];
  for (const [index, item] of (cards as unknown[]).entries()) {
    if (typeof item !== 'object' || item === null) return undefined;
    const card = item as Record<string, unknown>;
    const blockedBy = Array.isArray(card.blockedBy) ? (card.blockedBy as unknown[]).filter((on): on is number => typeof on === 'number' && Number.isInteger(on) && on >= 1 && on <= index) : [];
    if (typeof card.title !== 'string' || typeof card.goal !== 'string' || typeof card.assignee !== 'string') return undefined;
    parsed.push({
      title: card.title,
      goal: card.goal,
      assignee: card.assignee,
      blockedBy,
      criteria: typeof card.criteria === 'string' ? card.criteria : '',
      complexity: complexityOf(card.complexity) ?? null,
    });
  }
  const rows = Array.isArray(starts)
    ? (starts as unknown[]).filter((row): row is number => typeof row === 'number' && Number.isInteger(row) && row >= 1 && row <= parsed.length)
    : undefined;
  return { title, cards: parsed, ...(rows === undefined ? {} : { starts: rows }) };
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The detail of an approval of kind plan: the cards as the chat and planOf read them. */
function planDetail(plan: PlanProposal, step: unknown, revision = 0): { [key: string]: Json } {
  return {
    title: plan.title,
    cards: plan.cards.map((card) => ({ ...card, blockedBy: [...card.blockedBy] })),
    ...(typeof step === 'number' ? { step } : {}),
    ...(revision > 0 ? { edited: true, revision } : {}),
  };
}

/** Writes the approval of a plan, at the label of what the step had read; returns its id. */
export async function requestPlan(tx: Queryable, options: { taskId: string; step: number; label: Label; plan: PlanProposal }): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${options.taskId}, 'plan', ${PLAN_ACTION}, ${tx.json(planDetail(options.plan, options.step))}, ${options.label}::privacy_label)
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO approvals returned no row');
  return row.id;
}

/** The pending or decided plan a task proposed at `step`. */
export async function planApprovalAt(sql: Queryable, taskId: string, step: number): Promise<{ id: string; state: string } | undefined> {
  const [row] = await sql<{ id: string; state: string }[]>`
    SELECT id::text, state FROM approvals
    WHERE task_id = ${taskId} AND kind = 'plan' AND (detail ->> 'step')::int = ${step}
    ORDER BY requested_at DESC LIMIT 1`;
  return row;
}

/** «Avvia subito» by default (D-235): the agents' cards that wait for no card. */
export function defaultStarts(plan: PlanProposal): number[] {
  return plan.cards.flatMap((card, index) => (card.assignee !== 'user' && card.blockedBy.length === 0 ? [index + 1] : []));
}

/** The rows to start as the chat sends them: numbers of the agents' cards of the plan, each once. */
export function checkStarts(value: unknown, plan: PlanProposal): number[] {
  if (!Array.isArray(value)) throw new PlanError('invalid', 'starts must be a list of card numbers');
  const rows: number[] = [];
  for (const row of value as unknown[]) {
    if (typeof row !== 'number' || !Number.isInteger(row) || row < 1 || row > plan.cards.length) {
      throw new PlanError('invalid', `starts: ${String(row)} is not a card of the plan (1 to ${String(plan.cards.length)})`);
    }
    if (plan.cards[row - 1]?.assignee === 'user') throw new PlanError('invalid', `starts: card ${String(row)} is yours, it does not start by itself`);
    if (!rows.includes(row)) rows.push(row);
  }
  return rows.sort((a, b) => a - b);
}

/**
 * The rows «Avvia subito» of a plan, written in its detail before the
 * decision and in its transaction (engine.ts): the cards that start are then
 * frozen with the decision, and the answer in the chat names them. `starts`
 * undefined: the default. `revision`, when sent, must be the plan's: a card
 * of the chat still showing an older version of an edited plan is refused
 * (409), so that nothing starts that the user did not see. Nothing for an
 * approval of another kind, which takes neither.
 */
export async function setPlanStarts(tx: Queryable, approvalId: string, decision: PlanDecision = {}): Promise<void> {
  const { starts, revision } = decision;
  const [row] = await tx<{ kind: string; state: string; detail: Record<string, unknown> }[]>`
    SELECT kind, state, detail FROM approvals WHERE id = ${approvalId}::uuid FOR UPDATE`;
  if (row === undefined) return;
  if (row.kind !== 'plan') {
    if (starts !== undefined || revision !== undefined) throw new PlanError('invalid', 'starts are only for a plan');
    return;
  }
  const plan = planOf(row);
  if (plan === undefined || row.state !== 'pending') return;
  if (revision !== undefined && revision !== planRevision(row.detail)) throw new PlanError('conflict', 'the plan changed meanwhile: read it again before deciding');
  const rows = starts === undefined ? defaultStarts(plan) : checkStarts(starts, plan);
  await tx`UPDATE approvals SET detail = detail || ${tx.json({ starts: rows })} WHERE id = ${approvalId}::uuid AND state = 'pending'`;
}

/** Whether a task is the card «Piano» of «/progetta» or its chat task (migration 0072). */
export async function planningOf(sql: Queryable, taskId: string): Promise<'request' | 'card' | undefined> {
  const [row] = await sql<{ planning: 'request' | 'card' | null }[]>`SELECT planning FROM tasks WHERE id = ${taskId}`;
  return row?.planning ?? undefined;
}

/**
 * Where the cards of a plan go: the chat task they are children of and the
 * project. The plan of a card «Piano» (D-235) belongs to the chat of
 * «/progetta», its parent: so its cards show their choices of the model in
 * that chat, as the cards of `task.plan` do (D-159).
 */
async function planHome(tx: Queryable, source: Task): Promise<{ parent: Task; project: string | undefined }> {
  const planning = await planningOf(tx, source.id);
  const parent = planning === 'card' && source.parentId !== null ? ((await loadTask(tx, source.parentId)) ?? source) : source;
  const [conversation] =
    parent.conversationId === null ? [] : await tx<{ workspace: string | null }[]>`SELECT workspace FROM conversations WHERE id = ${parent.conversationId}`;
  const project = conversation?.workspace?.split(':')[0] ?? source.project ?? undefined;
  return { parent, project: project !== undefined && PROJECT_NAME.test(project) ? project : undefined };
}

/**
 * The cards of an approved plan, created in the transaction of the decision
 * (engine.ts): children of the chat task, in its conversation's project (the
 * container before the colon, as `task.create`), at the plan's label, with
 * their dependencies, criteria and complexity, all in the inbox (D-235). The
 * rows «Avvia subito» then go to do with their first step queued. Returns
 * their ids in the plan's order.
 */
export async function applyPlanApproval(tx: Queryable, approval: StoredApproval): Promise<string[]> {
  const plan = planOf(approval);
  if (plan === undefined || approval.taskId === null) return [];
  const source = await loadTask(tx, approval.taskId);
  if (source === undefined) return [];
  const { parent, project } = await planHome(tx, source);
  const ids: string[] = [];
  for (const card of plan.cards) {
    const created = await createTask(tx, {
      ...(project === undefined ? {} : { project }),
      title: card.title,
      goal: card.goal,
      ...(card.criteria === '' ? {} : { doneCriteria: card.criteria }),
      parentId: parent.id,
      label: approval.label,
      clearance: parent.clearance,
      effectiveLabel: approval.label,
      assignee: card.assignee,
      status: 'inbox',
    });
    await tx`UPDATE tasks SET plan_approval_id = ${approval.id}::uuid, complexity = ${card.complexity} WHERE id = ${created.id}`;
    ids.push(created.id);
    for (const on of card.blockedBy) {
      const dependsOn = ids[on - 1];
      if (dependsOn !== undefined) await tx`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${created.id}, ${dependsOn})`;
    }
    await appendEvent(tx, { kind: 'card.changed', taskId: created.id, label: 'L0', payload: { created: true, plan: approval.id } });
  }
  // «Avvia subito» (D-235): as «Avvia», to do with the first step queued; one that waits is held back by the engine (D-152).
  for (const row of plan.starts ?? []) {
    const id = ids[row - 1];
    const card = plan.cards[row - 1];
    if (id === undefined || card === undefined || card.assignee === 'user') continue;
    await moveTask(tx, id, 'ready', { cause: 'user' });
    await enqueueJob(tx, STEP_QUEUE, { taskId: id }, { key: `task:${id}` });
    await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload: { started: true } });
  }
  return ids;
}

/** The fixed notes of a card «Piano» closed by the decision (D-235): code text, no word of the plan. */
export const PLAN_CARD_NOTE = {
  approved: (cards: number) => `Piano approvato: ${String(cards)} card create in Inbox.`,
  rejected: 'Piano non approvato: nessuna card creata.',
} as const;

/**
 * A card «Piano» (D-235) closes with the decision on its plan, as a
 * commitment does: in Fatto, with the approval as its evidence and the
 * outcome as its note. While it waits for this very approval; `fromRun`: or
 * still at work, when the user decided in the moment between the plan
 * written and the card waiting (the engine closes it at the end of that
 * step). True when closed here: the engine has nothing more to run for it.
 */
export async function closePlanningCard(tx: Queryable, approval: StoredApproval, fromRun = false): Promise<boolean> {
  if (approval.kind !== 'plan' || approval.taskId === null || (approval.state !== 'approved' && approval.state !== 'rejected')) return false;
  const [row] = await tx<{ planning: string | null; status: string; waiting: string | null }[]>`
    SELECT planning, status, waiting_approval_id::text AS waiting FROM tasks WHERE id = ${approval.taskId} FOR UPDATE`;
  if (row?.planning !== 'card') return false;
  if (!((row.status === 'waiting_user' && row.waiting === approval.id) || (fromRun && row.status === 'running'))) return false;
  const note = approval.state === 'approved' ? PLAN_CARD_NOTE.approved(planOf(approval)?.cards.length ?? 0) : PLAN_CARD_NOTE.rejected;
  await moveTask(tx, approval.taskId, 'done', { evidence: [{ kind: 'approval', ref: approval.id }], cause: 'approval' });
  await tx`UPDATE tasks SET note = ${note} WHERE id = ${approval.taskId}`;
  await appendEvent(tx, { kind: 'card.changed', taskId: approval.taskId, label: 'L0', payload: { plan: approval.id, state: approval.state } });
  // Arianna says it in the conversation of «/progetta» too, written by the code (D-235): the cards created, or none.
  const plan = planOf(approval);
  const [origin] = await tx<{ conversationId: string }[]>`
    SELECT c.id::text AS "conversationId" FROM tasks card JOIN tasks request ON request.id = card.parent_id JOIN conversations c ON c.id = request.conversation_id
    WHERE card.id = ${approval.taskId} AND c.purged_at IS NULL AND c.archived_at IS NULL`;
  if (plan !== undefined && origin !== undefined) {
    const [line] = await tx<{ id: string }[]>`
      INSERT INTO messages (conversation_id, role, channel, label, body)
      VALUES (${origin.conversationId}, 'assistant', 'web', ${approval.label}::privacy_label, ${planAnswerText(plan, approval.state)})
      RETURNING id::text`;
    if (line === undefined) throw new Error('INSERT INTO messages returned no row');
    await appendEvent(tx, { kind: 'message.created', label: 'L0', payload: { conversationId: origin.conversationId, messageId: line.id, role: 'assistant' } });
  }
  return true;
}

/**
 * The user edits a pending plan in its card (D-235): the proposed cards are
 * replaced, checked again as the model's (no cycle, «bloccata da» only
 * towards earlier cards, assignees among `assignees`). The approval keeps
 * the label of its context (the privacy of the conversation): in a work
 * conversation (a plan within L1) the user's new text passes the scanner of
 * a work conversation's messages, and a text it flags is refused, as the
 * message would be.
 */
export async function editPlan(sql: Sql, approvalId: string, input: Record<string, unknown>, assignees: readonly string[]): Promise<StoredApproval> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ kind: string; state: string; label: Label; detail: Record<string, unknown> }[]>`
      SELECT kind, state, label, detail FROM approvals WHERE id = ${approvalId}::uuid FOR UPDATE`;
    if (row === undefined) throw new PlanError('not-found', 'not found');
    if (row.kind !== 'plan') throw new PlanError('invalid', 'only a plan is edited');
    if (row.state !== 'pending') throw new PlanError('conflict', `the approval is already ${row.state}`);
    const checked = checkPlan(input, assignees);
    if ('error' in checked) throw new PlanError('invalid', checked.error);
    if (isAtMost(row.label, 'L1')) {
      const texts = [checked.title, ...checked.cards.flatMap((card) => [card.title, card.goal, card.criteria])];
      const kinds = [...new Set(texts.flatMap((text) => scanText(text).map((finding) => finding.kind)))];
      if (kinds.length > 0) throw new PlanError('invalid', `a work conversation cannot hold this plan (${kinds.join(', ')}): open a private conversation`);
    }
    await tx`UPDATE approvals SET detail = ${tx.json(planDetail(checked, row.detail.step, planRevision(row.detail) + 1))} WHERE id = ${approvalId}::uuid`;
    // How many cards only: their text stays in the approval.
    await appendEvent(tx, { kind: 'approval.edited', label: 'L0', payload: { approvalId, cards: checked.cards.length } });
    const edited = await loadApproval(tx, approvalId);
    if (edited === undefined) throw new Error('the edited approval is missing');
    return edited;
  });
}

/** The name of who does a card, as the chat writes it. */
export function assigneeText(assignee: string): string {
  if (assignee === 'user') return 'tu';
  return assignee.charAt(0).toUpperCase() + assignee.slice(1);
}

/** Arianna's answer once the user decided a plan, written by the code. */
export function planAnswerText(plan: StoredPlan, state: string): string {
  if (state !== 'approved') return 'Va bene, non ho creato nessuna card.';
  const lines = plan.cards.map((card, index) => {
    const waits = card.blockedBy.length === 0 ? '' : `, aspetta ${card.blockedBy.length === 1 ? 'la' : 'le'} ${card.blockedBy.join(' e ')}`;
    const size = card.complexity === null ? '' : ` · ${card.complexity}`;
    return `${String(index + 1)}. ${card.title} — ${assigneeText(card.assignee)}${size}${waits}`;
  });
  const starts = plan.starts;
  const after =
    starts === undefined
      ? ''
      : starts.length === 0
        ? 'Nessuna parte da sola: avviale dal cardwall quando vuoi.'
        : `Partono subito: ${starts.length === 1 ? 'la' : 'le'} ${starts.join(', ')}; una che aspetta un’altra card parte quando quella è in Fatto.`;
  return `Ho creato ${String(plan.cards.length)} card per «${plan.title}», tutte in Inbox sul cardwall:\n\n${lines.join('\n')}${after === '' ? '' : `\n\n${after}`}`;
}
