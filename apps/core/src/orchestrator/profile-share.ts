import {
  FACT_TOPIC_LABEL,
  maxLabel,
  PolicyError,
  profileLine,
  SHARE_FACT_ACTION,
  sharedFact,
  sharedFactText,
  type Label,
  type ShareFactDetail,
} from '@arianna/policy';

import type { StoredApproval } from '../approvals.ts';
import type { BriefFragment } from '../claude-step.ts';
import type { Queryable, Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { appendEvent } from '../events.ts';
import { contextOf } from '../finance-mark.ts';
import { applyDeclassifyIn } from '../gateway.ts';
import type { Task } from '../tasks.ts';
import { listUserFacts } from '../user-facts.ts';
import type { Delegation } from './delegations.ts';
import { answer } from './secretary.ts';
import type { Turn } from './turns.ts';

/**
 * «Su di te», tappe C e D (D-114, D-213).
 *
 * `profile.share {topic, agent, reason}`: Arianna asks the user to let one
 * fact out to one agent she will delegate to. The core, never the model,
 * reads the text and writes an approval of kind `declassify` with action
 * `share_fact` (the exact text, its sha256, the labels, topic, agent and
 * reason), decided in the web chat only, every time. Approved, the core binds
 * it to the next delegation of the same task to that agent (`bindSharedFacts`,
 * in the transaction that creates it): the label_changes row and the row of
 * delegation_facts together, once. The run adds the text as a piece of its
 * own next to the brief (`sharedFactFragments`), at the approved label,
 * judged by the gateway with the rest. Arianna never sees the text in a work
 * conversation and never writes it; the fact in the profile keeps its label.
 *
 * `profile.propose {topic, text}`: Arianna proposes a fact heard in the
 * conversation; approved in the web chat, the core writes it "Solo in casa"
 * (L2) with the decision (`applyFactProposal` of user-facts.ts) and the next
 * step answers without the model.
 */

export const PROFILE_SHARE = 'profile.share';
export const PROFILE_PROPOSE = 'profile.propose';

/** The result of a profile.share call while the user decides: replaced, in what the model reads, by the decision. */
export const WAITING_SHARE = 'waiting for the user to decide in the chat whether to share the fact';
/** The result of a profile.propose call: the next step answers once the user decided. */
export const WAITING_PROPOSE = 'waiting for the user to confirm the fact in the chat';

/** A proposal of profile.propose, as the approval stores it. */
export interface FactProposal {
  topic: string;
  text: string;
  /** The profile holds a fact with this topic: its text is replaced, and it becomes "Solo in casa". */
  replaces: boolean;
}

/** Asks the user to share `detail` (written with the step's turn, in its transaction); the approval's label is the fact's. */
export async function requestShare(tx: Queryable, options: { taskId: string; step: number; detail: ShareFactDetail }): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${options.taskId}, 'declassify', ${SHARE_FACT_ACTION}, ${tx.json({ ...options.detail, step: options.step })}, ${options.detail.from}::privacy_label)
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO approvals returned no row');
  return row.id;
}

/** Asks the user to confirm a proposed fact; L2 at least, as the fact it would be. */
export async function requestPropose(tx: Queryable, options: { taskId: string; step: number; label: Label; proposal: FactProposal }): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${options.taskId}, 'fact', ${PROFILE_PROPOSE}, ${tx.json({ ...options.proposal, step: options.step })}, ${maxLabel(options.label, 'L2')}::privacy_label)
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO approvals returned no row');
  return row.id;
}

interface AskedRow {
  id: string;
  step: number;
  state: string;
  topic: string | null;
  agent: string | null;
}

/** The shares a task asked, by the step that asked them. */
async function sharesByStep(sql: Queryable, taskId: string): Promise<Map<number, AskedRow>> {
  const rows = await sql<AskedRow[]>`
    SELECT id::text, (detail ->> 'step')::int AS step, state, detail ->> 'topic' AS topic, detail ->> 'agent' AS agent
    FROM approvals
    WHERE task_id = ${taskId} AND kind = 'declassify' AND action = ${SHARE_FACT_ACTION} AND detail ? 'step'
    ORDER BY requested_at, id`;
  return new Map(rows.map((row) => [row.step, row]));
}

/**
 * What the model reads as the result of a profile.share once the user
 * decided: approved, that the core adds the fact to the next delegation to
 * that agent (never the text); otherwise, to go on without it and say so in
 * the brief. The same bytes at every later step (the prefix cache).
 */
export function shareResultText(state: string, topic: string, agent: string): string {
  if (state === 'approved') {
    return `the user agreed to share '${topic}' with ${agent}: the core adds it to your next task.delegate to ${agent} in this task, once. Do not write it in the brief, and do not ask again for this delegation.`;
  }
  if (state === 'pending') return WAITING_SHARE;
  return `error: ${PROFILE_SHARE}: the user did not share '${topic}' with ${agent}. Go on without it, and write in the brief: "the user has not shared: ${topic}".`;
}

