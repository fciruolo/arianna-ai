import { isAtMost, maxLabel, type Label } from '@arianna/policy';

import type { StoredApproval } from './approvals.ts';
import { CardError } from './cardwall.ts';
import { dayText, localDay, parseDay } from './commitment-dates.ts';
import type { Queryable } from './db/client.ts';
import { appendEvent } from './events.ts';
import { insertMilestone, MAX_MILESTONE_TITLE, MAX_OPEN_MILESTONES } from './milestones.ts';
import { createTask, loadTask } from './tasks.ts';

/**
 * Milestones proposed in the chat (D-313, seguito 2), on the model of
 * `task.plan` and its approval (D-159): the orchestrator's tool
 * `milestone.propose` gives a title, the project, what «fatta» means, the due
 * day in the user's words and the titles of the new cards. The code checks
 * them (never trusted to the model) and writes an approval of kind
 * `milestone_plan`; nothing is created until the user approves it in the web
 * chat. Then, in the transaction of the decision, the milestone is written
 * (Privato, as every milestone today: never below its project's label, at most
 * L2) and its cards are born in the inbox of the project, assigned to the
 * user, children of the chat task, each in the milestone: none of them starts.
 * The answer is written by code. Events carry ids only.
 *
 * The choices not written in D-313, taken by Claude as the most prudent: only
 * new cards (an existing card goes in a milestone from the wall, by hand); the
 * cards to the user, in the inbox; no «bloccata da» from the chat.
 */

export const MILESTONE_PROPOSE = 'milestone.propose';
export const MILESTONE_PLAN_KIND = 'milestone_plan';
/** The result of a milestone.propose call: the next step answers once the user decided. */
export const WAITING_MILESTONE = 'waiting for the user to approve the milestone in the chat';

/** Most new cards of one proposal: as many as a plan (D-235). */
export const MAX_PROPOSED_CARDS = 12;
export const MAX_PROPOSED_CARD_TITLE = 120;
/** «Fatta quando» from the chat: shorter than on the wall (2000), one or two sentences. */
export const MAX_PROPOSED_DESCRIPTION = 500;
const MAX_DUE_WORDS = 80;

/** A milestone is at most Privato: the secretary conversation, where its closing is asked, holds it (D-313). */
const MILESTONE_CEILING: Label = 'L2';
/** Every milestone written today is Privato (D-313): a text of the user, default-deny. */
const MILESTONE_LABEL: Label = 'L2';

const PROPOSAL_FIELDS = ['title', 'project', 'description', 'due', 'cards'];

/** What the step knows to check a proposal: the projects of arianna.toml and the conversation's own. */
export interface ProposalScope {
  projects: readonly { name: string; label: Label }[];
  /** The project of the conversation's workspace, when it has one. */
  workspace?: string;
  /** Today, YYYY-MM-DD, for the due day. */
  today?: string;
}

export interface MilestoneProposal {
  project: string;
  /** The label of the project in arianna.toml when proposed: the milestone is never below it. */
  projectLabel: Label;
  title: string;
  description: string | null;
  /** YYYY-MM-DD, computed by the code from the user's words. */
  due: string | null;
  cards: string[];
}

function line(value: unknown, max: number, what: string): string | { error: string } {
  if (typeof value !== 'string') return { error: `${what} must be a string` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(value)) return { error: `${what} contains control characters` };
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return { error: `${what} is empty` };
  if (Array.from(text).length > max) return { error: `${what} is longer than ${String(max)} characters: write a shorter one` };
  return text;
}

/**
 * The arguments of `milestone.propose`, checked by code: only the closed
 * fields; the project of the conversation, or a project of arianna.toml as the
 * user named it (any case); the due day computed from the user's words; the
 * cards as short titles, at most MAX_PROPOSED_CARDS, none twice.
 */
