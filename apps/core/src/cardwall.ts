import { isAtMost, type Label } from '@arianna/policy';

import { addDays, isDay, localDay } from './commitment-dates.ts';
import type { CommitmentStatus } from './commitments.ts';
import type { Queryable, Sql } from './db/client.ts';
import { resumeTaskIn, retryTaskIn, scheduleTask } from './engine.ts';
import { appendEvent } from './events.ts';
import { createTask, isHeld, loadTask, moveTask, releaseIfFree, TaskError, type Task } from './tasks.ts';
import type { TaskStatus } from './task-status.ts';

/**
 * The cardwall (I-13 tappe C1-C2, D-152): the cards (tasks without a
 * conversation) and the commitments of the secretary (I-12) in one list, each
 * with the column it goes in. The chat groups the columns (five by default,
 * the user can split or hide them): here a card has its precise column.
 * Everything stays on this machine: the web chat is local, and the events
 * carry ids only.
 */

/** Precise columns; the chat groups inbox+ready ("Da fare") and waiting+failed ("Aspetta") by default. */
export const CARD_COLUMNS = ['inbox', 'ready', 'running', 'waiting', 'to_verify', 'done', 'failed'] as const;
export type CardColumn = (typeof CARD_COLUMNS)[number];

/** Closed cards and commitments stay on the wall this many days. */
export const DONE_DAYS = 14;
/** Longest title of a card the user writes. */
export const MAX_CARD_TITLE = 200;
/** Most dependencies of one card. */
export const MAX_DEPENDENCIES = 12;
/** Longest body ("Descrizione") and criteria ("Fatto quando") of a card. */
export const MAX_CARD_BODY = 10_000;
export const MAX_CARD_CRITERIA = 2_000;
/** Priority: 0 none, 1 Bassa, 2 Media, 3 Alta, 4 Altissima (migration 0041). */
export const MAX_PRIORITY = 4;

/** The name of a project as `tasks.project` holds it (the same check as migration 0040). */
export const PROJECT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

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
  /** A task's status, or a commitment's. */
  status: TaskStatus | CommitmentStatus;
  /** The container's name (D-145); null: general. A commitment is always general. */
  project: string | null;
  /** 'user' or an agent; a commitment is the user's. */
  assignee: string;
  /** "YYYY-MM-DD", local day: the card's due day or the commitment's day. */
  due: string | null;
  /** "HH:MM" of a commitment, when said. */
  time: string | null;
  /** Open, and its day is before today. */
  late: boolean;
  label: Label;
  /** Why it waits for the user, or the agent's last note. */
  waitingReason: string | null;
  note: string | null;
  /** Why a commitment was not done or was postponed (D-151). */
  reason: string | null;
  /** The cards it waits for that are not done yet; empty for a commitment. */
  blockedBy: CardRef[];
  /** Every card it depends on, done or not. */
  dependsOn: CardRef[];
  /** 0 none, 1 Bassa, 2 Media, 3 Alta, 4 Altissima; 0 for a commitment. */
  priority: number;
  /** "YYYY-MM-DD": the day the user means to do it ("Data esecuzione"). */
  planned: string | null;
  /** The engine has had it (a run, a step job, a step held back): it keeps who does it, and goes back to do with "Riprendi" or "Riprova" (D-159). */
  started: boolean;
  /** A body or criteria are written. */
  hasBody: boolean;
  links: number;
  files: number;
  checklist: { done: number; total: number };
  updatedAt: string;
}

/** The column of a task: one that waits for another task is in "waiting" until that one is done. */
export function columnOf(status: TaskStatus, blocked: boolean): CardColumn {
  if (blocked && (status === 'inbox' || status === 'ready')) return 'waiting';
  return status === 'waiting_user' ? 'waiting' : status;
}

/** The column of a commitment: open is to do; any other status is closed. */
export function commitmentColumn(status: CommitmentStatus): CardColumn {
  return status === 'open' ? 'ready' : 'done';
}

/**
 * The statuses the user may move a card from, to `to` (a drag on the wall).
 * `running` never: the engine moves a card at work. `to_verify` never: only
 * an agent finishes. `inbox` never: a card enters the inbox at birth. A
 * card waiting for an approval is decided in the chat, not here.
 */