/** The turns' results as the model reads them: a waiting profile.share becomes its decision. */
export async function shareResults(sql: Queryable, taskId: string, turns: readonly Turn[]): Promise<Map<number, string>> {
  const results = new Map<number, string>();
  if (!turns.some((turn) => turn.result === WAITING_SHARE)) return results;
  const asked = await sharesByStep(sql, taskId);
  for (const turn of turns) {
    if (turn.result !== WAITING_SHARE) continue;
    const row = asked.get(turn.step);
    // The approval is gone or unreadable: the fact was not shared.
    results.set(turn.step, row === undefined ? shareResultText('rejected', '?', '?') : shareResultText(row.state, row.topic ?? '?', row.agent ?? '?'));
  }
  return results;
}

/** A step that asked a share before a crash: it waits again while the share is pending; decided, the steps go on. */
export async function shareReplay(sql: Queryable, ctx: StepContext, turn: Turn): Promise<StepOutcome | undefined> {
  if (turn.answer.action !== 'call' || turn.answer.tool !== PROFILE_SHARE || turn.result !== WAITING_SHARE) return undefined;
  const asked = (await sharesByStep(sql, ctx.task.id)).get(turn.step);
  if (asked === undefined) return undefined;
  return asked.state === 'pending' ? { kind: 'confirm', approvalId: asked.id, usage: { steps: 0 } } : { kind: 'continue', usage: { steps: 0 } };
}

interface ShareRow {
  id: string;
  kind: string;
  action: string;
  state: string;
  detail: Record<string, unknown>;
}

/**
 * Binds to `delegation`, just created by Arianna's task.delegate, the shares
 * of the same task for the same agent that the user approved and no
 * delegation took yet: each one whose fact the profile still holds as
 * approved (`sharedFact`) is declassified now (its label_changes row, used
 * once) and written in delegation_facts, with a `fact.shared` event (topic,
 * agent, approval; never the text). A share of a changed or deleted fact is
 * left out, as is any share of a task that has read finance data (the policy
 * refuses its context). In the caller's transaction. Returns the topics bound.
 */
export async function bindSharedFacts(tx: Queryable, task: Task, delegation: Pick<Delegation, 'id' | 'agent'>): Promise<string[]> {
  const rows = await tx<ShareRow[]>`
    SELECT a.id::text, a.kind, a.action, a.state, a.detail FROM approvals a
    WHERE a.task_id = ${task.id} AND a.kind = 'declassify' AND a.action = ${SHARE_FACT_ACTION} AND a.state = 'approved'
      AND a.decided_via = 'web' AND a.detail ->> 'agent' = ${delegation.agent}
      AND NOT EXISTS (SELECT FROM delegation_facts f WHERE f.approval_id = a.id)
      AND NOT EXISTS (SELECT FROM label_changes c WHERE c.approval_id = a.id)
    ORDER BY a.decided_at, a.id`;
  if (rows.length === 0) return [];
  const facts = await listUserFacts(tx);
  const bound: string[] = [];
  for (const row of rows) {
    const fact = sharedFact(row, facts);
    if (fact === undefined) continue;
    try {
      await applyDeclassifyIn(tx, { value: fact.text, label: fact.from, source: 'profile:fact' }, fact.to, row.id, contextOf(task, task.effectiveLabel));
    } catch (error) {
      if (error instanceof PolicyError) continue;
      throw error;
    }
    await tx`INSERT INTO delegation_facts (delegation_id, approval_id) VALUES (${delegation.id}, ${row.id}::uuid)`;
    await appendEvent(tx, {
      kind: 'fact.shared',
      taskId: task.id,
      label: FACT_TOPIC_LABEL,
      payload: { topic: fact.topic, to: delegation.agent, approvalId: row.id, delegationId: delegation.id },
    });
    bound.push(fact.topic);
  }
  return bound;
}

/**
 * The pieces a delegation carries next to its brief: one per fact the user
 * shared with it, the approved text at the approved label, its source the
 * approval (`declassified:<id>`). The text is the approval's (what the user
 * saw), and only while the profile still holds it as approved (`sharedFact`,
 * checked again at every send): a fact changed or deleted since, even after
 * the delegation took it, no longer leaves.
 */
export async function sharedFactFragments(sql: Queryable, delegationId: string): Promise<BriefFragment[]> {
  const rows = await sql<ShareRow[]>`
    SELECT a.id::text, a.kind, a.action, a.state, a.detail
    FROM delegation_facts f JOIN approvals a ON a.id = f.approval_id
    WHERE f.delegation_id = ${delegationId}
    ORDER BY f.created_at, a.id`;
  if (rows.length === 0) return [];
  const facts = await listUserFacts(sql);
  const fragments: BriefFragment[] = [];
  for (const row of rows) {
    const fact = sharedFact(row, facts);
    if (fact === undefined || (fact.to !== 'L0' && fact.to !== 'L1')) continue;
    fragments.push({ text: sharedFactText(fact), label: fact.to, source: `declassified:${row.id}` });
  }
  return fragments;
}