export function checkMilestoneProposal(args: Record<string, unknown>, scope: ProposalScope): MilestoneProposal | { error: string } {
  const unknown = Object.keys(args).filter((key) => !PROPOSAL_FIELDS.includes(key));
  if (unknown.length > 0) return { error: `unknown field(s) ${unknown.join(', ')}: a milestone has only title, project, description, due and cards` };
  const title = line(args.title, MAX_MILESTONE_TITLE, 'the title');
  if (typeof title !== 'string') return title;
  const said = typeof args.project === 'string' && args.project.trim() !== '' ? args.project.trim() : undefined;
  const names = scope.projects.map((project) => project.name);
  let name: string | undefined;
  if (scope.workspace !== undefined) {
    if (said !== undefined && said.toLowerCase() !== scope.workspace.toLowerCase()) {
      return { error: `this conversation is of the project ${scope.workspace}: a milestone of another project is proposed in its own conversation, or written on the cardwall` };
    }
    name = scope.workspace;
  } else if (said === undefined) {
    return { error: names.length === 0 ? 'no project is configured: tell the user to add one in Impostazioni → Progetti' : `name the project: the known ones are ${names.join(', ')}` };
  } else {
    name = names.find((item) => item === said) ?? names.find((item) => item.toLowerCase() === said.toLowerCase());
    if (name === undefined) return { error: names.length === 0 ? 'no project is configured' : `no project '${said}'; the known ones are ${names.join(', ')}: ask the user which` };
  }
  const project = scope.projects.find((item) => item.name === name);
  if (project === undefined) return { error: `the project ${name} is not configured any more` };
  let description: string | null = null;
  if (args.description !== undefined && args.description !== null && args.description !== '') {
    const checked = line(args.description, MAX_PROPOSED_DESCRIPTION, 'the description');
    if (typeof checked !== 'string') return checked;
    description = checked;
  }
  let due: string | null = null;
  if (args.due !== undefined && args.due !== null && args.due !== '') {
    const words = line(args.due, MAX_DUE_WORDS, 'due');
    if (typeof words !== 'string') return words;
    const parsed = parseDay(words, scope.today ?? localDay());
    if (parsed === undefined) return { error: `the core cannot tell the day from '${words}': ask the user which day with user.ask; never leave out a due the user said` };
    due = parsed.day;
  }
  if (!Array.isArray(args.cards)) return { error: 'cards must be a list of card titles ([] when the user named none)' };
  if (args.cards.length > MAX_PROPOSED_CARDS) return { error: `a milestone is proposed with at most ${String(MAX_PROPOSED_CARDS)} new cards` };
  const cards: string[] = [];
  for (const [index, item] of (args.cards as unknown[]).entries()) {
    const card = line(item, MAX_PROPOSED_CARD_TITLE, `card ${String(index + 1)}`);
    if (typeof card !== 'string') return card;
    if (!cards.some((other) => other.toLowerCase() === card.toLowerCase())) cards.push(card);
  }
  return { project: project.name, projectLabel: project.label, title, description, due, cards };
}

/** The label of the approval: what the step read, never below the project's. At most Privato. */
export function proposalLabel(context: Label, proposal: Pick<MilestoneProposal, 'projectLabel'>): Label {
  return maxLabel(context, proposal.projectLabel);
}

export function milestoneProposalLabelOk(label: Label): boolean {
  return isAtMost(label, MILESTONE_CEILING);
}

/** An open milestone of the project with the same title (any case): the proposal would make a second one. */
export async function sameOpenMilestone(sql: Queryable, project: string, title: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT true AS ok FROM milestones WHERE project = ${project} AND status = 'open' AND lower(title) = lower(${title}) LIMIT 1`;
  return row?.ok === true;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Writes the approval with the step's turn, in its transaction; returns its id. The event names ids only. */
export async function writeMilestoneProposal(tx: Queryable, options: { taskId: string; step: number; label: Label; proposal: MilestoneProposal }): Promise<string> {
  const { proposal } = options;
  const detail: { [key: string]: Json } = {
    project: proposal.project,
    projectLabel: proposal.projectLabel,
    title: proposal.title,
    description: proposal.description,
    due: proposal.due,
    cards: [...proposal.cards],
    step: options.step,
  };
  const label = proposalLabel(options.label, proposal);
  if (!milestoneProposalLabelOk(label)) throw new Error('a milestone is proposed at most at Privato');
  const [approval] = await tx<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${options.taskId}, ${MILESTONE_PLAN_KIND}, ${MILESTONE_PROPOSE}, ${tx.json(detail)}, ${label}::privacy_label)
    RETURNING id::text`;
  if (approval === undefined) throw new Error('INSERT INTO approvals returned no row');
  return approval.id;
}