export function userMovesInto(to: TaskStatus): TaskStatus[] {
  switch (to) {
    // Not from to_verify: an agent's work there is closed or failed, never redone by hand.
    case 'ready':
      return ['inbox', 'waiting_user', 'failed'];
    case 'waiting_user':
      return ['inbox', 'ready'];
    case 'done':
      return ['inbox', 'ready', 'waiting_user', 'to_verify'];
    case 'failed':
      return ['inbox', 'ready', 'waiting_user', 'to_verify'];
    default:
      return [];
  }
}

export class CardError extends Error {
  override name = 'CardError';
  readonly code: 'not-found' | 'invalid' | 'conflict';

  constructor(code: 'not-found' | 'invalid' | 'conflict', message: string) {
    super(message);
    this.code = code;
  }
}

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  project: string | null;
  assignee: string;
  dueAt: Date | null;
  label: Label;
  waitingReason: string | null;
  note: string | null;
  priority: number;
  planned: string | null;
  started: boolean;
  hasBody: boolean;
  links: number;
  files: number;
  checkDone: number;
  checkTotal: number;
  updatedAt: Date;
}

interface DependencyRow {
  taskId: string;
  id: string;
  title: string;
  status: TaskStatus;
}

interface CommitmentRow {
  id: string;
  body: string;
  day: string;
  time: string | null;
  status: CommitmentStatus;
  reason: string | null;
  label: Label;
  updatedAt: Date;
}

/**
 * The wall: every open card and commitment, and those closed in the last
 * DONE_DAYS days (a postponed commitment has its successor on the wall).
 */
export async function listCards(sql: Queryable, today: string = localDay()): Promise<Card[]> {
  const since = addDays(today, -DONE_DAYS);
  const tasks = await sql<TaskRow[]>`
    SELECT t.id::text, t.title, t.status, t.project, t.assignee, t.due_at AS "dueAt", t.label, t.waiting_reason AS "waitingReason", t.note,
      t.priority, t.planned_on::text AS planned, ${startedSql(sql)} AS started,
      (t.goal IS NOT NULL OR t.done_criteria IS NOT NULL) AS "hasBody",
      (SELECT count(*)::int FROM card_links l WHERE l.task_id = t.id AND l.removed_at IS NULL) AS links,
      (SELECT count(*)::int FROM card_files f WHERE f.task_id = t.id AND f.removed_at IS NULL) AS files,
      (SELECT count(*)::int FROM card_checklist c WHERE c.task_id = t.id AND c.removed_at IS NULL AND c.done) AS "checkDone",
      (SELECT count(*)::int FROM card_checklist c WHERE c.task_id = t.id AND c.removed_at IS NULL) AS "checkTotal",
      t.updated_at AS "updatedAt"
    FROM tasks t
    WHERE t.conversation_id IS NULL AND (t.status NOT IN ('done', 'failed') OR t.updated_at >= ${since}::date)
    ORDER BY t.created_at, t.id`;
  const ids = tasks.map((task) => task.id);
  const dependencies =
    ids.length === 0
      ? []
      : await sql<DependencyRow[]>`
          SELECT d.task_id::text AS "taskId", t.id::text, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on
          WHERE d.task_id = ANY (${ids}::uuid[]) AND d.removed_at IS NULL ORDER BY d.created_at, d.id`;
  const commitments = await sql<CommitmentRow[]>`
    SELECT id::text, body, day::text AS day, to_char(at_time, 'HH24:MI') AS time, status, reason, label, updated_at AS "updatedAt"
    FROM commitments
    WHERE status = 'open' OR (status <> 'cancelled' AND day >= ${since}::date)
    ORDER BY day, at_time NULLS LAST, created_at, id`;

  const cards: Card[] = tasks.map((task) => {
    const dependsOn = dependencies.filter((row) => row.taskId === task.id).map(({ id, title, status }) => ({ id, title, status }));
    const blockedBy = dependsOn.filter((ref) => ref.status !== 'done');
    const due = task.dueAt === null ? null : localDay(task.dueAt);
    return {
      kind: 'task',
      id: task.id,
      title: task.title,
      column: columnOf(task.status, blockedBy.length > 0),
      status: task.status,
      project: task.project,
      assignee: task.assignee,
      due,
      time: null,
      late: due !== null && due < today && task.status !== 'done' && task.status !== 'failed',
      label: task.label,
      waitingReason: task.waitingReason,
      note: task.note,
      reason: null,
      blockedBy,
      dependsOn,
      priority: task.priority,
      planned: task.planned,
      started: task.started,
      hasBody: task.hasBody,
      links: task.links,
      files: task.files,
      checklist: { done: task.checkDone, total: task.checkTotal },
      updatedAt: task.updatedAt.toISOString(),
    };
  });
  for (const item of commitments) {
    cards.push({
      kind: 'commitment',
      id: item.id,
      title: item.body,
      column: commitmentColumn(item.status),
      status: item.status,
      project: null,
      assignee: 'user',
      due: item.day,
      time: item.time,
      late: item.status === 'open' && item.day < today,
      label: item.label,
      waitingReason: null,
      note: null,
      reason: item.reason,
      blockedBy: [],
      dependsOn: [],
      priority: 0,
      planned: null,
      started: false,
      hasBody: false,
      links: 0,
      files: 0,
      checklist: { done: 0, total: 0 },
      updatedAt: item.updatedAt.toISOString(),
    });
  }
  return cards;
}

