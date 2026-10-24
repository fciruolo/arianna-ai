import { isAtMost, maxLabel, type Label } from '@arianna/policy';

import type { StoredApproval } from './approvals.ts';
import { CardError, DONE_DAYS, PROJECT_NAME } from './cardwall.ts';
import { addDays, isDay, localDay } from './commitment-dates.ts';
import { secretaryConversationId } from './commitments.ts';
import { isUuid } from './conversations.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';

/**
 * The milestones of a project on the cardwall (D-313): a group of cards of
 * one project, in an order, with a title, what "fatta" means, a due day and
 * «bloccata da» another milestone of the same project. The wall shows them as
 * bands of the columns. The closing is never automatic: when every card of an
 * open milestone is done, the core asks in the secretary conversation (a
 * message written here and an approval of kind `milestone`); with «No» it does
 * not ask again until the cards change. Titles and descriptions are the
 * user's words: at least the project's label, Privato (L2) when written by
 * hand, and never above L2 (the secretary conversation holds them). Nothing of
 * a milestone goes to the cloud; the notices carry a kind, never a text.
 */

export const MAX_MILESTONE_TITLE = 200;
export const MAX_MILESTONE_DESCRIPTION = 2_000;
/** Most milestones a milestone waits for. */
export const MAX_MILESTONE_DEPENDENCIES = 12;
/** Most open milestones of one project. */
export const MAX_OPEN_MILESTONES = 50;
/** The label of a text the user writes by hand (default-deny, D-152). */
const HAND_LABEL: Label = 'L2';
/** The secretary conversation is private: every message of the closing is at least L2. */
const CLOSING_LABEL: Label = 'L2';
export const MILESTONE_CLOSE = 'milestone.close';

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
  /** "YYYY-MM-DD", or null. */
  due: string | null;
  /** Open, and its due day is before today. */
  late: boolean;
  position: number;
  label: Label;
  status: 'open' | 'closed';
  closedAt: string | null;
  /** Its cards: how many, and how many are done. */
  cards: { done: number; total: number };
  /** Every milestone it waits for, open or closed. */
  dependsOn: MilestoneRef[];
  /** Those still open: «bloccata da …». */
  blockedBy: MilestoneRef[];
  /** The pending approval that asks to close it, if any. */
  proposal: string | null;
}

/** What a milestone may name: the projects of arianna.toml with their label. */
export interface MilestoneNames {
  projects: readonly { name: string; label: Label }[];
}

interface MilestoneRow {
  id: string;
  project: string;
  title: string;
  description: string | null;
  due: string | null;
  position: number;
  label: Label;
  status: 'open' | 'closed';
  closedAt: Date | null;
  total: number;
  done: number;
  proposal: string | null;
}

function columns(sql: Queryable) {
  return sql`m.id::text, m.project, m.title, m.description, m.due_on::text AS due, m.position, m.label, m.status, m.closed_at AS "closedAt",
    (SELECT count(*)::int FROM tasks t WHERE t.milestone_id = m.id) AS total,
    (SELECT count(*)::int FROM tasks t WHERE t.milestone_id = m.id AND t.status = 'done') AS done,
    (SELECT a.id::text FROM approvals a WHERE a.kind = 'milestone' AND a.state = 'pending' AND a.detail ->> 'milestoneId' = m.id::text) AS proposal`;
}

/**
 * The milestones the wall shows: the open ones, those closed in the last
 * DONE_DAYS days, and any one a card on the wall still names (`named`).
 */
