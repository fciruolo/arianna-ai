import { maxLabel, type Label } from '@arianna/policy';

import { dayText, localDay, parseDay, parseTime, relativeDayText, type DayRange } from './commitment-dates.ts';
import { loadConversation, type Conversation } from './conversations.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import type { StoredApproval } from './approvals.ts';

/**
 * The secretary (I-12, D-144, tappa S1): the commitments the user tells
 * Arianna, in the table `commitments` (migration 0036), and the one private
 * conversation of the "Segretaria" button. A commitment is private (L2 at
 * least): its text never leaves this machine, the lists are written here
 * from SQL and never by the model, and its day is computed by the code
 * (commitment-dates.ts) and confirmed by the user before it is saved.
 */
export const COMMITMENT_STATUSES = ['open', 'done', 'not_done', 'postponed', 'cancelled'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export interface Commitment {
  id: string;
  body: string;
  /** "YYYY-MM-DD", local day. */
  day: string;
  /** "HH:MM", or null when the user said no time. */
  time: string | null;
  status: CommitmentStatus;
  reason: string | null;
  label: Label;
  conversationId: string | null;
  createdAt: Date;
  doneAt: Date | null;
}

/** The label every commitment has at least. */
export const COMMITMENT_LABEL: Label = 'L2';
/** Longest text of a commitment (the column allows 500; the tool asks for 300). */
export const MAX_COMMITMENT = 300;
/** The title of the secretary's conversation, from its birth: never the start of a message. */
export const SECRETARY_TITLE = 'Segretaria';

export class CommitmentError extends Error {
  override name = 'CommitmentError';
  readonly code: 'not-found' | 'closed';

  constructor(code: 'not-found' | 'closed', message: string) {
    super(message);
    this.code = code;
  }
}

const COLUMNS = `id::text, body, day::text AS day, to_char(at_time, 'HH24:MI') AS time, status, reason, label,
  conversation_id::text AS "conversationId", created_at AS "createdAt", done_at AS "doneAt"`;

export async function loadCommitment(sql: Queryable, id: string): Promise<Commitment | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [row] = await sql.unsafe<Commitment[]>(`SELECT ${COLUMNS} FROM commitments WHERE id = $1`, [id]);
  return row;
}

/**
 * Commitments by day and time: those of `range` in any status, or without
 * one every open commitment (the late ones first).
 */
export async function listCommitments(sql: Queryable, range?: { from: string; to: string }): Promise<Commitment[]> {
  const rows =
    range === undefined
      ? await sql.unsafe<Commitment[]>(`SELECT ${COLUMNS} FROM commitments WHERE status = 'open' ORDER BY day, at_time NULLS LAST, created_at, id`)
      : await sql.unsafe<Commitment[]>(
          `SELECT ${COLUMNS} FROM commitments WHERE day BETWEEN $1::date AND $2::date AND status <> 'cancelled' ORDER BY day, at_time NULLS LAST, created_at, id`,
          [range.from, range.to],
        );
  return [...rows];
}

/** Open commitments of days before `today`: still to do, late. */
export async function lateCommitments(sql: Queryable, today: string): Promise<Commitment[]> {
  const rows = await sql.unsafe<Commitment[]>(
    `SELECT ${COLUMNS} FROM commitments WHERE status = 'open' AND day < $1::date ORDER BY day, at_time NULLS LAST, created_at, id`,
    [today],
  );
  return [...rows];
}

/**
 * Marks an open commitment done: the "Fatto" button (the click is the
 * user's confirmation) or an approved `commitment.done`. Refused for one
 * that is not open. The event carries the id only.
 */
export async function markDone(sql: Queryable, id: string): Promise<Commitment> {
  const existing = await loadCommitment(sql, id);
  if (existing === undefined) throw new CommitmentError('not-found', `commitment ${id} does not exist`);
  const [row] = await sql.unsafe<Commitment[]>(
    `UPDATE commitments SET status = 'done', done_at = now(), updated_at = now() WHERE id = $1 AND status = 'open' RETURNING ${COLUMNS}`,
    [id],
  );
  if (row === undefined) throw new CommitmentError('closed', `commitment ${id} is not open`);
  await appendEvent(sql, { kind: 'commitment.changed', label: 'L0', payload: { commitmentId: id, status: 'done' } });
  return row;
}

// --- The confirmation: an approval of kind `commitment`, decided in the web chat only.

export type CommitmentAction = 'commitment.add' | 'commitment.done';

/** What the approval card shows and what approving it does. */
export type CommitmentProposal =
  | { op: 'add'; text: string; day: string; time: string | null; dayText: string }
  | { op: 'done'; commitmentId: string; text: string; day: string; time: string | null; dayText: string };

/**
 * Asks the user to confirm `proposal`, as an approval of the task at `step`
 * (written with the step's turn, in its transaction). Its label is at least
 * L2: the detail holds the text of a commitment.
 */