/** What the wall may name: the projects of arianna.toml and the agents of the registry. */
export interface CardNames {
  projects: readonly string[];
  agents: readonly string[];
}

/** As it comes from the chat: every field is checked. `due` is "YYYY-MM-DD". */
export interface NewCard {
  title?: unknown;
  project?: unknown;
  assignee?: unknown;
  due?: unknown;
  goal?: unknown;
  criteria?: unknown;
  priority?: unknown;
  planned?: unknown;
}

function checkTitle(value: unknown): string {
  if (typeof value !== 'string') throw new CardError('invalid', 'title must be text');
  const title = value.replace(/\s+/g, ' ').trim();
  if (title === '' || Array.from(title).length > MAX_CARD_TITLE) throw new CardError('invalid', `title must be 1-${String(MAX_CARD_TITLE)} characters`);
  return title;
}

function checkProject(value: unknown, names: CardNames): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !PROJECT_NAME.test(value) || !names.projects.includes(value)) throw new CardError('invalid', 'unknown project');
  return value;
}

function checkAssignee(value: unknown, names: CardNames): string {
  if (value === undefined || value === 'user') return 'user';
  if (typeof value !== 'string' || !names.agents.includes(value)) throw new CardError('invalid', 'unknown assignee');
  return value;
}

/** A text of the user's, or null when empty. */
function checkText(value: unknown, max: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new CardError('invalid', `${field} must be text`);
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (Array.from(text).length > max) throw new CardError('invalid', `${field} is longer than ${String(max)} characters`);
  return text === '' ? null : text;
}

function checkPriority(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_PRIORITY) throw new CardError('invalid', 'priority must be 0-4');
  return value;
}

function checkDay(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !isDay(value)) throw new CardError('invalid', `${field} must be YYYY-MM-DD`);
  return value;
}

/** The engine has had the task (engineHad), as an SQL expression on `t`. */
function startedSql(sql: Queryable) {
  return sql`(EXISTS (SELECT FROM runs r WHERE r.task_id = t.id)
    OR EXISTS (SELECT FROM jobs j WHERE j.key = 'task:' || t.id::text)
    OR EXISTS (SELECT FROM events e WHERE e.task_id = t.id AND e.kind = 'task.blocked'))`;
}

/** A local day as the timestamp stored in `due_at`: its midnight on this machine. */
function dueAtOf(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !isDay(value)) throw new CardError('invalid', 'due must be YYYY-MM-DD');
  return new Date(`${value}T00:00:00`);
}