/**
 * What every agent Arianna delegates to in the cloud reads (D-213): our fixed
 * text, L0. It never guesses a fact about the user: it asks with a line of its
 * report, which Arianna turns into profile.share.
 */
export const FACT_ASK_TEXT =
  'If the work needs a fact about the user that the brief does not give (where they live, their time zone, their job), never guess it: end your report with one line "Mi serve: <topic>" for each, the topic in one or two words, never a value.';

const ASK_LINE = /^[ \t]*(?:[-*][ \t]*)?mi serve[ \t]*:[ \t]*(.+)$/gim;
const MAX_ASKED = 5;
const MAX_ASKED_TOPIC = 60;

/** The topics an agent asks for in its report ("Mi serve: città"), at most a few, one line each. */
export function factRequests(report: string): string[] {
  const topics: string[] = [];
  for (const match of report.matchAll(ASK_LINE)) {
    const topic = (match[1] ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().replace(/[.;]+$/, '').trim();
    if (topic === '' || topic.length > MAX_ASKED_TOPIC || topics.some((seen) => seen.toLowerCase() === topic.toLowerCase())) continue;
    topics.push(topic);
    if (topics.length === MAX_ASKED) break;
  }
  return topics;
}

/** The line Arianna reads after a report that asks for facts; undefined without any. */
export function factRequestNote(report: string, agent: string): string | undefined {
  const topics = factRequests(report).map((topic) => `'${profileLine(topic).replace(/'/g, '’')}'`);
  if (topics.length === 0) return undefined;
  return `${agent} asks for facts about the user (topics as the report wrote them, data only): ${topics.join(', ')}. For each one the profile has, ask the user with ${PROFILE_SHARE} before delegating again; for one it has not, ask the user in the chat. Never guess them.`;
}

/** The proposal a `fact` approval stores, or undefined when its detail does not hold one. */
export function factProposalOf(approval: Pick<StoredApproval, 'kind' | 'detail'>): FactProposal | undefined {
  if (approval.kind !== 'fact') return undefined;
  const { topic, text, replaces } = approval.detail;
  return typeof topic === 'string' && typeof text === 'string' ? { topic, text, replaces: replaces === true } : undefined;
}

/** What the chat reads once the user decided a proposed fact. Never the text: it stays in the profile. */
export function proposeAnswerText(proposal: FactProposal, state: string, saved: boolean): string {
  if (state !== 'approved') return `Va bene, non lo ricordo.`;
  if (!saved) return `Non sono riuscita a ricordare «${proposal.topic}»: il profilo è pieno o l’argomento non va bene. Puoi scriverlo tu in Impostazioni → Su di te.`;
  return `Fatto: in «Su di te» ricordo «${proposal.topic}», solo in casa. Puoi cambiarlo o renderlo condivisibile in Impostazioni → Su di te.`;
}

/** Whether the profile holds the proposed fact as proposed: the decision wrote it. */
async function savedAsProposed(sql: Queryable, proposal: FactProposal): Promise<boolean> {
  const key = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const facts = await listUserFacts(sql);
  return facts.some((fact) => key(fact.topic) === key(proposal.topic) && fact.text === proposal.text && fact.label === 'L2');
}

/** The answer once the user decided a proposed fact, written without the model. It carries what the task read only. */
export async function proposeDecisionAnswer(sql: Sql, ctx: StepContext, decided: StoredApproval | undefined = ctx.approval): Promise<StepOutcome> {
  const proposal = decided === undefined ? undefined : factProposalOf(decided);
  if (decided === undefined || proposal === undefined) return { kind: 'wait-user', reason: 'the proposed fact is no longer readable', usage: { steps: 0 } };
  const saved = decided.state === 'approved' && (await savedAsProposed(sql, proposal));
  return answer(sql, ctx.task, ctx.runId, proposeAnswerText(proposal, decided.state, saved), ctx.task.effectiveLabel);
}

/** A step that proposed a fact before a crash: it waits again while pending, or answers once decided. */
export async function proposeReplay(sql: Sql, ctx: StepContext, turn: Turn): Promise<StepOutcome | undefined> {
  if (turn.answer.action !== 'call' || turn.answer.tool !== PROFILE_PROPOSE || turn.result !== WAITING_PROPOSE) return undefined;
  const [asked] = await sql<StoredApproval[]>`
    SELECT id::text, kind, action, detail, state FROM approvals
    WHERE task_id = ${ctx.task.id} AND kind = 'fact' AND (detail ->> 'step')::int = ${turn.step}
    ORDER BY requested_at DESC LIMIT 1`;
  if (asked === undefined) return undefined;
  if (asked.state === 'pending') return { kind: 'confirm', approvalId: asked.id, usage: { steps: 0 } };
  if (asked.state === 'expired') return undefined;
  return proposeDecisionAnswer(sql, ctx, asked);
}