export async function requestCommitment(
  tx: Queryable,
  options: { taskId: string; step: number; label: Label; proposal: CommitmentProposal },
): Promise<string> {
  const action: CommitmentAction = options.proposal.op === 'add' ? 'commitment.add' : 'commitment.done';
  const label = maxLabel(options.label, COMMITMENT_LABEL);
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${options.taskId}, 'commitment', ${action}, ${tx.json({ ...options.proposal, step: options.step })}, ${label}::privacy_label)
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO approvals returned no row');
  return row.id;
}

/** The pending or decided confirmation a task asked at `step`. */
export async function commitmentApprovalAt(sql: Queryable, taskId: string, step: number): Promise<{ id: string; state: string } | undefined> {
  const [row] = await sql<{ id: string; state: string }[]>`
    SELECT id::text, state FROM approvals
    WHERE task_id = ${taskId} AND kind = 'commitment' AND (detail ->> 'step')::int = ${step}
    ORDER BY requested_at DESC LIMIT 1`;
  return row;
}

/** The proposal of an approval of kind `commitment`, or undefined when its detail is not one (purged). */
export function proposalOf(approval: Pick<StoredApproval, 'kind' | 'detail'>): CommitmentProposal | undefined {
  if (approval.kind !== 'commitment') return undefined;
  const detail = approval.detail;
  const text = typeof detail.text === 'string' ? detail.text : undefined;
  const day = typeof detail.day === 'string' ? detail.day : undefined;
  const time = typeof detail.time === 'string' ? detail.time : null;
  if (text === undefined || day === undefined) return undefined;
  if (detail.op === 'add') return { op: 'add', text, day, time, dayText: dayText(day) };
  if (detail.op === 'done' && typeof detail.commitmentId === 'string') return { op: 'done', commitmentId: detail.commitmentId, text, day, time, dayText: dayText(day) };
  return undefined;
}

/**
 * What an approved confirmation does, in the transaction of the decision: a
 * new commitment (once per approval), or one marked done (if still open).
 * Returns the commitment, or undefined when nothing changed.
 */