/**
 * A card the user writes on the wall: in the inbox, private by default (L2,
 * default-deny: the title is the user's text), no conversation, no step
 * queued. Assigned to an agent, it starts only when something runs it.
 */
export async function createCard(sql: Sql, input: NewCard, names: CardNames): Promise<Task> {
  const title = checkTitle(input.title);
  const project = checkProject(input.project, names);
  const assignee = checkAssignee(input.assignee, names);
  const dueAt = dueAtOf(input.due);
  const goal = checkText(input.goal, MAX_CARD_BODY, 'goal');
  const criteria = checkText(input.criteria, MAX_CARD_CRITERIA, 'criteria');
  const priority = checkPriority(input.priority);
  const planned = checkDay(input.planned, 'planned');
  return sql.begin(async (tx) => {
    const created = await createTask(tx, {
      title,
      assignee,
      status: 'inbox',
      label: 'L2',
      clearance: 'L2',
      ...(goal === null ? {} : { goal }),
      ...(criteria === null ? {} : { doneCriteria: criteria }),
      ...(project === null ? {} : { project }),
      ...(dueAt === null ? {} : { dueAt }),
    });
    if (priority !== 0 || planned !== null) await tx`UPDATE tasks SET priority = ${priority}, planned_on = ${planned}::date WHERE id = ${created.id}`;
    await appendEvent(tx, { kind: 'card.changed', taskId: created.id, label: 'L0', payload: { created: true } });
    return created;
  });
}

export async function loadCard(sql: Queryable, id: string, lock = false): Promise<Task> {
  const rows = await sql<{ id: string }[]>`
    SELECT id::text FROM tasks WHERE id = ${id} AND conversation_id IS NULL ${lock ? sql`FOR UPDATE` : sql``}`;
  const task = rows.length === 1 ? await loadTask(sql, id) : undefined;
  if (task === undefined) throw new CardError('not-found', 'no such card');
  return task;
}

/**
 * Whether the engine has ever had the card: a run, a step job (queued, at
 * work or done) or a step held back for a dependency. Such a card goes on
 * from the chat ("Attende te": riprendi, riprova), not from the wall.
 */
export async function engineHad(sql: Queryable, id: string): Promise<boolean> {
  const [row] = await sql<{ had: boolean }[]>`
    SELECT EXISTS (SELECT FROM runs WHERE task_id = ${id})
      OR EXISTS (SELECT FROM jobs WHERE key = ${`task:${id}`})
      OR EXISTS (SELECT FROM events WHERE task_id = ${id} AND kind = 'task.blocked') AS had`;
  return row?.had === true;
}

/** The fixed reason of a card put on hold by hand. */
export const HAND_WAIT = 'Messa in attesa a mano.';

/** A drag on the wall: the user moves a card (userMovesInto). */
export async function moveCard(sql: Sql, id: string, to: unknown, reason?: unknown): Promise<Task> {
  if (to !== 'ready' && to !== 'waiting_user' && to !== 'done' && to !== 'failed') throw new CardError('invalid', 'unknown column');
  return sql.begin(async (tx) => {
    const card = await loadCard(tx, id, true);
    if (card.status === to) return card;
    if (!userMovesInto(to).includes(card.status)) throw new CardError('conflict', `a card cannot move from ${card.status} to ${to} by hand`);
    if (card.waitingApprovalId !== null) throw new CardError('conflict', 'the card waits for a decision: decide it in the chat');
    const busy = await tx`SELECT 1 FROM jobs WHERE key = ${`task:${id}`} AND status IN ('queued', 'running')`;
    if (busy.length > 0) throw new CardError('conflict', 'the card is at work');
    if (to === 'done' && card.assignee !== 'user' && card.status !== 'to_verify') {
      throw new CardError('conflict', "an agent's card is done only from Da verificare, with its evidence");
    }
    // Back to do: a card the engine stopped goes on as "Riprendi" or
    // "Riprova" do (D-159), its pending approvals closed and its step queued
    // (engine.ts). A step held back for a dependency goes on below instead.
    if (to === 'ready' && (card.status === 'waiting_user' || card.status === 'failed') && (await engineHad(tx, id)) && !(await isHeld(tx, id))) {
      return goOn(tx, card);
    }
    // The user's own words are private (L2, default-deny): kept only on a card that is already L2.
    const own = typeof reason === 'string' && reason.trim() !== '' && !isAtMost(card.label, 'L1') ? reason.trim().slice(0, 300) : undefined;
    try {
      const moved = await moveTask(tx, id, to, { cause: 'user', from: userMovesInto(to), ...(to === 'waiting_user' ? { reason: own ?? HAND_WAIT } : {}) });
      // A step held back and put on hold by hand goes on once back, if nothing is missing.
      if (to === 'ready') await releaseIfFree(tx, [id]);
      return moved;
    } catch (error) {
      if (error instanceof TaskError) throw new CardError('conflict', error.message);
      throw error;
    }
  });
}