const LABELS: readonly Label[] = ['L0', 'L1', 'L2', 'L3'];

/** The proposal an approval of kind `milestone_plan` holds, or undefined (purged, or not one). */
export function milestoneProposalOf(approval: Pick<StoredApproval, 'kind' | 'detail'>): MilestoneProposal | undefined {
  if (approval.kind !== MILESTONE_PLAN_KIND) return undefined;
  const { project, projectLabel, title, description, due, cards } = approval.detail;
  if (typeof project !== 'string' || typeof title !== 'string' || !Array.isArray(cards)) return undefined;
  return {
    project,
    // An unreadable label is Privato: default-deny, on purpose.
    projectLabel: LABELS.find((label) => label === projectLabel) ?? MILESTONE_LABEL,
    title,
    description: typeof description === 'string' ? description : null,
    due: typeof due === 'string' ? due : null,
    cards: (cards as unknown[]).filter((card): card is string => typeof card === 'string'),
  };
}

export type ProposalOutcome = { kind: 'created'; milestoneId: string; cards: string[] } | { kind: 'full' } | { kind: 'duplicate' } | { kind: 'none' };

/** Why an approved proposal made no milestone, as the answer says it (D-313). */
export type ProposalAnswer = 'created' | 'full' | 'duplicate' | 'failed';

/**
 * The approved proposal, in the transaction of the decision (engine.ts): the
 * milestone, Privato and never below its project's label, last in its order,
 * then its cards in the inbox of the project, to the user, children of the
 * chat task, at the label of the approval. Once per approval (the unique
 * index on `milestones.approval_id`). A project already full of open
 * milestones gets none, nor one whose title is already open there (another
 * proposal approved first, or a milestone written on the wall meanwhile):
 * the answer says so. The labels: the approval and the cards keep the label of
 * the step that wrote them (Interno in a work conversation, where the user
 * wrote the same words), the milestone is stored Privato as every milestone
 * (D-313): never lower than its text, only higher. The project is the one
 * checked at the proposal: one taken out of arianna.toml meanwhile still gets
 * it, as its cards on the wall stay too.
 */
