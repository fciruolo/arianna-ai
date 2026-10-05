import type { Autonomy } from '@arianna/agents';
import { isAtMost, maxLabel, type Context, type Label } from '@arianna/policy';

import type { Queryable } from '../db/client.ts';
import { appendEvent } from '../events.ts';
import { moveTask, TaskError, type Task } from '../tasks.ts';
import { canMove, type TaskStatus } from '../task-status.ts';

/**
 * `task.update` for the orchestrator (task 1.10, D-101): an agent moves a
 * card and writes a note on it. Which cards: the open ones `task.create` made
 * from a task of the same conversation (for a task without a conversation,
 * from the task itself). Never the task that is running, never a task of a
 * conversation (the engine and the user move those), never a closed card or
 * one in work, never one that waits for an approval.
 *
 * The note is written from the step's context and carries its label: it is
 * refused above the card's clearance, and raises the card's label to it. It
 * stays on this machine, in the database: no gateway, as for a card's title.
 */

/** Statuses an agent may ask for (TOOL_ARGS of task.update). */
export const UPDATE_STATUSES = ['ready', 'waiting_user', 'to_verify'] as const satisfies readonly TaskStatus[];
type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/** A card the agent may still update: neither closed nor in work. */
const OPEN: readonly TaskStatus[] = ['inbox', 'ready', 'waiting_user', 'to_verify'];
/** Shortest id prefix accepted: the local model copies long ids badly. */
export const MIN_PREFIX = 8;
/** How the result of an update that went through starts (the repeat rule reads it, orchestrator.ts). */
export const UPDATED = 'updated card';
/** Most cards listed in an error. */
const MAX_LISTED = 10;
/** Longest title shown in a list of cards. */
const MAX_TITLE = 80;

interface CardRow {
  id: string;
  title: string;
  status: TaskStatus;
  label: Label;
  clearance: Label;
  waitingApprovalId: string | null;
  busy: boolean;
  /** Cause of the last move to waiting_user, from the event log; null if it never waited. */
  waitCause: string | null;
}

export interface CardUpdate {
  text: string;
  /** Highest label of what the text shows (card titles in a list). */
  label: Label;
}

/**
 * The cards `task` may update, oldest first, up to its clearance: a card
 * above it is as if it did not exist. `lock` locks them for the update.
 */
async function cardsOf(sql: Queryable, task: Task, clearance: Label, lock = false): Promise<CardRow[]> {
  return sql<CardRow[]>`
    SELECT c.id::text, c.title, c.status, c.label, c.clearance, c.waiting_approval_id::text AS "waitingApprovalId",
      EXISTS (SELECT FROM jobs j WHERE j.key = 'task:' || c.id::text AND j.status IN ('queued', 'running')) AS busy,
      (SELECT e.payload ->> 'cause' FROM events e
        WHERE e.task_id = c.id AND e.kind = 'task.status' AND e.payload ->> 'to' = 'waiting_user'
        ORDER BY e.id DESC LIMIT 1) AS "waitCause"
    FROM tasks c JOIN tasks p ON p.id = c.parent_id
    WHERE c.conversation_id IS NULL AND c.id <> ${task.id} AND c.label <= ${clearance}::privacy_label
      AND c.status::text = ANY(${sql.array([...OPEN])})
      AND ((${task.conversationId}::uuid IS NULL AND p.id = ${task.id}) OR p.conversation_id = ${task.conversationId}::uuid)
    ORDER BY c.created_at, c.id
    ${lock ? sql`FOR UPDATE OF c` : sql``}`;
}

/** A card the agent can act on now: open (cardsOf), not in work, not waiting for an approval. */
function actionable(card: CardRow): boolean {
  return !card.busy && card.waitingApprovalId === null;
}

/** Whether `task` has a card it can update now. */
export async function hasOpenCards(sql: Queryable, task: Task): Promise<boolean> {
  return (await cardsOf(sql, task, task.clearance)).some(actionable);
}

/**
 * Whether `task.update` is offered in `task`: decided once, at the first
 * step that offers tools, and kept in the event log (`task.offer`), so that
 * the tools, and with them the prompt's prefix in the model's cache (D-075),
 * stay the same for the whole task, also after a restart. A card created
 * during the task is updated by the next one.
 */
export async function updateOffered(sql: Queryable, task: Task): Promise<boolean> {
  const [fixed] = await sql<{ update: boolean }[]>`
    SELECT (payload ->> 'update')::boolean AS update FROM events
    WHERE task_id = ${task.id} AND kind = 'task.offer' ORDER BY id LIMIT 1`;
  if (fixed !== undefined) return fixed.update;
  const update = await hasOpenCards(sql, task);
  await appendEvent(sql, { kind: 'task.offer', taskId: task.id, label: 'L0', payload: { update } });
  return update;
}

function shortTitle(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length <= MAX_TITLE ? line : `${chars.slice(0, MAX_TITLE - 1).join('')}…`;
}