/** "Riprendi" or "Riprova" of a card the engine had and stopped (D-159): the same task goes on. */
async function goOn(tx: Queryable, card: Task): Promise<Task> {
  try {
    return card.status === 'failed' ? await retryTaskIn(tx, card.id) : await resumeTaskIn(tx, card.id);
  } catch (error) {
    if (error instanceof TaskError) throw new CardError('conflict', error.message);
    throw error;
  }
}

/**
 * "Avvia" (D-159): a card of an agent that the engine never had goes to do and
 * its first step is queued. One that waits for another card is held back by
 * the engine until that one is done (D-152).
 */
export async function startCard(sql: Sql, id: string): Promise<Task> {
  return sql.begin(async (tx) => {
    const card = await loadCard(tx, id, true);
    if (card.assignee === 'user') throw new CardError('conflict', 'only the card of an agent starts: your own you do yourself');
    if (card.status !== 'inbox' && card.status !== 'ready') throw new CardError('conflict', 'only a card still to do starts');
    if (await engineHad(tx, id)) throw new CardError('conflict', 'the card has already started: resume it or retry it');
    const started = card.status === 'ready' ? card : await moveTask(tx, id, 'ready', { cause: 'user' });
    if (!(await scheduleTask(tx, id))) throw new CardError('conflict', 'the card is already at work');
    await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload: { started: true } });
    return started;
  });
}

/** "Riprendi" (D-159): a card the engine had, waiting in "Aspetta", goes on; not one that waits for a decision. */
export async function resumeCard(sql: Sql, id: string): Promise<Task> {
  return sql.begin(async (tx) => {
    const card = await loadCard(tx, id, true);
    if (card.status !== 'waiting_user') throw new CardError('conflict', 'only a card in Aspetta resumes');
    if (card.waitingApprovalId !== null) throw new CardError('conflict', 'the card waits for a decision: decide it first');
    if (!(await engineHad(tx, id))) throw new CardError('conflict', 'the card never started: move it to Da fare, or start it');
    if (await isHeld(tx, id)) throw new CardError('conflict', 'the card waits for another card: it goes on when that one is done');
    const busy = await tx`SELECT 1 FROM jobs WHERE key = ${`task:${id}`} AND status IN ('queued', 'running')`;
    if (busy.length > 0) throw new CardError('conflict', 'the card is at work');
    return goOn(tx, card);
  });
}

/** "Riprova" (D-159): a failed card the engine had runs again from the step that failed. */
export async function retryCard(sql: Sql, id: string): Promise<Task> {
  return sql.begin(async (tx) => {
    const card = await loadCard(tx, id, true);
    if (card.status !== 'failed') throw new CardError('conflict', 'only a failed card is retried');
    if (!(await engineHad(tx, id))) throw new CardError('conflict', 'the card never started: move it to Da fare, or start it');
    return goOn(tx, card);
  });
}

export interface CardFields {
  title?: unknown;
  project?: unknown;
  assignee?: unknown;
  due?: unknown;
  goal?: unknown;
  criteria?: unknown;
  priority?: unknown;
  planned?: unknown;
}

/**
 * What the user changes on a card. A text written by the user (title, body,
 * criteria) is private (L2, default-deny): the card's label goes up to it,
 * never down.
 */