export async function listMilestones(sql: Queryable, named: readonly string[] = [], today: string = localDay()): Promise<Milestone[]> {
  const since = addDays(today, -DONE_DAYS);
  const rows = await sql<MilestoneRow[]>`
    SELECT ${columns(sql)} FROM milestones m
    WHERE m.status = 'open' OR m.closed_at >= ${since}::date OR m.id = ANY (${named}::uuid[])
    ORDER BY m.project, m.position, m.created_at, m.id`;
  const ids = rows.map((row) => row.id);
  const dependencies =
    ids.length === 0
      ? []
      : await sql<{ milestoneId: string; id: string; title: string; status: 'open' | 'closed' }[]>`
          SELECT d.milestone_id::text AS "milestoneId", m.id::text, m.title, m.status FROM milestone_dependencies d JOIN milestones m ON m.id = d.depends_on
          WHERE d.milestone_id = ANY (${ids}::uuid[]) AND d.removed_at IS NULL ORDER BY m.position, m.created_at, m.id`;
  return rows.map((row) => {
    const dependsOn = dependencies.filter((item) => item.milestoneId === row.id).map(({ id, title, status }) => ({ id, title, status }));
    return {
      id: row.id,
      project: row.project,
      title: row.title,
      description: row.description,
      due: row.due,
      late: row.status === 'open' && row.due !== null && row.due < today,
      position: row.position,
      label: row.label,
      status: row.status,
      closedAt: row.closedAt?.toISOString() ?? null,
      cards: { done: row.done, total: row.total },
      dependsOn,
      blockedBy: dependsOn.filter((item) => item.status === 'open'),
      proposal: row.proposal,
    };
  });
}

export interface NewMilestone {
  project?: unknown;
  title?: unknown;
  description?: unknown;
  due?: unknown;
}

function checkTitle(value: unknown): string {
  if (typeof value !== 'string') throw new CardError('invalid', 'title must be text');
  const title = value.replace(/\s+/g, ' ').trim();
  if (title === '' || Array.from(title).length > MAX_MILESTONE_TITLE) throw new CardError('invalid', `title must be 1-${String(MAX_MILESTONE_TITLE)} characters`);
  return title;
}

function checkDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new CardError('invalid', 'description must be text');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (Array.from(text).length > MAX_MILESTONE_DESCRIPTION) throw new CardError('invalid', `description is longer than ${String(MAX_MILESTONE_DESCRIPTION)} characters`);
  return text === '' ? null : text;
}

function checkDue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !isDay(value)) throw new CardError('invalid', 'due must be YYYY-MM-DD');
  return value;
}

/**
 * The label of a milestone: the label of its words (Privato when the user
 * writes them by hand) and never below its project's.
 */
export function milestoneLabel(project: string, names: MilestoneNames, written: Label = HAND_LABEL): Label {
  const own = names.projects.find((item) => item.name === project)?.label ?? HAND_LABEL;
  return maxLabel(written, own);
}

/** A milestone the user writes on the wall: open, last in its project's order. */
export async function createMilestone(sql: Sql, input: NewMilestone, names: MilestoneNames): Promise<{ id: string }> {
  const project = input.project;
  if (typeof project !== 'string' || !PROJECT_NAME.test(project) || !names.projects.some((item) => item.name === project)) throw new CardError('invalid', 'unknown project');
  const title = checkTitle(input.title);
  const description = checkDescription(input.description);
  const due = checkDue(input.due);
  const label = milestoneLabel(project, names);
  if (!isAtMost(label, CLOSING_LABEL)) throw new CardError('invalid', 'a milestone is at most Privato');
  return sql.begin(async (tx) => {
    // One project at a time: two milestones written at once get two places.
    await tx`SELECT pg_advisory_xact_lock(hashtext('milestones:' || ${project}))`;
    const [count] = await tx<{ open: number; next: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'open')::int AS open, coalesce(max(position) + 1, 0)::int AS next FROM milestones WHERE project = ${project}`;
    if ((count?.open ?? 0) >= MAX_OPEN_MILESTONES) throw new CardError('conflict', `a project has ${String(MAX_OPEN_MILESTONES)} open milestones at most`);
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO milestones (project, title, description, due_on, position, label)
      VALUES (${project}, ${title}, ${description}, ${due}::date, ${count?.next ?? 0}, ${label}::privacy_label)
      RETURNING id::text`;
    if (row === undefined) throw new Error('INSERT INTO milestones returned no row');
    await changed(tx, row.id, { created: true });
    return row;
  });
}