/** The error with the cards the agent can update listed, so that the model can take the right id. */
function notFound(id: string, task: Task, cards: readonly CardRow[], ambiguous = false): CardUpdate {
  const open = cards.filter(actionable).slice(0, MAX_LISTED);
  const where = task.conversationId === null ? 'among the cards of this task' : 'in this conversation';
  // Same text whether the id exists elsewhere or not at all: no oracle on other conversations.
  const head = ambiguous ? `error: task.update: '${id}' names more than one card` : `error: task.update: no open card '${id}' ${where}`;
  if (open.length === 0) return { text: `${head}; there is no open card ${where}`, label: 'L0' };
  const lines = open.map((card) => `- ${card.id} (${card.status}): ${shortTitle(card.title)}`);
  return { text: `${head}. Open cards:\n${lines.join('\n')}`, label: maxLabel(...open.map((card) => card.label)) };
}

function matches(id: string, candidate: string): boolean {
  return candidate === id || (id.length >= MIN_PREFIX && /^[0-9a-f-]+$/.test(id) && candidate.startsWith(id));
}

/**
 * Why `from` → `to` is refused, in a line the model can act on; undefined
 * when allowed. The card statuses' moves (task-status.ts), and autonomy
 * (docs/SPEC.md, cardwall; docs/AGENT-CARDS.md): A0 only proposes, so it
 * moves no card; A1 puts no card in Pronti, except one it put on hold itself
 * (never closing a wait the user or the engine opened).
 */
function refusedMove(card: CardRow, to: UpdateStatus, autonomy: Autonomy): string | undefined {
  if (autonomy === 'A0') return 'with autonomy A0 an agent only proposes: it does not update cards';
  const from = card.status;
  if (from === to) return undefined;
  if (to === 'ready' && autonomy === 'A1' && !(from === 'waiting_user' && card.waitCause === 'agent')) {
    return from === 'waiting_user'
      ? 'this card waits for the user, who put it there or must decide: only the user moves it back to ready'
      : 'with autonomy A1 a card goes to ready only through the user';
  }
  if (!canMove(from, to)) {
    return to === 'to_verify' ? `a card goes to to_verify only from work, and this one is ${from}` : `a card cannot move from ${from} to ${to}`;
  }
  return undefined;
}

export interface UpdateEnv {
  sql: Queryable;
  task: Task;
  context: Context;
  /** Autonomy of the agent that asks. */
  autonomy: Autonomy;
}

/** Runs `task.update`. Inside the transaction of the step's turn. */
export async function updateCard(args: Record<string, unknown>, env: UpdateEnv): Promise<CardUpdate> {
  const { sql, task, context } = env;
  const id = String(args.task_id).trim().toLowerCase();
  const status = String(args.status) as UpdateStatus;
  const note = typeof args.note === 'string' && args.note.trim() !== '' ? args.note.trim() : undefined;
  if (!UPDATE_STATUSES.includes(status)) return { text: `error: task.update: unknown status ${status}`, label: 'L0' };

  if (matches(id, task.id)) {
    return {
      text: 'error: task.update: that is the task you are working on: to ask the user use user.ask, to finish reply',
      label: 'L0',
    };
  }
  const cards = await cardsOf(sql, task, context.clearance, true);
  const found = cards.filter((candidate) => matches(id, candidate.id));
  const card = found.length === 1 ? found[0] : undefined;
  if (card === undefined) return notFound(id, task, cards, found.length > 1);
  if (card.busy) return { text: `error: task.update: card ${card.id} is being worked on`, label: 'L0' };
  if (card.waitingApprovalId !== null) {
    return { text: `error: task.update: card ${card.id} waits for an approval: the user decides it`, label: 'L0' };
  }
  const refused = refusedMove(card, status, env.autonomy);
  if (refused !== undefined) return { text: `error: task.update: ${refused}`, label: 'L0' };
  if (status === 'waiting_user' && note === undefined) {
    return { text: 'error: task.update: waiting_user needs a note: the line the user reads', label: 'L0' };
  }
  if (card.status === status && note === undefined) return { text: `card ${card.id} is already ${status}; nothing changed`, label: 'L0' };

  // The note was written from everything the step has read.
  const noteLabel = context.effective;
  if (note !== undefined && !isAtMost(noteLabel, card.clearance)) {
    return { text: `error: task.update: the note is above what card ${card.id} may hold`, label: 'L0' };
  }

  try {
    if (card.status !== status) {
      await moveTask(sql, card.id, status, { cause: 'agent', ...(note === undefined ? {} : { reason: note }) });
    }
    if (note !== undefined) {
      await sql`
        UPDATE tasks SET
          note = ${note},
          waiting_reason = CASE WHEN status = 'waiting_user' THEN ${note} ELSE waiting_reason END,
          label = GREATEST(label, ${noteLabel}::privacy_label),
          effective_label = GREATEST(effective_label, ${noteLabel}::privacy_label),
          updated_at = now()
        WHERE id = ${card.id}`;
    }
  } catch (error) {
    if (error instanceof TaskError) return { text: `error: task.update: ${error.message}`, label: 'L0' };
    throw error;
  }
  // References only: the note may be L2, the event says that there is one.
  await appendEvent(sql, {
    kind: 'task.updated',
    taskId: card.id,
    label: note === undefined ? 'L0' : noteLabel,
    payload: { by: task.id, from: card.status, to: status, note: note !== undefined },
  });
  const moved = card.status === status ? `still ${status}` : `${card.status} → ${status}`;
  return { text: `${UPDATED} ${card.id}: ${moved}${note === undefined ? '' : ', note saved'}`, label: 'L0' };
}
