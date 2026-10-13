import { MAX_PLAN_CARDS, MIN_PLAN_CARDS } from '@arianna/agents';
import type { Label } from '@arianna/policy';

import type { StoredApproval } from './approvals.ts';
import { PROJECT_NAME } from './cardwall.ts';
import type { Queryable } from './db/client.ts';
import { appendEvent } from './events.ts';
import { enqueueJob } from './jobs.ts';
import { createTask, loadTask, STEP_QUEUE } from './tasks.ts';

/**
 * The plans of Arianna (I-13 tappa C3, D-159): `task.plan` proposes cards with
 * their dependencies, and nothing is created until the user approves the plan
 * in the web chat (an approval of kind `plan`, the cards in its detail). In
 * the transaction of the decision the core creates them as children of the
 * chat task: the user's in the inbox, an agent's ready with its first step
 * queued (approving the plan is the consent to start them); one that waits
 * for another card is held back by the engine until that one is done (D-152).
 * Everything stays on this machine: the events carry ids only.
 */

export interface PlannedCard {
  title: string;
  goal: string;
  /** 'user' or the name of an agent. */
  assignee: string;
  /** The earlier cards of the plan it waits for, by their number (1 is the first). */
  blockedBy: number[];
}

export interface PlanProposal {
  title: string;
  cards: PlannedCard[];
}

/** The action of an approval of kind `plan` (migration 0045). */
export const PLAN_ACTION = 'task.plan';

const MAX_TITLE = 120;
const MAX_GOAL = 500;

function line(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' || Array.from(text).length > max ? undefined : text;
}

/**
 * The plan in the arguments of `task.plan`, checked again here (the server may
 * not constrain decoding): a title, 2 to 8 cards, each done by one of
 * `assignees` and waiting only for earlier cards of the plan, once each, so
 * that the plan never has a cycle. An error is for the model to read.
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
    cards.push({ title: cardTitle, goal, assignee: card.assignee, blockedBy });
  }
  return { title, cards };
}

/** The plan of an approval of kind `plan`, or undefined when its detail is not one (purged, or written by hand). */
export function planOf(approval: Pick<StoredApproval, 'kind' | 'detail'>): PlanProposal | undefined {
  if (approval.kind !== 'plan') return undefined;
  const { title, cards } = approval.detail;
  if (typeof title !== 'string' || !Array.isArray(cards) || cards.length === 0) return undefined;
  const parsed: PlannedCard[] = [];
  for (const [index, item] of (cards as unknown[]).entries()) {
    if (typeof item !== 'object' || item === null) return undefined;
    const card = item as Record<string, unknown>;
    const blockedBy = Array.isArray(card.blockedBy) ? (card.blockedBy as unknown[]).filter((on): on is number => typeof on === 'number' && Number.isInteger(on) && on >= 1 && on <= index) : [];
    if (typeof card.title !== 'string' || typeof card.goal !== 'string' || typeof card.assignee !== 'string') return undefined;
    parsed.push({ title: card.title, goal: card.goal, assignee: card.assignee, blockedBy });
  }
  return { title, cards: parsed };
}

/** Writes the approval of a plan, at the label of what the step had read; returns its id. */
export async function requestPlan(tx: Queryable, options: { taskId: string; step: number; label: Label; plan: PlanProposal }): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${options.taskId}, 'plan', ${PLAN_ACTION}, ${tx.json({ title: options.plan.title, cards: options.plan.cards.map((card) => ({ ...card })), step: options.step })}, ${options.label}::privacy_label)
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

/**
 * The cards of an approved plan, created in the transaction of the decision
 * (engine.ts): children of the chat task, in its conversation's project (the
 * container before the colon, as `task.create`), at the plan's label, with
 * their dependencies. Returns their ids in the plan's order.
 */
export async function applyPlanApproval(tx: Queryable, approval: StoredApproval): Promise<string[]> {
  const plan = planOf(approval);
  if (plan === undefined || approval.taskId === null) return [];
  const parent = await loadTask(tx, approval.taskId);
  if (parent === undefined) return [];
  const [conversation] =
    parent.conversationId === null ? [] : await tx<{ workspace: string | null }[]>`SELECT workspace FROM conversations WHERE id = ${parent.conversationId}`;
  const project = conversation?.workspace?.split(':')[0];
  const ids: string[] = [];
  for (const card of plan.cards) {
    const created = await createTask(tx, {
      ...(project !== undefined && PROJECT_NAME.test(project) ? { project } : {}),
      title: card.title,
      goal: card.goal,
      parentId: parent.id,
      label: approval.label,
      clearance: parent.clearance,
      effectiveLabel: approval.label,
      assignee: card.assignee,
      status: card.assignee === 'user' ? 'inbox' : 'ready',
    });
    ids.push(created.id);
    for (const on of card.blockedBy) {
      const dependsOn = ids[on - 1];
      if (dependsOn !== undefined) await tx`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${created.id}, ${dependsOn})`;
    }
    await appendEvent(tx, { kind: 'card.changed', taskId: created.id, label: 'L0', payload: { created: true, plan: approval.id } });
  }
  // The agents' cards start: a card that waits is held back by the engine until its dependency is done (D-152).
  for (const [index, card] of plan.cards.entries()) {
    const id = ids[index];
    if (card.assignee !== 'user' && id !== undefined) await enqueueJob(tx, STEP_QUEUE, { taskId: id }, { key: `task:${id}` });
  }
  return ids;
}

/** The name of who does a card, as the chat writes it. */
export function assigneeText(assignee: string): string {
  if (assignee === 'user') return 'tu';
  return assignee.charAt(0).toUpperCase() + assignee.slice(1);
}

/** Arianna's answer once the user decided a plan, written by the code. */
export function planAnswerText(plan: PlanProposal, state: string): string {
  if (state !== 'approved') return 'Va bene, non ho creato nessuna card.';
  const lines = plan.cards.map((card, index) => {
    const waits = card.blockedBy.length === 0 ? '' : `, aspetta ${card.blockedBy.length === 1 ? 'la' : 'le'} ${card.blockedBy.join(' e ')}`;
    return `${String(index + 1)}. ${card.title} — ${assigneeText(card.assignee)}${waits}`;
  });
  const agents = plan.cards.some((card) => card.assignee !== 'user');
  const mine = plan.cards.some((card) => card.assignee === 'user');
  const after = [
    ...(agents ? ['Le card degli agenti partono da sole appena non aspettano più nulla.'] : []),
    ...(mine ? ['Le tue sono in Da fare sul cardwall.'] : []),
  ].join(' ');
  return `Ho creato ${String(plan.cards.length)} card per «${plan.title}»:\n\n${lines.join('\n')}${after === '' ? '' : `\n\n${after}`}`;
}