async function lockMilestone(tx: Queryable, id: string): Promise<{ id: string; project: string; title: string; label: Label; status: 'open' | 'closed' }> {
  const [row] = await tx<{ id: string; project: string; title: string; label: Label; status: 'open' | 'closed' }[]>`
    SELECT id::text, project, title, label, status FROM milestones WHERE id = ${id} FOR UPDATE`;
  if (row === undefined) throw new CardError('not-found', 'no such milestone');
  return row;
}

/** The event that tells the wall to read again: ids only. */
async function changed(tx: Queryable, id: string, payload: Record<string, unknown>): Promise<void> {
  await appendEvent(tx, { kind: 'card.changed', label: 'L0', payload: { milestoneId: id, ...payload } });
}

export interface MilestoneFields {
  title?: unknown;
  description?: unknown;
  due?: unknown;
}

/** What the user changes of a milestone: title, description, due day. */
export async function updateMilestone(sql: Sql, id: string, fields: MilestoneFields, names: MilestoneNames): Promise<void> {
  const title = 'title' in fields ? checkTitle(fields.title) : undefined;
  const description = 'description' in fields ? checkDescription(fields.description) : undefined;
  const due = 'due' in fields ? checkDue(fields.due) : undefined;
  await sql.begin(async (tx) => {
    const milestone = await lockMilestone(tx, id);
    // New words of the user: the label goes up to them, never down.
    const written = title !== undefined || (description !== undefined && description !== null);
    const label = written ? maxLabel(milestone.label, milestoneLabel(milestone.project, names)) : milestone.label;
    if (!isAtMost(label, CLOSING_LABEL)) throw new CardError('invalid', 'a milestone is at most Privato');
    await tx`
      UPDATE milestones SET
        title = coalesce(${title ?? null}, title),
        description = CASE WHEN ${description !== undefined} THEN ${description ?? null} ELSE description END,
        due_on = CASE WHEN ${due !== undefined} THEN ${due ?? null}::date ELSE due_on END,
        label = ${label}::privacy_label,
        updated_at = now()
      WHERE id = ${id}`;
    // A pending question names the old title: it goes, and the next look asks again with the new one.
    if (title !== undefined) await expireProposal(tx, id);
    await changed(tx, id, { fields: Object.keys(fields) });
  });
}

/** «Chiudi» by hand: closed, its question gone. Its cards stay where they are. */
export async function closeMilestone(sql: Sql, id: string): Promise<void> {
  await sql.begin(async (tx) => {
    const milestone = await lockMilestone(tx, id);
    if (milestone.status === 'closed') return;
    await tx`UPDATE milestones SET status = 'closed', closed_at = now(), declined_at = NULL, updated_at = now() WHERE id = ${id}`;
    await expireProposal(tx, id);
    await changed(tx, id, { closed: true });
  });
}

/**
 * «Riapri»: open again. Counted as a «No» until its cards change: reopened to
 * add cards, it is not asked about at once.
 */
export async function reopenMilestone(sql: Sql, id: string): Promise<void> {
  await sql.begin(async (tx) => {
    const milestone = await lockMilestone(tx, id);
    if (milestone.status === 'open') return;
    await tx`UPDATE milestones SET status = 'open', closed_at = NULL, declined_at = now(), updated_at = now() WHERE id = ${id}`;
    await changed(tx, id, { reopened: true });
  });
}