export async function updateCard(sql: Sql, id: string, fields: CardFields, names: CardNames): Promise<Task> {
  const title = 'title' in fields ? checkTitle(fields.title) : undefined;
  const project = 'project' in fields ? checkProject(fields.project, names) : undefined;
  const assignee = 'assignee' in fields ? checkAssignee(fields.assignee, names) : undefined;
  const dueAt = 'due' in fields ? dueAtOf(fields.due) : undefined;
  const goal = 'goal' in fields ? checkText(fields.goal, MAX_CARD_BODY, 'goal') : undefined;
  const criteria = 'criteria' in fields ? checkText(fields.criteria, MAX_CARD_CRITERIA, 'criteria') : undefined;
  const priority = 'priority' in fields ? checkPriority(fields.priority) : undefined;
  const planned = 'planned' in fields ? checkDay(fields.planned, 'planned') : undefined;
  const written = title !== undefined || (goal !== undefined && goal !== null) || (criteria !== undefined && criteria !== null);
  return sql.begin(async (tx) => {
    const card = await loadCard(tx, id, true);
    // Who does it changes only before the engine ever had the card: its caps,
    // actions and plan are the assignee's for the whole task.
    if (assignee !== undefined && assignee !== card.assignee && (card.status === 'done' || card.waitingApprovalId !== null || (await engineHad(tx, id)))) {
      throw new CardError('conflict', 'a card already started or done keeps who does it');
    }
    await tx`
      UPDATE tasks SET
        project = ${project === undefined ? card.project : project},
        assignee = ${assignee ?? card.assignee},
        due_at = ${dueAt === undefined ? card.dueAt : dueAt},
        title = ${title ?? card.title},
        goal = ${goal === undefined ? card.goal : goal},
        done_criteria = ${criteria === undefined ? card.doneCriteria : criteria},
        priority = ${priority ?? card.priority},
        planned_on = ${planned === undefined ? card.plannedOn : planned}::date,
        label = CASE WHEN ${written} THEN GREATEST(label, 'L2'::privacy_label) ELSE label END,
        updated_at = now()
      WHERE id = ${id}`;
    await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload: { fields: Object.keys(fields) } });
    return (await loadTask(tx, id)) as Task;
  });
}

/** "Aspetta": `id` waits for `on` to be done. Between cards, no cycle (the database checks). */
export async function addDependency(sql: Sql, id: string, on: string): Promise<void> {
  if (id === on) throw new CardError('invalid', 'a card cannot wait for itself');
  await sql.begin(async (tx) => {
    const card = await loadCard(tx, id, true);
    await loadCard(tx, on);
    // Only a card that has not started: one at work or further on would not wait anyway.
    if (card.status !== 'inbox' && card.status !== 'ready') throw new CardError('conflict', 'only a card still to do waits for another one');
    const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM task_dependencies WHERE task_id = ${id} AND removed_at IS NULL`;
    if ((count?.n ?? 0) >= MAX_DEPENDENCIES) throw new CardError('conflict', `a card waits for ${String(MAX_DEPENDENCIES)} cards at most`);
    const exists = await tx`SELECT 1 FROM task_dependencies WHERE task_id = ${id} AND depends_on = ${on} AND removed_at IS NULL`;
    if (exists.length > 0) return;
    try {
      await tx.savepoint((inner) => inner`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${id}, ${on})`);
    } catch (error) {
      if (error instanceof Error && /a cycle/.test(error.message)) throw new CardError('conflict', 'the two cards would wait for each other');
      throw error;
    }
    await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload: { dependsOn: on } });
  });
}

/** Takes a dependency away; a step held back for it goes on if nothing else is missing. */
export async function removeDependency(sql: Sql, id: string, on: string): Promise<void> {
  await sql.begin(async (tx) => {
    await loadCard(tx, id, true);
    const removed = await tx`
      UPDATE task_dependencies SET removed_at = now() WHERE task_id = ${id} AND depends_on = ${on} AND removed_at IS NULL RETURNING id`;
    if (removed.length === 0) throw new CardError('not-found', 'no such dependency');
    await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload: { removedDependency: on } });
    await releaseIfFree(tx, [id]);
  });
}

