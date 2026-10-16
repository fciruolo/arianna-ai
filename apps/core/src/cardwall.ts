import { SKILL_ID } from '@arianna/config';
import { isAtMost, type Label } from '@arianna/policy';

import { addDays, isDay, localDay } from './commitment-dates.ts';
import type { CommitmentStatus } from './commitments.ts';
import { CHAT_AGENT } from './conversations.ts';
import type { Queryable, Sql } from './db/client.ts';
import { resumeTaskIn, retryTaskIn, scheduleTask } from './engine.ts';
import { stopTaskByUser } from './chat-stop.ts';
import { appendEvent } from './events.ts';
import { SLUG } from './git-catalog.ts';
import { nextStep } from './runs.ts';
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

/** The agent whose cards carry a style of Open Design and skills of the catalog (D-163). */
export const DESIGNER_AGENT = 'designer';
/** Most skills chosen on one card (migration 0046). */
export const MAX_CARD_SKILLS = 10;

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
  /**
   * In line behind another card of its project at work (D-235): 1 is the next
   * one to start. Null when it is not waiting for its turn.
   */
  turn: number | null;
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
  queuedJob: string | null;
  queuedAt: Date | null;
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
      (SELECT j.id::text FROM jobs j WHERE j.key = 'task:' || t.id::text AND j.status = 'queued') AS "queuedJob",
      (SELECT j.run_at FROM jobs j WHERE j.key = 'task:' || t.id::text AND j.status = 'queued') AS "queuedAt",
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

  const turns = cardTurns(tasks, dependencies);
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
      turn: turns.get(task.id) ?? null,
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
      turn: null,
      hasBody: false,
      links: 0,
      files: 0,
      checklist: { done: 0, total: 0 },
      updatedAt: item.updatedAt.toISOString(),
    });
  }
  return cards;
}

/**
 * The cards waiting for their turn (D-235): a queued step of an agent's card,
 * free of dependencies, in a project where another card is at work. Numbered
 * in the order the workers take them (the job's time, then its id, as claimStep).
 */
function cardTurns(tasks: readonly TaskRow[], dependencies: readonly DependencyRow[]): Map<string, number> {
  const busy = new Set(tasks.filter((task) => task.status === 'running' && task.assignee !== CHAT_AGENT && task.project !== null).map((task) => task.project));
  const open = new Set(dependencies.filter((row) => row.status !== 'done').map((row) => row.taskId));
  const waiting = tasks
    .filter((task) => task.status === 'ready' && task.queuedJob !== null && task.assignee !== CHAT_AGENT && !open.has(task.id) && busy.has(task.project))
    .sort((a, b) => (a.queuedAt?.getTime() ?? 0) - (b.queuedAt?.getTime() ?? 0) || Number(BigInt(a.queuedJob ?? '0') - BigInt(b.queuedJob ?? '0')));
  const turns = new Map<string, number>();
  const counts = new Map<string | null, number>();
  for (const task of waiting) {
    const next = (counts.get(task.project) ?? 0) + 1;
    counts.set(task.project, next);
    turns.set(task.id, next);
  }
  return turns;
}

/** What the wall may name: the projects of arianna.toml and the agents of the registry. */
export interface CardNames {
  projects: readonly string[];
  agents: readonly string[];
  /**
   * The adopted catalogs (D-163): whether a style of Open Design and a skill
   * are there. Absent, only their form is checked (the run says what is gone).
   */
  catalog?: CardCatalog;
}

/** What the adopted catalogs hold, asked only for a style or a skill newly chosen. */
export interface CardCatalog {
  style(slug: string): boolean;
  skill(id: string): boolean;
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
  /** The slug of a style of Open Design (D-163); only on a Designer card. */
  style?: unknown;
  /** Skills of the catalog, `owner/repo/slug` (D-163); only on a Designer card. */
  skills?: unknown;
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

/** A style of Open Design by its slug, or null for none (D-163). */
function checkStyle(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !SLUG.test(value)) throw new CardError('invalid', 'style must be the slug of a style of the catalog');
  return value;
}

/** Skills of the catalog, each once, in the order chosen (D-163). */
function checkSkills(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new CardError('invalid', 'skills must be a list');
  const skills: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || !SKILL_ID.test(item) || item.split('/')[1] === '.' || item.split('/')[1] === '..') throw new CardError('invalid', 'a skill is <owner>/<repo>/<slug>');
    if (!skills.includes(item)) skills.push(item);
  }
  if (skills.length > MAX_CARD_SKILLS) throw new CardError('invalid', `at most ${String(MAX_CARD_SKILLS)} skills on a card`);
  return skills;
}