export async function applyCommitmentApproval(tx: Queryable, approval: StoredApproval): Promise<Commitment | undefined> {
  const proposal = proposalOf(approval);
  if (proposal === undefined || approval.state !== 'approved') return undefined;
  if (proposal.op === 'done') {
    try {
      return await markDone(tx, proposal.commitmentId);
    } catch (error) {
      if (error instanceof CommitmentError) return undefined;
      throw error;
    }
  }
  const [row] = await tx.unsafe<Commitment[]>(
    `INSERT INTO commitments (body, day, at_time, label, conversation_id, task_id, approval_id)
     VALUES ($1, $2::date, $3::time, $4::privacy_label, $5::uuid, $6::uuid, $7::uuid)
     ON CONFLICT (approval_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [proposal.text, proposal.day, proposal.time, maxLabel(approval.label, COMMITMENT_LABEL), approval.conversationId, approval.taskId, approval.id],
  );
  if (row !== undefined) await appendEvent(tx, { kind: 'commitment.changed', label: 'L0', payload: { commitmentId: row.id, status: 'open' } });
  return row;
}

// --- What the tools of the orchestrator compute, without the model.

/** A commitment to propose from the arguments of `commitment.add`, or why not (an error the model reads). */
export function proposeAdd(args: Record<string, unknown>, today: string): CommitmentProposal | { error: string } {
  const text = typeof args.text === 'string' ? args.text.replace(/\s+/g, ' ').trim() : '';
  if (text === '') return { error: 'the text is empty: write what the user has to do' };
  if (Array.from(text).length > MAX_COMMITMENT) return { error: `the text is longer than ${String(MAX_COMMITMENT)} characters` };
  const words = typeof args.day === 'string' ? args.day : '';
  const parsed = parseDay(words, today);
  if (parsed === undefined) {
    return { error: `the day '${words}' is not one the core can compute: ask the user for the day (oggi, domani, a weekday, a date such as 15 ottobre)` };
  }
  let time = parsed.time ?? null;
  if (typeof args.time === 'string' && args.time.trim() !== '') {
    const given = parseTime(args.time);
    if (given === undefined) return { error: `the time '${args.time}' is not a clock: pass it as HH:MM, or leave it out` };
    time = given;
  }
  return { op: 'add', text, day: parsed.day, time, dayText: dayText(parsed.day) };
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3)
    .map((word) => word.slice(0, 5));
}

/**
 * The open commitment `which` names: by its id (or a prefix of 6 or more
 * characters), or by the words they share, when one shares more than any
 * other. `several` when the words do not tell one from the others.
 */
export function findCommitment(open: readonly Commitment[], which: string): { found: Commitment } | { several: Commitment[] } | { none: true } {
  const key = which.trim().toLowerCase();
  if (/^[0-9a-f-]{6,36}$/.test(key)) {
    const byId = open.filter((item) => item.id.startsWith(key));
    if (byId.length === 1 && byId[0] !== undefined) return { found: byId[0] };
  }
  const asked = new Set(words(which));
  const scored = open
    .map((item) => ({ item, score: new Set(words(item.body).filter((word) => asked.has(word))).size }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (best === undefined) return { none: true };
  if (second !== undefined && second.score === best.score) return { several: scored.filter((entry) => entry.score === best.score).map((entry) => entry.item) };
  return { found: best.item };
}

/** One line of a commitment for the model: its short id, day, time and text. */
export function commitmentLine(item: Commitment): string {
  return `[${item.id.slice(0, 8)}] ${item.day}${item.time === null ? '' : ` ${item.time}`} ${item.body}`;
}

const STATUS_TEXT: Record<CommitmentStatus, string> = {
  open: '',
  done: ' (fatto)',
  not_done: ' (non fatto)',
  postponed: ' (rinviato)',
  cancelled: ' (annullato)',
};

function bullet(item: Commitment, withDay: boolean): string {
  const when = [withDay ? dayText(item.day) : '', item.time ?? ''].filter((part) => part !== '').join(', ');
  return `- ${when === '' ? '' : `${when} · `}${item.body}${STATUS_TEXT[item.status]}`;
}

/**
 * The list the chat shows for "cosa ho domani?", written here from SQL:
 * the commitments of the range, and for today also the late ones.
 */
export function listText(items: readonly Commitment[], range: DayRange | undefined, today: string, late: readonly Commitment[] = []): string {
  const oneDay = range !== undefined && range.from === range.to;
  const lines: string[] = [];
  if (range === undefined) {
    lines.push(items.length === 0 ? 'Non hai impegni aperti.' : 'I tuoi impegni aperti:');
  } else {
    const label = oneDay ? range.text.charAt(0).toUpperCase() + range.text.slice(1) : `Impegni di ${range.text}`;
    lines.push(items.length === 0 ? `${label}: nessun impegno segnato.` : `${label}:`);
  }
  for (const item of items) lines.push(bullet(item, !oneDay));
  if (late.length > 0) {
    lines.push('', 'Ancora da fare dai giorni scorsi:');
    for (const item of late) lines.push(bullet(item, true));
  }
  return lines.join('\n');
}

/** The answer the chat shows once the user decided a confirmation, written here. */
export function decisionText(proposal: CommitmentProposal, state: string, today: string = localDay()): string {
  const when = `${relativeDayText(proposal.day, today)}${proposal.time === null ? '' : `, alle ${proposal.time}`}`;
  if (proposal.op === 'add') {
    return state === 'approved' ? `Segnato per ${when}: ${proposal.text}.` : 'Va bene, non l’ho segnato. Dimmi cosa cambiare.';
  }
  return state === 'approved' ? `Segnato come fatto: ${proposal.text}.` : 'Va bene, resta da fare.';
}

// --- The conversation of the "Segretaria" button.

/**
 * The secretary's conversation, opened the first time: private, answered by
 * Arianna, titled "Segretaria" from birth. One only (a unique index): two
 * clicks at once find the same one.
 */
export async function openSecretary(sql: Sql): Promise<Conversation> {
  return sql.begin(async (tx) => {
    const [found] = await tx<{ id: string }[]>`SELECT id::text FROM conversations WHERE secretary AND purged_at IS NULL`;
    let id = found?.id;
    if (id === undefined) {
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO conversations (mode, clearance, title, secretary)
        VALUES ('private', 'L2'::privacy_label, ${SECRETARY_TITLE}, true)
        ON CONFLICT (secretary) WHERE secretary AND purged_at IS NULL DO NOTHING
        RETURNING id::text`;
      if (created !== undefined) {
        await appendEvent(tx, { kind: 'conversation.created', label: 'L0', payload: { conversationId: created.id, mode: 'private', secretary: true } });
        id = created.id;
      } else {
        const [other] = await tx<{ id: string }[]>`SELECT id::text FROM conversations WHERE secretary AND purged_at IS NULL`;
        id = other?.id;
      }
    }
    if (id === undefined) throw new Error('the secretary conversation is missing');
    const conversation = await loadConversation(tx, id);
    if (conversation === undefined) throw new Error('the secretary conversation is missing');
    return conversation;
  });
}

export async function isSecretaryConversation(sql: Queryable, conversationId: string | null): Promise<boolean> {
  if (conversationId === null) return false;
  const [row] = await sql<{ secretary: boolean }[]>`SELECT secretary FROM conversations WHERE id = ${conversationId}`;
  return row?.secretary === true;
}