/** Up or down one place among the milestones of its project. */
export async function moveMilestone(sql: Sql, id: string, direction: unknown): Promise<void> {
  if (direction !== 'up' && direction !== 'down') throw new CardError('invalid', 'direction is up or down');
  await sql.begin(async (tx) => {
    const milestone = await lockMilestone(tx, id);
    await tx`SELECT pg_advisory_xact_lock(hashtext('milestones:' || ${milestone.project}))`;
    const order = await tx<{ id: string; shown: boolean }[]>`
      SELECT id::text, (status = 'open' OR closed_at >= ${addDays(localDay(), -DONE_DAYS)}::date OR id = ${id}) AS shown
      FROM milestones WHERE project = ${milestone.project} ORDER BY position, created_at, id FOR UPDATE`;
    const ids = order.map((row) => row.id);
    const index = ids.indexOf(id);
    // The neighbour the wall shows: a milestone closed long ago, out of sight, is passed over.
    const step = direction === 'up' ? -1 : 1;
    let other = index + step;
    while (other >= 0 && other < order.length && order[other]?.shown !== true) other += step;
    if (index < 0 || other < 0 || other >= order.length) return;
    [ids[index], ids[other]] = [ids[other] as string, ids[index] as string];
    // Positions written again from 0: ties of older rows become an order.
    for (const [position, each] of ids.entries()) await tx`UPDATE milestones SET position = ${position}, updated_at = now() WHERE id = ${each} AND position <> ${position}`;
    await changed(tx, id, { moved: direction });
  });
}