/**
 * The style and skills a card will hold (D-163): only on a Designer card,
 * and what is newly chosen must be in the adopted catalogs. What the card
 * already holds stays even when gone from the catalog: the run says so.
 */
function checkDesign(assignee: string, style: string | null, skills: readonly string[], names: CardNames, kept: { style: string | null; skills: readonly string[] }): void {
  if (assignee !== DESIGNER_AGENT && (style !== null || skills.length > 0)) throw new CardError('invalid', 'the style and the skills are only for a card of the Designer');
  if (names.catalog === undefined) return;
  if (style !== null && style !== kept.style && !names.catalog.style(style)) throw new CardError('invalid', 'no such style in the catalog');
  for (const id of skills) if (!kept.skills.includes(id) && !names.catalog.skill(id)) throw new CardError('invalid', 'no such skill in the catalog');
}

/** The style and skills a message of the Studio carries to the Designer (D-184). */
export interface DesignChoice {
  style: string | null;
  skills: string[];
}

/**
 * The style and skills sent with a message of the direct chat with the
 * Designer (I-19, D-184), checked as on a card: the form, at most ten
 * skills, and only what the adopted catalogs hold. Throws `CardError`
 * ('invalid'); undefined when nothing is chosen.
 */
export function checkDesignChoice(input: { style?: unknown; skills?: unknown }, catalog: CardCatalog | undefined): DesignChoice | undefined {
  const style = checkStyle(input.style);
  const skills = checkSkills(input.skills);
  if (style === null && skills.length === 0) return undefined;
  checkDesign(DESIGNER_AGENT, style, skills, { projects: [], agents: [], ...(catalog === undefined ? {} : { catalog }) }, { style: null, skills: [] });
  return { style, skills };
}

/** The style and skills a card holds now (D-163). */
export async function cardDesign(sql: Queryable, id: string): Promise<{ style: string | null; skills: string[] }> {
  const [row] = await sql<{ style: string | null; skills: string[] }[]>`SELECT design_style AS style, design_skills AS skills FROM tasks WHERE id = ${id}`;
  return { style: row?.style ?? null, skills: row?.skills ?? [] };
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
  const style = checkStyle(input.style);
  const skills = checkSkills(input.skills);
  checkDesign(assignee, style, skills, names, { style: null, skills: [] });
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
    // Names of public text (D-163): the card's label stays what it is.
    if (style !== null || skills.length > 0) await tx`UPDATE tasks SET design_style = ${style}, design_skills = ${skills}::text[] WHERE id = ${created.id}`;
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
    await lockPendingApprovals(tx, id);
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

/**
 * Locks the card's pending approvals before the card: the order of
 * recordDecisionIn and dismissWaitingTask (waiting.ts), so that a decision
 * arriving while "Riprendi" expires those approvals waits instead of
 * deadlocking.
 */
async function lockPendingApprovals(tx: Queryable, id: string): Promise<void> {
  await tx`SELECT id FROM approvals WHERE task_id = ${id} AND state = 'pending' ORDER BY id FOR UPDATE`;
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
export async function startCard(sql: Sql, id: string, agents?: readonly string[]): Promise<Task> {
  return sql.begin(async (tx) => startIn(tx, await loadCard(tx, id, true), agents));
}

/** `startCard` on a card the caller has locked. */
async function startIn(tx: Queryable, card: Task, agents?: readonly string[]): Promise<Task> {
  const id = card.id;
  if (card.assignee === 'user') throw new CardError('conflict', 'only the card of an agent starts: your own you do yourself');
  if (card.assignee === CHAT_AGENT) throw new CardError('conflict', 'Arianna does not work on cards from the wall: assign the card to an agent');
  if (agents !== undefined && !agents.includes(card.assignee)) throw new CardError('conflict', `the agent ${card.assignee} no longer exists: assign the card to another one`);
  if (card.status !== 'inbox' && card.status !== 'ready') throw new CardError('conflict', 'only a card still to do starts');
  if (await engineHad(tx, id)) throw new CardError('conflict', 'the card has already started: resume it or retry it');
  const started = card.status === 'ready' ? card : await moveTask(tx, id, 'ready', { cause: 'user' });
  if (!(await scheduleTask(tx, id))) throw new CardError('conflict', 'the card is already at work');
  await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload: { started: true } });
  return started;
}