export async function applyMilestoneProposal(tx: Queryable, approval: StoredApproval): Promise<ProposalOutcome> {
  const proposal = milestoneProposalOf(approval);
  if (proposal === undefined || approval.state !== 'approved' || approval.taskId === null) return { kind: 'none' };
  const [made] = await tx<{ id: string }[]>`SELECT id::text FROM milestones WHERE approval_id = ${approval.id}`;
  if (made !== undefined) return { kind: 'none' };
  const source = await loadTask(tx, approval.taskId);
  if (source === undefined) return { kind: 'none' };
  // The lock of insertMilestone, taken first: the checks below and the insert see the same milestones.
  await tx`SELECT pg_advisory_xact_lock(hashtext('milestones:' || ${proposal.project}))`;
  if (await sameOpenMilestone(tx, proposal.project, proposal.title)) return { kind: 'duplicate' };
  const [open] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM milestones WHERE project = ${proposal.project} AND status = 'open'`;
  if ((open?.count ?? 0) >= MAX_OPEN_MILESTONES) return { kind: 'full' };
  let milestone: { id: string };
  try {
    milestone = await insertMilestone(tx, {
      project: proposal.project,
      title: proposal.title,
      description: proposal.description,
      due: proposal.due,
      label: maxLabel(MILESTONE_LABEL, proposal.projectLabel),
      approvalId: approval.id,
    });
  } catch (error) {
    // Another milestone written meanwhile filled the project: nothing more here, the decision stands.
    if (error instanceof CardError && error.code === 'conflict') return { kind: 'full' };
    throw error;
  }
  const cards: string[] = [];
  for (const title of proposal.cards) {
    const created = await createTask(tx, {
      project: proposal.project,
      title,
      parentId: source.id,
      label: approval.label,
      clearance: source.clearance,
      effectiveLabel: approval.label,
      assignee: 'user',
      status: 'inbox',
    });
    await tx`UPDATE tasks SET milestone_id = ${milestone.id}::uuid WHERE id = ${created.id}`;
    cards.push(created.id);
    await appendEvent(tx, { kind: 'card.changed', taskId: created.id, label: 'L0', payload: { created: true, milestoneId: milestone.id } });
  }
  return { kind: 'created', milestoneId: milestone.id, cards };
}

/** The milestone an approved proposal created, with how many cards it has, or undefined. */
export async function proposedMilestone(sql: Queryable, approvalId: string): Promise<{ id: string; cards: number } | undefined> {
  const [row] = await sql<{ id: string; cards: number }[]>`
    SELECT m.id::text, (SELECT count(*)::int FROM tasks t WHERE t.milestone_id = m.id) AS cards FROM milestones m WHERE m.approval_id = ${approvalId}`;
  return row;
}

/**
 * Why an approved proposal has no milestone, read after the decision: the
 * title is open in the project now, the project is full, or something else
 * (the chat task gone). `created` when the decision made it.
 */
export async function proposalAnswerOf(sql: Queryable, approvalId: string, proposal: MilestoneProposal): Promise<ProposalAnswer> {
  if ((await proposedMilestone(sql, approvalId)) !== undefined) return 'created';
  if (await sameOpenMilestone(sql, proposal.project, proposal.title)) return 'duplicate';
  const [open] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM milestones WHERE project = ${proposal.project} AND status = 'open'`;
  return (open?.count ?? 0) >= MAX_OPEN_MILESTONES ? 'full' : 'failed';
}

/** What the chat reads once the user decided a proposed milestone, written by code. */
export function milestoneAnswerText(proposal: MilestoneProposal, state: string, outcome: ProposalAnswer): string {
  if (state !== 'approved') return 'Va bene: non ho creato la milestone. Se cambi idea, chiedimela di nuovo o creala dal «Cardwall».';
  if (outcome === 'full') {
    return `Non sono riuscita a creare la milestone «${proposal.title}»: ${proposal.project} ha già ${String(MAX_OPEN_MILESTONES)} milestone aperte. Chiudine una dal «Cardwall» e chiedimela di nuovo.`;
  }
  if (outcome === 'duplicate') {
    return `Non ho creato la milestone «${proposal.title}»: ${proposal.project} ne ha già una aperta con questo nome. Spostaci le card dal «Cardwall».`;
  }
  if (outcome === 'failed') return `Non sono riuscita a creare la milestone «${proposal.title}»: guarda il «Cardwall» di ${proposal.project} e chiedimela di nuovo se manca.`;
  const due = proposal.due === null ? '' : `, scade ${dayText(proposal.due)}`;
  const where = `La trovi nel «Cardwall» scegliendo ${proposal.project} nel filtro.`;
  if (proposal.cards.length === 0) return `Ho creato la milestone «${proposal.title}» di ${proposal.project}${due}, ancora senza card: spostaci le card trascinandole nella sua fascia. ${where}`;
  const lines = proposal.cards.map((card, index) => `${String(index + 1)}. ${card}`);
  const count = proposal.cards.length === 1 ? 'una card in Inbox, assegnata a te e non avviata' : `${String(proposal.cards.length)} card in Inbox, assegnate a te e non avviate`;
  return `Ho creato la milestone «${proposal.title}» di ${proposal.project}${due}, con ${count}:\n\n${lines.join('\n')}\n\n${where}`;
}