/** «Bloccata da»: `id` waits for `on`, of the same project; no cycle (the database checks). */
export async function addMilestoneDependency(sql: Sql, id: string, on: string): Promise<void> {
  if (id === on) throw new CardError('invalid', 'a milestone cannot wait for itself');
  await sql.begin(async (tx) => {
    const milestone = await lockMilestone(tx, id);
    const [other] = await tx<{ project: string }[]>`SELECT project FROM milestones WHERE id = ${on}`;
    if (other === undefined) throw new CardError('not-found', 'no such milestone');
    if (other.project !== milestone.project) throw new CardError('invalid', 'a milestone waits only for one of its own project');
    const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM milestone_dependencies WHERE milestone_id = ${id} AND removed_at IS NULL`;
    if ((count?.n ?? 0) >= MAX_MILESTONE_DEPENDENCIES) throw new CardError('conflict', `a milestone waits for ${String(MAX_MILESTONE_DEPENDENCIES)} milestones at most`);
    const exists = await tx`SELECT 1 FROM milestone_dependencies WHERE milestone_id = ${id} AND depends_on = ${on} AND removed_at IS NULL`;
    if (exists.length > 0) return;
    try {
      await tx.savepoint((inner) => inner`INSERT INTO milestone_dependencies (milestone_id, depends_on) VALUES (${id}, ${on})`);
    } catch (error) {
      if (error instanceof Error && /a cycle/.test(error.message)) throw new CardError('conflict', 'the two milestones would wait for each other');
      throw error;
    }
    await changed(tx, id, { dependsOn: on });
  });
}

export async function removeMilestoneDependency(sql: Sql, id: string, on: string): Promise<void> {
  await sql.begin(async (tx) => {
    await lockMilestone(tx, id);
    const removed = await tx`
      UPDATE milestone_dependencies SET removed_at = now() WHERE milestone_id = ${id} AND depends_on = ${on} AND removed_at IS NULL RETURNING id`;
    if (removed.length === 0) throw new CardError('not-found', 'no such dependency');
    await changed(tx, id, { removedDependency: on });
  });
}

/**
 * The milestone a card goes in (cardwall.ts): of the card's project, open
 * when it is a new one for the card. Null takes the card out. The cards of
 * both milestones changed, so a «No» to their closing no longer holds.
 */
export async function checkCardMilestone(tx: Queryable, value: unknown, project: string | null, current: string | null): Promise<string | null> {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !isUuid(value)) throw new CardError('invalid', 'milestone must be the id of a milestone');
  if (project === null) throw new CardError('invalid', 'a card without a project has no milestone');
  const [row] = await tx<{ project: string; status: string }[]>`SELECT project, status FROM milestones WHERE id = ${value} FOR SHARE`;
  if (row === undefined) throw new CardError('not-found', 'no such milestone');
  if (row.project !== project) throw new CardError('invalid', 'the milestone is of another project');
  if (row.status !== 'open' && value !== current) throw new CardError('conflict', 'the milestone is closed: reopen it first');
  return value;
}

/**
 * The cards of these milestones changed: a «No» to their closing no longer
 * holds, and a pending question goes (the next look asks again if they are
 * all done).
 */
export async function cardsChanged(tx: Queryable, ids: readonly (string | null)[]): Promise<void> {
  const live = [...new Set(ids.filter((id): id is string => id !== null))];
  if (live.length === 0) return;
  await tx`UPDATE milestones SET declined_at = NULL WHERE id = ANY (${live}::uuid[]) AND declined_at IS NOT NULL`;
  for (const id of live) await expireProposal(tx, id);
}

// ---------------------------------------------------------------------------
// The closing (D-313, point 4): asked, never automatic.
// ---------------------------------------------------------------------------

/** The question, written by code: the milestone's title and its project, nothing of the cards. */
export function closeQuestion(title: string, project: string): string {
  return `La milestone «${title}» di ${project} non ha più card aperte. La chiudo?`;
}

export function closedAnswer(title: string, project: string): string {
  return `Ho chiuso la milestone «${title}» di ${project}.`;
}

export function reopenedAnswer(title: string, project: string): string {
  return `Non ho chiuso la milestone «${title}» di ${project}: nel frattempo una sua card non è più in Fatto.`;
}

export function keptAnswer(title: string, project: string): string {
  return `Va bene, la milestone «${title}» di ${project} resta aperta. Non te lo richiedo finché non cambiano le sue card.`;
}

/** A message of Arianna in the secretary conversation. `approval`: it asks for one (a notice of kind approval); `silent`: no notice. */
async function postMessage(tx: Queryable, text: string, label: Label, payload: { approval?: string; silent?: true }): Promise<void> {
  const conversationId = await secretaryConversationId(tx);
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, channel, label, body)
    VALUES (${conversationId}, 'assistant', 'web', ${maxLabel(CLOSING_LABEL, label)}::privacy_label, ${text})
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO messages returned no row');
  await appendEvent(tx, { kind: 'message.created', label: 'L0', payload: { conversationId, messageId: row.id, role: 'assistant', ...payload } });
}

/** A pending question about the milestone goes: the cards changed, or the milestone did. */
async function expireProposal(tx: Queryable, id: string): Promise<void> {
  const expired = await tx<{ id: string }[]>`
    UPDATE approvals SET state = 'expired', decided_at = now()
    WHERE kind = 'milestone' AND state = 'pending' AND detail ->> 'milestoneId' = ${id} RETURNING id::text`;
  for (const row of expired) await appendEvent(tx, { kind: 'approval.decided', label: 'L0', payload: { approvalId: row.id, state: 'expired', via: null } });
}

export type ClosingOutcome = 'asked' | 'expired' | 'none';

/**
 * One look at one open milestone: all its cards done (at least one), no
 * question pending and no «No» still holding → the question; some card not
 * done → a pending question goes and a «No» no longer holds.
 */
async function lookAt(sql: Sql, id: string): Promise<ClosingOutcome> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ project: string; title: string; label: Label; status: string; declined: boolean; total: number; done: number; proposal: string | null }[]>`
      SELECT m.project, m.title, m.label, m.status, m.declined_at IS NOT NULL AS declined,
        (SELECT count(*)::int FROM tasks t WHERE t.milestone_id = m.id) AS total,
        (SELECT count(*)::int FROM tasks t WHERE t.milestone_id = m.id AND t.status = 'done') AS done,
        (SELECT a.id::text FROM approvals a WHERE a.kind = 'milestone' AND a.state = 'pending' AND a.detail ->> 'milestoneId' = m.id::text) AS proposal
      FROM milestones m WHERE m.id = ${id} FOR UPDATE OF m`;
    if (row?.status !== 'open') return 'none';
    const complete = row.total > 0 && row.done === row.total;
    if (!complete) {
      if (row.declined) await tx`UPDATE milestones SET declined_at = NULL WHERE id = ${id}`;
      if (row.proposal !== null) {
        await expireProposal(tx, id);
        return 'expired';
      }
      return 'none';
    }
    if (row.proposal !== null || row.declined) return 'none';
    const [approval] = await tx<{ id: string }[]>`
      INSERT INTO approvals (task_id, kind, action, detail, label)
      VALUES (NULL, 'milestone', ${MILESTONE_CLOSE}, ${tx.json({ milestoneId: id, project: row.project, title: row.title })}, ${row.label}::privacy_label)
      RETURNING id::text`;
    if (approval === undefined) throw new Error('INSERT INTO approvals returned no row');
    await appendEvent(tx, { kind: 'approval.requested', label: 'L0', payload: { approvalId: approval.id, action: MILESTONE_CLOSE, milestoneId: id } });
    await postMessage(tx, closeQuestion(row.title, row.project), row.label, { approval: approval.id });
    await changed(tx, id, { asked: true });
    return 'asked';
  });
}

/** One look at every open milestone; exported for the tests. */
export async function checkMilestones(sql: Sql, onError?: (error: unknown) => void): Promise<Record<string, ClosingOutcome>> {
  const open = await sql<{ id: string }[]>`SELECT id::text FROM milestones WHERE status = 'open' ORDER BY created_at, id`;
  const outcomes: Record<string, ClosingOutcome> = {};
  for (const { id } of open) {
    // One milestone that fails does not stop the look at the others.
    try {
      outcomes[id] = await lookAt(sql, id);
    } catch (error) {
      if (onError === undefined) throw error;
      onError(error);
    }
  }
  return outcomes;
}

/**
 * Before the decision locks the approval (engine.ts): the milestone it asks
 * about, locked first. Every other path locks the milestone, then its
 * approvals: one order, no deadlock between «Sì» and «Chiudi».
 */
export async function lockMilestoneOfApproval(tx: Queryable, approvalId: string): Promise<void> {
  await tx`
    SELECT m.id FROM milestones m JOIN approvals a ON a.detail ->> 'milestoneId' = m.id::text
    WHERE a.id = ${approvalId} AND a.kind = 'milestone' FOR UPDATE OF m`;
}

/** The milestone a `milestone` approval asks about, or undefined for another approval. */
export function milestoneOf(approval: Pick<StoredApproval, 'kind' | 'detail'>): string | undefined {
  if (approval.kind !== 'milestone') return undefined;
  return typeof approval.detail.milestoneId === 'string' ? approval.detail.milestoneId : undefined;
}

/**
 * The user's decision (engine.ts, in the transaction of the decision): «Sì»
 * closes the milestone if it is still open, «No» keeps it open and holds back
 * the next question until its cards change. Arianna says so, without a notice.
 */
export async function applyMilestoneDecision(tx: Queryable, approval: StoredApproval): Promise<void> {
  const id = milestoneOf(approval);
  if (id === undefined || (approval.state !== 'approved' && approval.state !== 'rejected')) return;
  const [row] = await tx<{ project: string; title: string; label: Label; status: string; open: number }[]>`
    SELECT m.project, m.title, m.label, m.status,
      (SELECT count(*)::int FROM tasks t WHERE t.milestone_id = m.id AND t.status <> 'done') AS open
    FROM milestones m WHERE m.id = ${id} FOR UPDATE OF m`;
  if (row === undefined) return;
  if (approval.state === 'approved') {
    // A card went back from Fatto since the question: the «Sì» was for cards all done, so it stays open.
    if (row.open > 0) {
      await postMessage(tx, reopenedAnswer(row.title, row.project), row.label, { silent: true });
      await changed(tx, id, { decided: approval.state, kept: true });
      return;
    }
    if (row.status === 'open') await tx`UPDATE milestones SET status = 'closed', closed_at = now(), declined_at = NULL, updated_at = now() WHERE id = ${id}`;
    await postMessage(tx, closedAnswer(row.title, row.project), row.label, { silent: true });
  } else {
    if (row.status === 'open') await tx`UPDATE milestones SET declined_at = now(), updated_at = now() WHERE id = ${id}`;
    await postMessage(tx, keptAnswer(row.title, row.project), row.label, { silent: true });
  }
  await changed(tx, id, { decided: approval.state });
}

// ---------------------------------------------------------------------------
// The morning of the secretary (D-313, point 7): the open milestones due soon.
// ---------------------------------------------------------------------------

/** Days ahead a due milestone is named in the morning message. */
export const MILESTONE_REMINDER_DAYS = 3;
/** Most milestones named in one morning. */
const MAX_REMINDER_MILESTONES = 5;

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'] as const;

function shortDay(day: string): string {
  const [, month, date] = day.split('-').map(Number) as [number, number, number];
  return `${String(date)} ${MONTHS[month - 1] ?? ''}`;
}

/** "scade oggi", "scade domani", "scade fra 3 giorni (27 ottobre)", "è scaduta il 20 ottobre". */
export function dueWords(due: string, today: string): string {
  if (due < today) return `è scaduta il ${shortDay(due)}`;
  if (due === today) return 'scade oggi';
  if (due === addDays(today, 1)) return 'scade domani';
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return `scade fra ${String(days)} giorni (${shortDay(due)})`;
}

/**
 * The lines of the morning: open milestones with a due day up to
 * MILESTONE_REMINDER_DAYS ahead, late ones too, at most L2 (the secretary
 * conversation). Title, project, due day and the count of its cards; written by code.
 */
export async function milestoneReminderLines(sql: Queryable, today: string): Promise<{ text: string; label: Label }[]> {
  const until = addDays(today, MILESTONE_REMINDER_DAYS);
  const rows = await sql<{ project: string; title: string; due: string; label: Label; total: number; done: number }[]>`
    SELECT m.project, m.title, m.due_on::text AS due, m.label,
      (SELECT count(*)::int FROM tasks t WHERE t.milestone_id = m.id) AS total,
      (SELECT count(*)::int FROM tasks t WHERE t.milestone_id = m.id AND t.status = 'done') AS done
    FROM milestones m
    WHERE m.status = 'open' AND m.due_on IS NOT NULL AND m.due_on <= ${until}::date AND m.label <= 'L2'::privacy_label
    ORDER BY m.due_on, m.project, m.position
    LIMIT ${MAX_REMINDER_MILESTONES}`;
  return rows.map((row) => ({
    text: `La milestone «${row.title}» di ${row.project} ${dueWords(row.due, today)}: ${doneWords(row.done, row.total)}.`,
    label: row.label,
  }));
}

/** "2 di 3 card fatte", "nessuna card". */
export function doneWords(done: number, total: number): string {
  if (total === 0) return 'nessuna card';
  return `${String(done)} di ${String(total)} card ${total === 1 ? 'fatta' : 'fatte'}`;
}

// ---------------------------------------------------------------------------
// The watcher: one look every half minute, as the IM (im-watch.ts).
// ---------------------------------------------------------------------------

export interface MilestoneWatcher {
  check(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createMilestoneWatcher(options: { sql: Sql; onError: (error: unknown) => void; intervalMs?: number }): MilestoneWatcher {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const check = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await checkMilestones(options.sql, options.onError);
    } catch (error) {
      options.onError(error);
    } finally {
      running = false;
    }
  };
  return {
    check,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void check(), options.intervalMs ?? 30_000);
      timer.unref();
      void check();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