/**
 * A drag into "In corso" (D-235): the same as "Avvia" for a card never
 * started, "Riprendi" or "Riprova" for one the engine stopped. A card already
 * at work, or with its step queued or held back, is left as it is: dragging
 * it there twice starts nothing more.
 */
export async function runCard(sql: Sql, id: string, agents?: readonly string[]): Promise<Task> {
  return sql.begin(async (tx) => {
    await lockPendingApprovals(tx, id);
    const card = await loadCard(tx, id, true);
    const busy = await tx`SELECT 1 FROM jobs WHERE key = ${`task:${id}`} AND status IN ('queued', 'running')`;
    if (card.status === 'running' || busy.length > 0) return card;
    if (card.waitingApprovalId !== null) throw new CardError('conflict', 'the card waits for a decision: decide it first');
    if (!(await engineHad(tx, id))) {
      if (card.status !== 'inbox' && card.status !== 'ready') throw new CardError('conflict', 'only a card still to do starts');
      return startIn(tx, card, agents);
    }
    if (await isHeld(tx, id)) {
      if (card.status === 'ready') return card;
      throw new CardError('conflict', 'the card waits for another card: it goes on when that one is done');
    }
    if (card.status === 'to_verify') throw new CardError('conflict', 'the card is to verify: send it back with a note');
    if (card.status === 'done') throw new CardError('conflict', 'the card is closed');
    if (agents !== undefined && !agents.includes(card.assignee)) throw new CardError('conflict', `the agent ${card.assignee} no longer exists: assign the card to another one`);
    if (card.status === 'failed' || card.status === 'waiting_user') return goOn(tx, card);
    // To do, had by the engine, nothing queued nor held: its step goes back in the queue.
    if (!(await scheduleTask(tx, id))) throw new CardError('conflict', 'the card is already at work');
    await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload: { started: true } });
    return card.status === 'ready' ? card : moveTask(tx, id, 'ready', { cause: 'user' });
  });
}

/** Longest note of «Rimanda» (migration 0073). */
export const MAX_RETURN_NOTE = 2_000;

/**
 * «Rimanda» (D-235): an agent's card in Da verificare goes back to work with
 * the user's note. The note keeps the label the user chose for it: `L2`
 * (Privato, the default: the card's label goes up to it, so it stays on the
 * local model) or `L1` (Interno: the card may go back to the cloud as it was).
 * The agent reads its earlier report and the note (orchestrator, card-run.ts);
 * an agent that asks where it works asks again.
 */
export async function sendBackCard(sql: Sql, id: string, input: { note?: unknown; label?: unknown }): Promise<Task> {
  const note = checkText(input.note, MAX_RETURN_NOTE, 'note');
  if (note === null) throw new CardError('invalid', 'a card is sent back with a note');
  if (input.label !== undefined && input.label !== 'L1' && input.label !== 'L2') throw new CardError('invalid', 'the label of the note is L1 or L2');
  const label: Label = input.label === 'L1' ? 'L1' : 'L2';
  return sql.begin(async (tx) => {
    await lockPendingApprovals(tx, id);
    const card = await loadCard(tx, id, true);
    if (card.status !== 'to_verify') throw new CardError('conflict', 'only a card to verify is sent back');
    if (card.assignee === 'user' || card.assignee === CHAT_AGENT) throw new CardError('conflict', 'only the card of an agent is sent back');
    if (!(await engineHad(tx, id))) throw new CardError('conflict', 'the card never started: start it');
    // The last step that ended well: the next one reads the note (runs.ts, nextStep).
    const afterStep = (await nextStep(tx, id)) - 1;
    await tx`INSERT INTO card_returns (task_id, after_step, note, label) VALUES (${id}, ${afterStep}, ${note}, ${label}::privacy_label)`;
    // The card may read what it now holds: its clearance goes up with its label (never L3, the tasks' check).
    await tx`
      UPDATE tasks SET label = GREATEST(label, ${label}::privacy_label), clearance = GREATEST(clearance, ${label}::privacy_label), updated_at = now()
      WHERE id = ${id}`;
    try {
      const moved = await moveTask(tx, id, 'ready', { cause: 'user', from: ['to_verify'] });
      if (!(await scheduleTask(tx, id))) throw new CardError('conflict', 'the card is already at work');
      await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload: { sentBack: true } });
      return moved;
    } catch (error) {
      if (error instanceof TaskError) throw new CardError('conflict', error.message);
      throw error;
    }
  });
}

