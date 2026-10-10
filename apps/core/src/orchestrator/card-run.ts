import type { AgentCard } from '@arianna/agents';
import { projectNamed, workParts } from '@arianna/config';
import { isAtMost, maxLabel, type Label } from '@arianna/policy';

import { isExecutorChoice, type ExecutorChoice } from '../approvals.ts';
import { CHAT_AGENT } from '../conversations.ts';
import type { Queryable } from '../db/client.ts';
import type { StepOutcome } from '../engine.ts';
import type { Task } from '../tasks.ts';
import { availableCloud, CLOUD_DELEGATES, delegationRoute, isCloudRoute, repoFor, type CloudExecutor, type DelegateEnv } from './delegate.ts';
import type { Delegation } from './delegations.ts';

/**
 * The cards of the agents that run (I-13 tappa C3, D-159). A card is a task
 * without a conversation; one assigned to an agent runs through the engine
 * like any task. Its first step chooses the way: for an agent with cloud
 * executors, the way of a delegation (delegate.ts: sandbox, gateway,
 * `cloud_max_label`, an approved project with its folder), with the card
 * itself as the brief; otherwise the local model, as a task without a
 * conversation always ran. For an agent with `executor_choice: ask` the user
 * chooses first, among the ways allowed for that card (an approval of kind
 * `executor`). The report ends in the card, which goes to "Da verificare".
 */

/** The action of an approval of kind `executor` (migration 0045). */
export const EXECUTOR_ACTION = 'card.executor';

/** Why a way is not offered for a card: above what the cloud may read, no approved project, the executor off. */
export type ExcludedReason = 'label' | 'project' | 'off';

export interface ExecutorOptions {
  /** The ways the user may choose, in this order: Claude, Codex, the local model. */
  options: ExecutorChoice[];
  /** The executors of the card left out, with why: the chat tells the user. */
  excluded: { executor: ExecutorChoice; reason: ExcludedReason }[];
}

/** A card an agent works on: no conversation, assigned to an agent that is not Arianna. */
export function isAgentCard(task: Pick<Task, 'conversationId' | 'assignee'>): boolean {
  return task.conversationId === null && task.assignee !== 'user' && task.assignee !== CHAT_AGENT;
}

/** What the card's brief carries: everything written on it so far. */
export function cardLabel(task: Pick<Task, 'label' | 'effectiveLabel'>): Label {
  return maxLabel(task.label, task.effectiveLabel);
}

/** The project of a card as a delegation names it, or undefined when the user approved no folder for it. */
export function cardRepo(env: Pick<DelegateEnv, 'settings'>, task: Pick<Task, 'project'>): string | undefined {
  const parts = workParts(env.settings().projects);
  const repo = repoFor(task.project, parts);
  return repo !== undefined && projectNamed(parts, repo) !== undefined ? repo : undefined;
}

/**
 * The ways a card of `card` may run now (D-159): a cloud executor of the card
 * only when the card is within what the agent may send to the cloud (its
 * `cloud_max_label`, at most L1), its project is approved with a folder and
 * the executor is on; the local model whenever the card names it and a local
 * model serves the agents.
 */
export function executorOptions(env: Pick<DelegateEnv, 'claude' | 'codex' | 'settings' | 'model'>, card: AgentCard, task: Pick<Task, 'project' | 'label' | 'effectiveLabel'>): ExecutorOptions {
  const options: ExecutorChoice[] = [];
  const excluded: ExecutorOptions['excluded'] = [];
  const available: readonly string[] = availableCloud(env);
  // What the agent's cloud executors may read (its cloud_max_label, never above L1), as for a delegated brief.
  const withinCloud = isAtMost(cardLabel(task), card.cloudMaxLabel ?? card.maxLabel) && isAtMost(cardLabel(task), 'L1');
  const repo = cardRepo(env, task);
  for (const executor of CLOUD_DELEGATES) {
    if (!card.executors.includes(executor)) continue;
    if (!withinCloud) excluded.push({ executor, reason: 'label' });
    else if (repo === undefined) excluded.push({ executor, reason: 'project' });
    else if (!available.includes(executor)) excluded.push({ executor, reason: 'off' });
    else options.push(executor);
  }
  if (card.executors.includes('local')) {
    if (env.model === undefined) excluded.push({ executor: 'local', reason: 'off' });
    else options.push('local');
  }
  return { options, excluded };
}

