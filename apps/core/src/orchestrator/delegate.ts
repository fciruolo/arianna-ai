import { promptLabelOf, type AgentCard, type DelegateTarget, type LoadedAgent, type ToolId } from '@arianna/agents';
import { projectNamed, type AriannaConfig, type Project } from '@arianna/config';
import {
  changedToolConfig,
  fileFingerprints,
  CLAUDE_MODELS,
  gitConfigFingerprint,
  openRepository,
  repositoryChanges,
  repositoryHead,
  toolConfigFiles,
  WorkspaceError,
  type ClaudeExecutor,
  type ClaudeModel,
  type ClaudeTool,
  type FileChange,
  LocalModelError,
  type LocalModel,
  type OpenedRepository,
} from '@arianna/executors';
import { createContext, isAtMost, maxLabel, sha256Hex, type Label, type LabelRules } from '@arianna/policy';
import { MODEL_ALIASES, route, type ModelAlias, type RouteDecision } from '@arianna/router';

import { runClaudeStep } from '../claude-step.ts';
import { loadConversation, type Conversation, type Message } from '../conversations.ts';
import type { Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import type { RunUsage } from '../runs.ts';
import { applyDeclassifyIn, passGateway } from '../gateway.ts';
import { liveEditFailure, liveEditOf, postLiveEdit } from '../live-edit.ts';
import { ENTRY_TEXT, isEntryDelegation } from '../participants.ts';
import { openReply, postActivity, type ActivityKind } from '../reply.ts';
import type { Task } from '../tasks.ts';
import { updateDelegation, type Delegation } from './delegations.ts';
import { budgetOf, routerConfigOf } from './routing.ts';

/**
 * A step delegated to the Coder on Claude Code (task 1.10, second part,
 * D-055). The orchestrator's `task.delegate` call opens a delegation; the
 * next step of the same task is planned here: the router chooses executor
 * and model (the user's choice for the conversation first), a brief above
 * L1 waits for the user's declassification, Fable for the budget approval.
 * The run then goes through `runClaudeStep` in a workspace of the
 * conversation's repository, streams its text to the chat, and its report
 * becomes the result the next local step reads.
 */
export interface DelegateEnv {
  sql: Sql;
  agents: ReadonlyMap<string, LoadedAgent>;
  /** The current configuration: executors, projects, roles. */
  settings: () => AriannaConfig;
  rules: LabelRules;
  /**
   * Absent only when `claude` cannot run on this machine (sandbox refused):
   * whether it is enabled is `canDelegate`, read from `settings` at each use.
   */
  claude?: ClaudeExecutor;
  /** What Claude reads first when it answers a system chat directly; DIRECT_PROMPT by default (tests pick a scenario). */
  directPrompt?: string;
  /** The local model, for the agents that only answer (D-119, tappa T3); absent, they take no delegated step. */
  model?: () => LocalModel;
}

/** What the step with an open delegation will do. */
export type DelegationPlan =
  | { kind: 'cloud'; delegation: Delegation; decision: RouteDecision; model: ClaudeModel; label: Label; declassify?: { approvalId: string; to: Label } }
  /** An agent that only answers, on the local model (D-119, tappa T3). */
  | { kind: 'local'; delegation: Delegation; decision: RouteDecision; model: string; label: Label; declassify?: { approvalId: string; to: Label } }
  | { kind: 'budget'; delegation: Delegation; decision: RouteDecision; model: string }
  /** The project folder has uncommitted changes: the user approves first (D-056). */
  | { kind: 'workspace'; delegation: Delegation; repo: string; files: string[] }
  | { kind: 'retry'; delegation: Delegation; decision: RouteDecision; at: Date }
  /** Nothing runs: the delegation ends with this result and the local step goes on with it. */
  | { kind: 'closed'; delegation: Delegation; status: 'failed' | 'refused'; result: string; decision?: RouteDecision };

/** The orchestrator may offer `task.delegate` only when a cloud executor can take the step. */
export function canDelegate(env: DelegateEnv): boolean {
  return env.claude !== undefined && env.settings().cloud.executors.includes('claude');
}

/**
 * Where a delegated step of an agent runs (D-119, tappa T3): on Claude Code
 * in a project folder, like the Coder; or, for an agent without tools (the
 * template `answer`), in one call to the local model. Any other agent takes
 * no delegated step: the web tools of the template `web` do not exist yet.
 */
export type DelegationRoute = 'claude' | 'local';

export function delegationRoute(card: AgentCard): DelegationRoute | undefined {
  if (card.executors.includes('claude')) return 'claude';
  if (card.executors.includes('local') && card.tools.length === 0) return 'local';
  return undefined;
}

/**
 * The agents `assignee` may delegate to now: the Coder and the user's active
 * agents whose executor can run (Claude enabled, a local model there). The
 * Coder first, then by name, so that the prompt stays the same between steps.
 */
export function delegateTargets(env: DelegateEnv, assignee: string): DelegateTarget[] {
  const targets: DelegateTarget[] = [];
  for (const [name, agent] of env.agents) {
    if (name === assignee) continue;
    const where = delegationRoute(agent.card);
    if (where === 'claude' ? canDelegate(env) : where === 'local' && env.model !== undefined) targets.push({ name, description: agent.card.description });
  }
  const rank = (name: string): number => (name === 'coder' ? 0 : 1);
  return targets.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The highest label a brief to `card` may carry without the user's
 * declassification: L1 for a cloud run (the Coder's ceiling in the cloud),
 * the agent's own clearance for a local one.
 */
export function briefCeiling(card: AgentCard): Label {
  if (delegationRoute(card) === 'local') return card.maxLabel;
  return isAtMost(card.cloudMaxLabel ?? card.maxLabel, 'L1') ? (card.cloudMaxLabel ?? card.maxLabel) : 'L1';
}

/** The built-in tools of `claude -p` that a card's repository tools stand for. */
export function claudeToolsOf(tools: readonly ToolId[]): ClaudeTool[] {
  const out: ClaudeTool[] = [];
  if (tools.includes('repo.read')) out.push('Read', 'Glob', 'Grep');
  if (tools.includes('repo.write')) out.push('Edit', 'Write');
  if (tools.includes('repo.test')) out.push('Bash');
  return out;
}

/**
 * The project a delegated step works on (D-058): the conversation's, or the
 * only approved one when the conversation names none (a private conversation
 * has no project; the user approved that one for the cloud). A name no longer
 * approved stays as it is: opening it says so.
 */
export function repoFor(workspace: string | null | undefined, projects: readonly Project[]): string | undefined {
  if (workspace !== null && workspace !== undefined) return projectNamed(projects, workspace)?.name ?? workspace;
  return projects.length === 1 ? projects[0]?.name : undefined;
}

interface ApprovalRow {
  id: string;
  state: string;
  detail: Record<string, unknown>;
}

/** The latest declassification asked for this exact brief. */
async function declassificationOf(sql: Sql, delegation: Delegation): Promise<ApprovalRow | undefined> {
  const [row] = await sql<ApprovalRow[]>`
    SELECT id::text, state, detail FROM approvals
    WHERE task_id = ${delegation.taskId} AND kind = 'declassify' AND detail ->> 'sha256' = ${sha256Hex(delegation.brief)}
    ORDER BY requested_at DESC, id DESC LIMIT 1`;
  return row;
}

/** The latest approval asked for working over uncommitted changes, for this delegation. */
async function workspaceApprovalOf(sql: Sql, delegation: Delegation): Promise<ApprovalRow | undefined> {
  const [row] = await sql<ApprovalRow[]>`
    SELECT id::text, state, detail FROM approvals
    WHERE task_id = ${delegation.taskId} AND kind = 'workspace' AND (detail ->> 'step')::int = ${delegation.step}
    ORDER BY requested_at DESC, id DESC LIMIT 1`;
  return row;
}

/**
 * The direct chat of a task (D-111): its conversation, when the delegated
 * agent answers there in place of Arianna. Undefined otherwise.
 */
export async function directChatOf(sql: Sql, task: Task, agent: string): Promise<Conversation | undefined> {
  if (task.conversationId === null) return undefined;
  const conversation = await loadConversation(sql, task.conversationId);
  return conversation?.agent === agent ? conversation : undefined;
}

/**
 * What the user's consent covers in a direct chat (D-111, risposta 9): the
 * files the agent changed in the earlier answers of the conversation (it does
 * not commit, so the folder stays dirty of its own work) and the files of the
 * consents the user already gave there. Any other dirty file is asked again.
 */
async function directChatCovered(sql: Sql, conversationId: string, agent: string): Promise<Set<string>> {
  const rows = await sql<{ path: string }[]>`
    SELECT f.value ->> 'path' AS path FROM task_delegations d
      JOIN tasks t ON t.id = d.task_id, jsonb_array_elements(coalesce(d.files, '[]'::jsonb)) f
      WHERE t.conversation_id = ${conversationId} AND d.agent = ${agent} AND d.status = 'ok'
    UNION
    SELECT f.value ->> 'from' FROM task_delegations d
      JOIN tasks t ON t.id = d.task_id, jsonb_array_elements(coalesce(d.files, '[]'::jsonb)) f
      WHERE t.conversation_id = ${conversationId} AND d.agent = ${agent} AND d.status = 'ok' AND f.value ? 'from'
    UNION
    SELECT jsonb_array_elements_text(a.detail -> 'files') FROM approvals a
      JOIN tasks t ON t.id = a.task_id
      WHERE t.conversation_id = ${conversationId} AND a.kind = 'workspace' AND a.state = 'approved' AND jsonb_typeof(a.detail -> 'files') = 'array'`;
  return new Set(rows.map((row) => row.path).filter((path) => typeof path === 'string'));
}

/**
 * What the Coder reads after its prompt in the direct chat (D-111): our fixed
 * text, L0. An instruction to the model, not a control: scanner and gateway
 * stay the nets.
 */
export const DIRECT_CHAT_TEXT = [
  'You are in a direct chat with the user inside Arianna, without Arianna in between: each message of the user reaches you as it is, and your answer is shown to the user as it is.',
  'Answer in the language of the user, as in a chat: say what you did and what is left, briefly.',
  'Never ask the user for credentials, personal data, or commands to run outside the project.',
].join(' ');

/** What Arianna reads when no project is there for the Coder. */
export const NO_PROJECT = 'no project for the Coder: the user opens a work conversation with one of the approved projects (pnpm arianna:init --reconfigure adds one)';

/** Opens the project folder of a delegation, or says why the step cannot run there. */
async function folderOf(env: DelegateEnv, delegation: Delegation): Promise<{ opened: OpenedRepository; repo: string; label: Label } | { error: string }> {
  const repo = delegation.repo;
  if (repo === null) return { error: NO_PROJECT };
  const config = env.settings();
  // Read again at every attempt: a project taken off the list closes the delegation.
  const project = projectNamed(config.projects, repo);
  if (project === undefined) return { error: `the project ${repo} is no longer among the projects the user approved: tell the user` };
  let opened: OpenedRepository;
  try {
    opened = await openRepository({ home: config.home, project });
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return { error: `the folder of ${repo} cannot be opened: ${error.message}` };
  }
  if (opened.path === undefined) {
    const kinds = opened.decision.decision === 'block' ? [...new Set(opened.decision.findings.map((finding) => finding.kind))].join(', ') : '';
    return { error: `the repository ${repo} cannot go to the cloud (${opened.decision.reason}${kinds === '' ? '' : `: ${kinds}`})` };
  }
  return { opened, repo, label: project.label };
}

/** The latest budget approval asked for this delegation. */
async function budgetApprovalOf(sql: Sql, delegation: Delegation): Promise<ApprovalRow | undefined> {
  const [row] = await sql<ApprovalRow[]>`
    SELECT id::text, state, detail FROM approvals
    WHERE task_id = ${delegation.taskId} AND kind = 'budget' AND (detail ->> 'step')::int = ${delegation.step}
    ORDER BY requested_at DESC, id DESC LIMIT 1`;
  return row;
}

const TOOL = 'task.delegate';
/** Quota refusals of one delegation before it fails: a blocked executor does not keep a task at work for days. */
export const MAX_QUOTA_RETRIES = 5;

export async function planDelegation(env: DelegateEnv, task: Task, delegation: Delegation): Promise<DelegationPlan> {
  const closed = (status: 'failed' | 'refused', result: string, decision?: RouteDecision): DelegationPlan => ({
    kind: 'closed',
    delegation,
    status,
    result: `error: ${TOOL}: ${result}`,
    ...(decision === undefined ? {} : { decision }),
  });
  const agent = env.agents.get(delegation.agent);
  if (agent === undefined) return closed('failed', `no agent card for ${delegation.agent}`);
  const where = delegationRoute(agent.card);
  if (where === undefined) return closed('failed', `${delegation.agent} does not take delegated steps`);

  // A brief above what the agent may read leaves only as the exact text the user approved.
  let label = delegation.label;
  let declassify: { approvalId: string; to: Label } | undefined;
  const ceiling = briefCeiling(agent.card);
  if (!isAtMost(label, ceiling)) {
    const approval = await declassificationOf(env.sql, delegation);
    if (approval?.state !== 'approved') {
      const to = where === 'local' ? `to ${delegation.agent}` : 'to the cloud';
      return closed('refused', `the user did not approve sending the brief ${to}: do what you can here, or tell the user`);
    }
    const to = approval.detail.to;
    if ((to !== 'L0' && to !== 'L1') || !isAtMost(to, ceiling)) return closed('failed', `the declassification does not say a label ${delegation.agent} may read`);
    declassify = { approvalId: approval.id, to };
    label = to;
  }

  if (where === 'local') {
    // One call to the local model: no folder, no quota; the router checks the label against the agent.
    const decision = route({ kind: 'judge', agent: agent.card, text: delegation.brief }, createContext(task.clearance, label), await budgetOf(env.sql), routerConfigOf(env.settings()));
    if (decision.decision === 'wait') return closed('failed', `no local model can take this step now (${decision.reason})`, decision);
    if (decision.locality !== 'local' || env.model === undefined) return closed('failed', `${delegation.agent} runs on the local model only, which is not available for this step`, decision);
    return { kind: 'local', delegation, decision, model: decision.model, label, ...(declassify === undefined ? {} : { declassify }) };
  }

  // The folder itself (D-056): with changes the user has not committed, the launch waits for their word.
  const folder = await folderOf(env, delegation);
  if ('error' in folder) return closed('failed', folder.error);
  const dirty = folder.opened.dirty ?? [];
  if (dirty.length > 0) {
    const consent = await workspaceApprovalOf(env.sql, delegation);
    if (consent?.state === 'rejected' || consent?.state === 'expired') {
      return closed('refused', 'the user did not want the Coder to work over uncommitted changes: tell the user, or wait for them to commit');
    }
    // The consent covers the files it named: paths dirtied since are asked again.
    const covered = new Set(consent?.state === 'approved' && Array.isArray(consent.detail.files) ? consent.detail.files.map(String) : []);
    // In the direct chat the consent is for the conversation (D-111).
    const direct = await directChatOf(env.sql, task, delegation.agent);
    if (direct !== undefined) for (const path of await directChatCovered(env.sql, direct.id, delegation.agent)) covered.add(path);
    if (dirty.some((path) => !covered.has(path))) return { kind: 'workspace', delegation, repo: folder.repo, files: dirty };
  }

  // Every attempt is a cloud run of the task from the delegating step on (the delegating step itself is
  // local, except in the direct chat, where the first attempt runs at it, D-111); the quota ones failed.
  const [refusals] = await env.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM runs
    WHERE task_id = ${delegation.taskId} AND step >= ${delegation.step} AND locality = 'cloud' AND status = 'failed'`;
  if ((refusals?.count ?? 0) >= MAX_QUOTA_RETRIES) {
    return closed('failed', `${String(MAX_QUOTA_RETRIES)} attempts refused by the executor: tell the user, or try again later`);
  }

  const budget = await budgetApprovalOf(env.sql, delegation);
  if (budget?.state === 'rejected' || budget?.state === 'expired') {
    return closed('refused', `the user did not approve the budget for ${String(budget.detail.model)}: delegate without naming that model, or tell the user`);
  }

  const conversation = task.conversationId === null ? undefined : await loadConversation(env.sql, task.conversationId);
  const preferred = conversation?.model;
  const preferredModel = preferred !== null && preferred !== undefined && (MODEL_ALIASES as readonly string[]).includes(preferred) ? { preferredModel: preferred as ModelAlias } : {};
  const decision = route(
    { kind: 'coding', agent: agent.card, text: delegation.brief, budgetApproved: budget?.state === 'approved', ...preferredModel },
    createContext(task.clearance, label),
    await budgetOf(env.sql),
    routerConfigOf(env.settings()),
  );
  if (decision.decision === 'wait') {
    if (decision.next === 'retry-later' && decision.retryAt !== undefined) return { kind: 'retry', delegation, decision, at: new Date(decision.retryAt) };
    return closed('failed', `no executor can take this step now (${decision.reason})`, decision);
  }
  if (decision.executor !== 'claude' || env.claude === undefined) {
    return closed('failed', 'the Coder runs delegated steps on Claude Code only, which is not available for this step', decision);
  }
  const model = (CLAUDE_MODELS as readonly string[]).includes(decision.model) ? (decision.model as ClaudeModel) : undefined;
  if (model === undefined) return closed('failed', `claude has no model ${decision.model}`, decision);
  if (decision.approval === 'budget') return { kind: 'budget', delegation, decision, model };
  return { kind: 'cloud', delegation, decision, model, label, ...(declassify === undefined ? {} : { declassify }) };
}

async function show(sql: Sql, task: Task, step: number, kind: ActivityKind, detail = ''): Promise<void> {
  if (task.conversationId === null) return;
  await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind, detail }).catch(() => undefined);
}

/** Ends a delegation with an error the next local step reads; never fails the step. */
async function close(env: DelegateEnv, task: Task, step: number, delegation: Delegation, status: 'failed' | 'refused', result: string): Promise<void> {
  await updateDelegation(env.sql, delegation.id, { status, result, resultLabel: delegation.label });
  await show(env.sql, task, step, 'error', result.replace(/^error: [^:]+: /, ''));
}

/** At most this many changed files are kept for the chat (the database refuses more). */
export const MAX_STORED_FILES = 500;
const STORABLE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\p{Cc}]{1,1024}$/u;

/**
 * The changes the chat may list (D-082): paths relative to the project as git
 * wrote them, a known kind, at most MAX_STORED_FILES. A path the database
 * would refuse (a control character in the name) is left out of the list;
 * Arianna still reads it in the text of the result.
 */
export function storableFiles(changes: readonly FileChange[]): FileChange[] {
  const kinds: readonly string[] = ['added', 'modified', 'deleted', 'renamed'];
  return changes
    .filter((item) => STORABLE_PATH.test(item.path) && kinds.includes(item.change))
    .filter((item) => (item.change === 'renamed') === (item.from !== undefined) && (item.from === undefined || STORABLE_PATH.test(item.from)))
    .slice(0, MAX_STORED_FILES)
    .map((item) => (item.from === undefined ? { path: item.path, change: item.change } : { path: item.path, change: item.change, from: item.from }));
}

/** The declassification of a plan, once: the lowered label is written with its label_changes row. */
async function applyPlannedDeclassify(env: DelegateEnv, task: Task, delegation: Delegation, declassify: { approvalId: string; to: Label } | undefined): Promise<Label> {
  const label = delegation.label;
  if (declassify === undefined || isAtMost(label, declassify.to)) return label;
  const { approvalId, to } = declassify;
  await env.sql.begin(async (tx) => {
    await applyDeclassifyIn(tx, { value: delegation.brief, label, source: `task:${task.id}` }, to, approvalId);
    await updateDelegation(tx, delegation.id, { label: to });
  });
  return to;
}

/**
 * A crash after the report was stored, before the delegation was closed: the
 * run is not launched again, the stored report is the result. Only a report
 * written after this delegation and taken by no other one: the report of an
 * earlier delegation of the same task is never this one's (0.6.1). True when so.
 */
async function closeFromStored(sql: Sql, task: Task, delegation: Delegation): Promise<boolean> {
  const [stored] = await sql<Pick<Message, 'id' | 'body' | 'label'>[]>`
    SELECT m.id::text, m.body, m.label FROM messages m
    WHERE m.task_id = ${task.id} AND m.agent = ${delegation.agent}
      AND m.ts >= (SELECT created_at FROM task_delegations WHERE id = ${delegation.id})
      AND NOT EXISTS (SELECT FROM task_delegations d WHERE d.task_id = ${task.id} AND d.message_id = m.id)
    ORDER BY m.id DESC LIMIT 1`;
  if (stored === undefined) return false;
  await updateDelegation(sql, delegation.id, { status: 'ok', result: stored.body, resultLabel: stored.label, messageId: stored.id });
  return true;
}

/**
 * The prompt of an agent as the gateway reads it: one of agents/ is in git
 * (L0), one written by the user is L1 by declaration (D-119), also once
 * promoted (`prompt_label`, tappa T3b).
 */
function promptPart(agent: LoadedAgent, name: string): { text: string; label: Label; source: string } {
  return { text: agent.prompt, label: promptLabelOf(agent), source: `agent:${name}` };
}

/**
 * The limits of a Claude run for an agent written from the Agents page (a
 * card of data/agents, or promoted with its `prompt_label`): the steps and
 * minutes the user chose (tappa T3b). The cards in git keep the executor's
 * defaults, as before.
 */
export function runLimitsOf(agent: LoadedAgent): { maxTurns?: number; timeoutMs?: number } {
  if (agent.origin !== 'user' && agent.card.promptLabel === undefined) return {};
  return { maxTurns: agent.card.limits.maxSteps, timeoutMs: agent.card.limits.maxMinutes * 60_000 };
}

/** The cloud step: the plan is `cloud`. */
export async function runDelegation(env: DelegateEnv, ctx: StepContext, plan: Extract<DelegationPlan, { kind: 'cloud' }>): Promise<StepOutcome> {
  const { task, step, runId } = ctx;
  const { delegation } = plan;
  const { sql } = env;
  const claude = env.claude;
  if (claude === undefined) throw new Error('claude is not available');
  const failed = async (result: string): Promise<StepOutcome> => {
    await close(env, task, step, delegation, 'failed', `error: ${TOOL}: ${result}`);
    return { kind: 'continue', usage: { steps: 1 } };
  };
  const agent = env.agents.get(delegation.agent);
  // A user agent deactivated between the plan and the run (D-119): the delegation fails, the task goes on.
  if (agent === undefined) return failed(`${delegation.agent} is no longer active`);

  const label = await applyPlannedDeclassify(env, task, delegation, plan.declassify);
  if (await closeFromStored(sql, task, delegation)) return { kind: 'continue', usage: { steps: 1 } };

  // The project folder itself (D-056), opened again at every attempt: nothing is copied.
  const folder = await folderOf(env, delegation);
  if ('error' in folder) return failed(folder.error);
  const workspace = folder.opened;
  const { repo } = folder;
  // What the live changes of the run carry (D-117): the project's label, or the brief's when higher.
  const editLabel = maxLabel(folder.label, label);
  const before = new Set(workspace.dirty ?? []);
  const path = workspace.path ?? '';
  // The files the user had already changed: the ones the run changes again are told too (D-117).
  const dirtyPrints = await fileFingerprints(path, [...before]).catch(() => new Map<string, string>());
  // Taken before the run: a run that rewrote .git/config, hooks or .gitattributes is caught after it.
  const fingerprint = await gitConfigFingerprint(path);
  // Tool configuration (.claude/, .envrc, .vscode/...), ignored by git or not: what changed is told to the user.
  const tools = await toolConfigFiles(path);
  await updateDelegation(sql, delegation.id, { status: 'running', executor: 'claude', model: plan.model, runId });
  await show(sql, task, step, 'delegate', `${delegation.agent} · claude/${plan.model}`);

  // The Coder's own prompt, then the brief: both leave through the gateway.
  // At its first delegation in this conversation the agent also reads how to enter it (D-125): our fixed text, L0.
  const entry = await isEntryDelegation(sql, delegation.id);
  // In the direct chat it reads how to talk with the user without Arianna (D-111): our fixed text, L0.
  const direct = (await directChatOf(sql, task, delegation.agent)) !== undefined;
  const brief = [
    promptPart(agent, delegation.agent),
    ...(entry ? [{ text: ENTRY_TEXT, label: 'L0' as const, source: 'arianna:entry' }] : []),
    ...(direct ? [{ text: DIRECT_CHAT_TEXT, label: 'L0' as const, source: 'arianna:direct' }] : []),
    { text: delegation.brief, label, source: `task:${task.id}` },
  ];
  const reply = task.conversationId === null ? undefined : await openReply(sql, task.id, { runId, agent: delegation.agent });
  let streamed = 0;
  const result = await runClaudeStep(sql, claude, ctx, {
    // The run has read only the brief and the agent's prompt (docs/PRIVACY-POLICY-SPEC.md): a context of its own,
    // at the higher of the two labels, as the local run (a prompt of the user is L1, tappa T3b).
    context: createContext(task.clearance, maxLabel(label, promptLabelOf(agent))),
    brief,
    workspace,
    model: plan.model,
    tools: claudeToolsOf(agent.card.tools),
    ...runLimitsOf(agent),
    summary: `delegated step for ${delegation.agent}`,
    onEvent: async (event) => {
      if (event.type === 'text') {
        // One block per model message: separated, so that the chat reads them as paragraphs.
        await reply?.delta(`${streamed === 0 ? '' : '\n\n'}${event.text}`);
        streamed += 1;
      } else if (event.type === 'edit') {
        // A change to a file, as a small diff in the activity card (D-117): live only, never stored.
        const edit = path === '' ? undefined : liveEditOf(event, { root: path, label: editLabel });
        if (task.conversationId !== null && edit !== undefined && isAtMost(edit.label, task.clearance)) {
          await postLiveEdit(sql, { conversationId: task.conversationId, taskId: task.id, step }, edit).catch((error: unknown) => {
            // The run goes on; the log says only the kind of error, never the text of a file.
            console.error(liveEditFailure(error));
          });
        }
      } else {
        await show(sql, task, step, 'tool', event.name);
      }
    },
  });

  switch (result.kind) {
    case 'answer': {
      // No git command of Arianna's runs in a folder whose git configuration the run changed: the user looks first.
      if ((await gitConfigFingerprint(path)) !== fingerprint) {
        await close(env, task, step, delegation, 'failed', `error: ${TOOL}: the run changed the git configuration of the project ${repo} (.git/config, hooks or .gitattributes): the user must check that folder before using git there`);
        return { kind: 'continue', usage: result.usage };
      }
      // What the Coder left changed in the folder, for Arianna to tell the user; its own report is stored as it is.
      // The commit the changes are against (D-117): the chat diffs each file from it later.
      const head = await repositoryHead(path).catch(() => undefined);
      const after = await repositoryChanges(path).catch(() => undefined);
      const again = await fileFingerprints(path, [...before]).catch(() => new Map<string, string>());
      const changed = (after ?? []).filter((item) => !before.has(item.path) || dirtyPrints.get(item.path) !== again.get(item.path));
      // Saved before the report (D-082): the chat lists them under it as soon as it appears.
      if (after !== undefined) await updateDelegation(sql, delegation.id, { files: storableFiles(changed), ...(typeof head === 'string' ? { baseCommit: head } : {}) });
      const report = result.result.text.trim() === '' ? '(the Coder gave no report)' : result.result.text;
      const toolChanges = changedToolConfig(tools, await toolConfigFiles(path).catch(() => new Map([['(unreadable)', '']])));
      const text = [
        report,
        ...(changed.length === 0 ? [] : [`Files changed in the project ${repo} (uncommitted, on branch ${workspace.branch ?? ''}): ${changed.map((item) => item.path).join(', ')}`]),
        // Run by other tools when the user opens the folder with them, outside any sandbox: the user must know.
        ...(toolChanges.length === 0
          ? []
          : [`Tool configuration changed by the Coder in ${repo}, which can run code when the user opens the folder with that tool (tell the user to check it): ${toolChanges.join(', ')}`]),
      ].join('\n\n');
      let messageId: string | undefined;
      if (reply !== undefined) {
        const saved = await reply.finish(report, result.result.label);
        if (!saved.stored) {
          // The report cannot be shown to the user (a vault value in it, or above the conversation): it is not read either.
          const why = saved.reason === 'blocked' ? `the gateway refused the report (${saved.decision.reason})` : 'the report is above what the conversation may hold';
          await close(env, task, step, delegation, 'failed', `error: ${TOOL}: ${why}`);
          return { kind: 'continue', usage: result.usage };
        }
        messageId = saved.message.id;
      }
      await updateDelegation(sql, delegation.id, {
        status: 'ok',
        result: text,
        resultLabel: result.result.label,
        sessionRef: result.result.sessionRef,
        ...(messageId === undefined ? {} : { messageId }),
      });
      return { kind: 'continue', usage: result.usage };
    }
    case 'blocked':
      await close(env, task, step, delegation, 'failed', `error: ${TOOL}: the gateway refused the brief (${result.decision.reason})`);
      return { kind: 'continue', usage: { steps: 1 } };
    case 'quota': {
      // Back to pending: the same step runs again when the subscription takes requests.
      await updateDelegation(sql, delegation.id, { status: 'pending' });
      // A reset time already past (or none): an hour, so that a stale clock does not loop.
      const at = result.resetsAt !== undefined && result.resetsAt.getTime() > Date.now() ? result.resetsAt : new Date(Date.now() + 60 * 60_000);
      await show(sql, task, step, 'wait', `claude · ${at.toISOString()}`);
      return { kind: 'retry', at, reason: result.overage ? 'claude is on paid extra usage' : 'claude is out of quota', usage: result.usage };
    }
    case 'failed':
      await close(env, task, step, delegation, 'failed', `error: ${TOOL}: ${result.reason}`);
      return { kind: 'continue', usage: result.usage };
  }
}

/** Longest report of an agent that only answers (characters). */
export const MAX_LOCAL_REPORT = 6000;
export const LOCAL_REPORT_SCHEMA_NAME = 'agent_report';
/**
 * One string field, applied from the first token (constrained decoding, as
 * for the summaries): a reasoning model cannot write its reasoning in place
 * of the report.
 */
const LOCAL_REPORT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: { report: { type: 'string', minLength: 1, maxLength: MAX_LOCAL_REPORT } },
  required: ['report'],
  additionalProperties: false,
};

/** What an agent that only answers reads before its own prompt: the frame is ours, the rest is the user's. */
export const LOCAL_FRAME = [
  'You are an agent of Arianna, a personal assistant. Arianna hands you one step of a task with a brief: the next message.',
  'Do what the brief asks, following your instructions below, and write only the result in the field "report" of the JSON object, in the language of the brief.',
  'You have no tools: you cannot read files, search or act; if the brief needs that, say so in the report.',
  'Your instructions:',
].join('\n');

/**
 * What an agent that only answers reads first: the frame, its instructions,
 * and at its first delegation in a conversation how to enter it (D-125).
 */
export function localSystem(instructions: string, entry: boolean): string {
  return `${LOCAL_FRAME}\n${instructions}${entry ? `\n\n${ENTRY_TEXT}` : ''}`;
}

/**
 * The step of an agent that only answers (D-119, tappa T3): one call to the
 * local model with the agent's prompt and the brief, through the gateway.
 * The report goes to the chat as the agent's message, and becomes the result
 * Arianna reads at the next step; it carries the highest label of the two.
 */
export async function runLocalDelegation(env: DelegateEnv, ctx: StepContext, plan: Extract<DelegationPlan, { kind: 'local' }>): Promise<StepOutcome> {
  const { task, step, runId } = ctx;
  const { delegation } = plan;
  const { sql } = env;
  const failed = async (result: string, usage: RunUsage = { steps: 1 }): Promise<StepOutcome> => {
    await close(env, task, step, delegation, 'failed', `error: ${TOOL}: ${result}`);
    return { kind: 'continue', usage };
  };
  const agent = env.agents.get(delegation.agent);
  // Deactivated between the plan and the run: the delegation fails, the task goes on.
  if (agent === undefined) return failed(`${delegation.agent} is no longer active`);
  const model = env.model;
  if (model === undefined) return failed('no local model for the agents');

  const label = await applyPlannedDeclassify(env, task, delegation, plan.declassify);
  if (await closeFromStored(sql, task, delegation)) return { kind: 'continue', usage: { steps: 1 } };

  await updateDelegation(sql, delegation.id, { status: 'running', executor: 'local', model: plan.model, runId });
  await show(sql, task, step, 'delegate', `${delegation.agent} · local/${plan.model}`);

  const prompt = promptPart(agent, delegation.agent);
  const parts = [prompt, { text: delegation.brief, label, source: `task:${task.id}` }];
  const read = maxLabel(prompt.label, label);
  const decision = await passGateway(
    sql,
    parts.map((part) => ({ value: part.text, label: part.label, source: part.source })),
    createContext(task.clearance, read),
    { kind: 'executor', id: 'local', locality: 'local' },
    { taskId: task.id, runId },
  );
  if (decision.decision === 'block') return failed(`the gateway refused the brief (${decision.reason})`);
  const [instructions, brief] = decision.texts;
  if (instructions === undefined || brief === undefined || decision.texts.length !== 2) throw new Error('the gateway allowed a different number of texts');

  const entry = await isEntryDelegation(sql, delegation.id);
  let report: string;
  const usage = { steps: 1, tokensIn: 0, tokensOut: 0 };
  try {
    const result = await model().chat({
      model: plan.model,
      messages: [
        { role: 'system', content: localSystem(instructions, entry) },
        { role: 'user', content: brief },
      ],
      schema: { name: LOCAL_REPORT_SCHEMA_NAME, schema: LOCAL_REPORT_SCHEMA },
      temperature: 0,
      maxTokens: 4096,
      signal: ctx.signal,
    });
    usage.tokensIn = result.usage?.promptTokens ?? 0;
    usage.tokensOut = result.usage?.completionTokens ?? 0;
    if (result.finishReason === 'length') return await failed(`the answer of ${delegation.agent} was cut`, usage);
    const value: unknown = result.value;
    const text = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { report?: unknown }).report : undefined;
    if (typeof text !== 'string' || text.trim() === '') return await failed(`${delegation.agent} gave no report`, usage);
    report = text.trim();
  } catch (error) {
    // Stopped by the user or the engine: the engine decides.
    if (ctx.signal.aborted) throw error;
    if (error instanceof LocalModelError) return failed(`the local model did not answer (${error.kind})`);
    throw error;
  }

  // Shown in the chat as the agent's message; a report the chat cannot hold is not read either.
  let messageId: string | undefined;
  if (task.conversationId !== null) {
    const reply = await openReply(sql, task.id, { runId, agent: delegation.agent });
    const saved = await reply.finish(report, read);
    if (!saved.stored) {
      const why = saved.reason === 'blocked' ? `the gateway refused the report (${saved.decision.reason})` : 'the report is above what the conversation may hold';
      return failed(why, usage);
    }
    messageId = saved.message.id;
  }
  await updateDelegation(sql, delegation.id, { status: 'ok', result: report, resultLabel: read, ...(messageId === undefined ? {} : { messageId }) });
  return { kind: 'continue', usage };
}