export interface CardStopOptions {
  /** Stops the step of the card a worker is running now (Worker.stopTask, cause `user`); false when none runs it. */
  stopTask: (taskId: string) => boolean;
  pollMs?: number;
  attempts?: number;
}

/**
 * "Ferma" of a card, or a drag out of "In corso" (D-235): its step stops as
 * "Ferma" stops an answer in the chat (D-218). A step still in the queue fails
 * here with its job; one at work stops through its worker, which fails it the
 * same way. The card fails with `engine.user-stopped` and goes on with
 * "Riprova". Returns whether it was at work, and whether it still is.
 */
export async function stopCard(sql: Sql, id: string, options: CardStopOptions): Promise<{ stopped: boolean; left: boolean }> {
  const pollMs = options.pollMs ?? 200;
  const attempts = options.attempts ?? 10;
  let atWork = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await sql.begin(async (tx): Promise<'idle' | 'stopped' | 'running'> => {
      const card = await loadCard(tx, id, true);
      if (card.status !== 'ready' && card.status !== 'running') return 'idle';
      const [job] = await tx<{ id: string }[]>`
        UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = 'user'
        WHERE key = ${`task:${id}`} AND status = 'queued' RETURNING id::text`;
      if (job !== undefined) {
        await stopTaskByUser(tx, id);
        await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload: { stopped: true } });
        return 'stopped';
      }
      const [running] = await tx`SELECT 1 FROM jobs WHERE key = ${`task:${id}`} AND status = 'running'`;
      if (running !== undefined) return 'running';
      // At work with no job (a worker that died meanwhile): it stops here, or it would hold its project for good.
      if (card.status === 'running') {
        await stopTaskByUser(tx, id);
        await appendEvent(tx, { kind: 'card.changed', taskId: id, label: 'L0', payload: { stopped: true } });
        return 'stopped';
      }
      // Ready with nothing queued: never started, nothing to stop.
      return 'idle';
    });
    if (state === 'stopped') return { stopped: true, left: false };
    if (state === 'idle') return { stopped: atWork, left: false };
    atWork = true;
    options.stopTask(id);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { stopped: atWork, left: true };
}

/** "Riprendi" (D-159): a card the engine had, waiting in "Aspetta", goes on; not one that waits for a decision. */
export async function resumeCard(sql: Sql, id: string): Promise<Task> {
  return sql.begin(async (tx) => {
    await lockPendingApprovals(tx, id);
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
    await lockPendingApprovals(tx, id);
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
  style?: unknown;
  skills?: unknown;
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
  const style = 'style' in fields ? checkStyle(fields.style) : undefined;
  const skills = 'skills' in fields ? checkSkills(fields.skills) : undefined;
  const written = title !== undefined || (goal !== undefined && goal !== null) || (criteria !== undefined && criteria !== null);
  return sql.begin(async (tx) => {
    const card = await loadCard(tx, id, true);
    // Who does it changes only before the engine ever had the card: its caps,
    // actions and plan are the assignee's for the whole task.
    if (assignee !== undefined && assignee !== card.assignee && (card.status === 'done' || card.waitingApprovalId !== null || (await engineHad(tx, id)))) {
      throw new CardError('conflict', 'a card already started or done keeps who does it');
    }
    // The style and skills (D-163): kept while the card is the Designer's, taken away when it is no longer.
    const kept = await cardDesign(tx, id);
    const owner = assignee ?? card.assignee;
    const nextStyle = style !== undefined ? style : owner === DESIGNER_AGENT ? kept.style : null;
    const nextSkills = skills ?? (owner === DESIGNER_AGENT ? kept.skills : []);
    checkDesign(owner, style ?? null, skills ?? [], names, kept);
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
        design_style = ${nextStyle},
        design_skills = ${nextSkills}::text[],
        label = CASE WHEN ${written} THEN GREATEST(label, 'L2'::privacy_label) ELSE label END,
        clearance = CASE WHEN ${written} THEN GREATEST(clearance, 'L2'::privacy_label) ELSE clearance END,
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