/**
 * The way of a card of an agent that does not ask (D-159): its cloud route
 * when one of its cloud executors is on and the project is approved (the
 * router chooses between them, and a card above the agent's cloud ceiling
 * leaves only as the text the user approves); else the local model, when the
 * card names it. Undefined: no way now.
 */
export function defaultWay(env: Pick<DelegateEnv, 'claude' | 'codex' | 'settings' | 'model'>, card: AgentCard, task: Pick<Task, 'project'>): 'cloud' | 'local' | undefined {
  const route = delegationRoute(card);
  const available: readonly string[] = availableCloud(env);
  if (isCloudRoute(route) && card.executors.some((executor) => available.includes(executor)) && cardRepo(env, task) !== undefined) return 'cloud';
  if (card.executors.includes('local') && env.model !== undefined) return 'local';
  return undefined;
}

/** The brief of a card's delegation: what the user wrote on it, as the agent reads it. */
export function cardBrief(task: Pick<Task, 'title' | 'goal' | 'doneCriteria' | 'project'>): string {
  return [
    `Card: ${task.title}`,
    ...(task.project === null ? [] : [`Project: ${task.project}`]),
    ...(task.goal === null || task.goal.trim() === '' ? [] : [`What to do:\n${task.goal.trim()}`]),
    ...(task.doneCriteria === null || task.doneCriteria.trim() === '' ? [] : [`Done when:\n${task.doneCriteria.trim()}`]),
  ].join('\n\n');
}

/** The executor the user chose in an approved approval, or undefined. */
export function choiceOf(approval: { kind: string; state: string; choice?: string | null } | undefined): ExecutorChoice | undefined {
  if (approval?.kind !== 'executor' || approval.state !== 'approved') return undefined;
  return isExecutorChoice(approval.choice) ? approval.choice : undefined;
}

/** The latest executor the user chose for the card, from its approvals; undefined when none. */
export async function chosenExecutor(sql: Queryable, taskId: string): Promise<ExecutorChoice | undefined> {
  const [row] = await sql<{ choice: string | null }[]>`
    SELECT choice FROM approvals WHERE task_id = ${taskId} AND kind = 'executor' AND state = 'approved'
    ORDER BY decided_at DESC, id DESC LIMIT 1`;
  return isExecutorChoice(row?.choice) ? row.choice : undefined;
}

/** The choice of executor still waiting for the user, if any. */
export async function pendingExecutorApproval(sql: Queryable, taskId: string): Promise<string | undefined> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id::text FROM approvals WHERE task_id = ${taskId} AND kind = 'executor' AND state = 'pending'
    ORDER BY requested_at DESC, id DESC LIMIT 1`;
  return row?.id;
}

/**
 * Asks the user where the card runs: the options and the executors left out
 * (names only), with the card's title, at the card's label.
 */
export async function requestExecutor(sql: Queryable, task: Task, step: number, agent: string, choices: ExecutorOptions): Promise<string> {
  const detail = { title: task.title, agent, options: choices.options, excluded: choices.excluded.map((item) => ({ ...item })), step };
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${task.id}, 'executor', ${EXECUTOR_ACTION}, ${sql.json(detail)}, ${cardLabel(task)}::privacy_label)
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO approvals returned no row');
  return row.id;
}

/** The cloud executor of a choice, for the router; undefined for the local model. */
export function cloudOf(choice: ExecutorChoice | undefined): CloudExecutor | undefined {
  return choice === 'claude' || choice === 'codex' ? choice : undefined;
}

/**
 * How a card's step ends after its delegation (D-159): done with the
 * delegation as evidence, for the user to verify; or waiting for the user
 * with why it ended without a report. Any other outcome stays as it is.
 */
export function cardEnd(task: Pick<Task, 'assignee'>, delegation: Delegation | undefined, outcome: StepOutcome): StepOutcome {
  if (outcome.kind !== 'continue') return outcome;
  const usage = outcome.usage === undefined ? {} : { usage: outcome.usage };
  if (delegation?.status === 'ok') return { kind: 'done', evidence: [{ kind: 'delegation', ref: delegation.id }], ...usage };
  const why = (delegation?.result ?? 'the work did not end').replace(/^error: [^:]+: /, '');
  return { kind: 'wait-user', reason: `${task.assignee} could not finish the card: ${why}`, ...usage };
}
