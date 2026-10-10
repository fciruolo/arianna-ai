import { promptLabelOf, type AgentCard, type DelegateTarget, type LoadedAgent, type ToolId } from '@arianna/agents';
import { projectNamed, workParts, type AriannaConfig, type Project } from '@arianna/config';
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
  CODEX_MODELS,
  type ClaudeError,
  type ClaudeExecutor,
  type CodexAccess,
  type CodexError,
  type CodexExecutor,
  type CodexModel,
  type ClaudeModel,
  type ClaudeTool,
  type FileChange,
  LocalModelError,
  type LocalModel,
  type OpenedRepository,
} from '@arianna/executors';
import { createContext, isAtMost, maxLabel, sha256Hex, type Label, type LabelRules } from '@arianna/policy';
import { MODEL_ALIASES, route, type ModelAlias, type RouteDecision } from '@arianna/router';

import { runClaudeStep, type BriefFragment } from '../claude-step.ts';
import { runCodexStep } from '../codex-step.ts';
import { loadConversation, type Conversation, type Message } from '../conversations.ts';
import type { Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import type { RunUsage } from '../runs.ts';
import { applyDeclassifyIn, passGateway } from '../gateway.ts';
import { liveEditFailure, liveEditOf, postLiveEdit } from '../live-edit.ts';
import { ENTRY_TEXT, isEntryDelegation } from '../participants.ts';
import { isIncognitoConversation } from '../incognito.ts';
import { KnowledgeError, privateKnowledge } from '../project-knowledge.ts';
import { openReply, postActivity, type ActivityKind } from '../reply.ts';
import type { Task } from '../tasks.ts';
import { writeWorkDiary, type WorkOutcome } from '../work-diary.ts';
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
   * whether it is enabled is `availableCloud`, read from `settings` at each use.
   */
  claude?: ClaudeExecutor;
  /** The same for `codex exec` (D-140, D-111 tappa C): absent when its sandbox is refused on this machine. */
  codex?: CodexExecutor;
  /** What Claude reads first when it answers a system chat directly; DIRECT_PROMPT by default (tests pick a scenario). */
  directPrompt?: string;
  /** The local model, for the agents that only answer (D-119, tappa T3); absent, they take no delegated step. */
  model?: () => LocalModel;
  /**
   * The skills assigned to an agent (D-161), as one delimited block of
   * third-party data within `maxBytes`; undefined for none. Absent, no agent
   * reads skills.
   */
  skills?: (agent: string, maxBytes: number) => string | undefined;
}

/** The size of the skills block in a delivery to a cloud agent, and to an agent on the local model (D-161). */
export const SKILLS_BYTES = { cloud: 128 * 1024, local: 16 * 1024 } as const;

/** What the step with an open delegation will do. */
export type DelegationPlan =
  | { kind: 'cloud'; delegation: Delegation; decision: RouteDecision; executor: 'claude'; model: ClaudeModel; label: Label; declassify?: { approvalId: string; to: Label } }
  /** The same step on Codex (D-140): the router chose `codex`. */
  | { kind: 'cloud'; delegation: Delegation; decision: RouteDecision; executor: 'codex'; model: CodexModel; label: Label; declassify?: { approvalId: string; to: Label } }
  /** An agent that only answers, on the local model (D-119, tappa T3). */
  | { kind: 'local'; delegation: Delegation; decision: RouteDecision; model: string; label: Label; declassify?: { approvalId: string; to: Label } }
  | { kind: 'budget'; delegation: Delegation; decision: RouteDecision; executor: CloudExecutor; model: string }
  /** The project folder has uncommitted changes: the user approves first (D-056). */
  | { kind: 'workspace'; delegation: Delegation; repo: string; files: string[] }
  | { kind: 'retry'; delegation: Delegation; decision: RouteDecision; at: Date }
  /** Nothing runs: the delegation ends with this result and the local step goes on with it. */
  | { kind: 'closed'; delegation: Delegation; status: 'failed' | 'refused'; result: string; decision?: RouteDecision };

/** The executors that run a delegated step in the cloud, in a project folder. */
export const CLOUD_DELEGATES = ['claude', 'codex'] as const;
export type CloudExecutor = (typeof CLOUD_DELEGATES)[number];

/**
 * The cloud executors that can take a step now: enabled in `[cloud]
 * executors` (read at each use, D-071) and with an adapter that runs on this
 * machine (its sandbox not refused).
 */
export function availableCloud(env: Pick<DelegateEnv, 'claude' | 'codex' | 'settings'>): CloudExecutor[] {
  const enabled = env.settings().cloud.executors;
  return CLOUD_DELEGATES.filter((executor) => env[executor] !== undefined && enabled.includes(executor));
}

/** Whether one of the cloud executors of `card` can take a step now (D-140). */
export function cloudReady(env: Pick<DelegateEnv, 'claude' | 'codex' | 'settings'>, card: AgentCard): boolean {
  const available: readonly string[] = availableCloud(env);
  return card.executors.some((executor) => available.includes(executor));
}

/**
 * Where a delegated step of an agent runs (D-119, tappa T3): in a project
 * folder on a cloud executor, like the Coder, named by the first one on its
 * card (`claude` or `codex`, D-140: the router still chooses between the two
 * at every step, among the card's); or, for an agent without tools (the
 * template `answer`), in one call to the local model. Any other agent takes
 * no delegated step: the web tools of the template `web` do not exist yet.
 */
export type DelegationRoute = CloudExecutor | 'local';

export function delegationRoute(card: AgentCard): DelegationRoute | undefined {
  const cloud = card.executors.find((executor): executor is CloudExecutor => (CLOUD_DELEGATES as readonly string[]).includes(executor));
  if (cloud !== undefined) return cloud;
  if (card.executors.includes('local') && card.tools.length === 0) return 'local';
  return undefined;
}

/** A route in a project folder, on Claude Code or Codex. */
export function isCloudRoute(route: DelegationRoute | undefined): route is CloudExecutor {
  return route === 'claude' || route === 'codex';
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
    if (isCloudRoute(where) ? cloudReady(env, agent.card) : where === 'local' && env.model !== undefined) targets.push({ name, description: agent.card.description });
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

/**
 * What a Codex run may do in the project folder (D-140): write only with
 * `repo.write`. Codex has no list of tools to close: in `read` its commands
 * (tests among them, `repo.test`) run in a sandbox that writes nowhere.
 */
export function codexAccessOf(tools: readonly ToolId[]): CodexAccess {
  return tools.includes('repo.write') ? 'write' : 'read';
}

/**
 * The kind of step the router reads for a cloud agent (D-140): `review` for
 * one that may not write (the Reviewer: a model of another family first),
 * `coding` otherwise.
 */
export function cloudStepKind(card: AgentCard): 'coding' | 'review' {
  return card.tools.includes('repo.write') ? 'coding' : 'review';
}

/**
 * The built-in tools of `claude -p` that a card's repository tools stand for.
 * `Bash` only together with `repo.write` (D-140): the sandbox of `claude`
 * lets commands write the project folder, so a card that may not write (the
 * Reviewer) runs no command there; on Codex its tests run in a read-only
 * sandbox instead.
 */
export function claudeToolsOf(tools: readonly ToolId[]): ClaudeTool[] {
  const out: ClaudeTool[] = [];
  if (tools.includes('repo.read')) out.push('Read', 'Glob', 'Grep');
  if (tools.includes('repo.write')) out.push('Edit', 'Write');
  if (tools.includes('repo.test') && tools.includes('repo.write')) out.push('Bash');
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

/** How an earlier exchange starts in a brief of the direct chat: the cloud reads them as text, the local model as turns. */
export const EARLIER_MESSAGE = '[earlier message of the user]\n';
export const EARLIER_ANSWER = '[your earlier answer]\n';

/** At most this many earlier exchanges of the direct chat, and this many characters, in the fallback brief (D-111). */
export const DIRECT_HISTORY_EXCHANGES = 10;
export const DIRECT_HISTORY_CHARS = 12_000;

/**
 * The session of the direct chat to continue (D-111, tappa A2): the one of
 * the latest answer of the same agent in the same project, in this
 * conversation. Undefined at the first message, or when none was kept.
 */
export async function directChatSession(sql: Sql, conversationId: string, delegation: Delegation, executor: CloudExecutor = 'claude'): Promise<string | undefined> {
  // The latest answer only, and only when the same executor gave it (D-140): a session of Claude is not one of Codex.
  // After a change of model to the other executor, the fallback brief carries the conversation over.
  const [row] = await sql<{ sessionRef: string | null; executor: string | null }[]>`
    SELECT d.session_ref AS "sessionRef", d.executor FROM task_delegations d JOIN tasks t ON t.id = d.task_id
      WHERE t.conversation_id = ${conversationId} AND d.agent = ${delegation.agent} AND d.repo IS NOT DISTINCT FROM ${delegation.repo}
        AND d.status = 'ok' AND d.id <> ${delegation.id}
      ORDER BY d.created_at DESC, d.id DESC LIMIT 1`;
  return row?.executor === executor ? (row.sessionRef ?? undefined) : undefined;
}

/**
 * When the session cannot be resumed (D-111, tappa A2): the latest exchanges
 * of the direct chat, oldest first, as brief fragments with their labels.
 * Only exchanges that ended with an answer: a message whose brief the gateway
 * refused never reached the Coder and is not sent now either. Capped by
 * exchanges and characters, the newest kept.
 */
export async function directChatHistory(sql: Sql, conversationId: string, delegation: Delegation, options: { voice?: boolean } = {}): Promise<BriefFragment[]> {
  const rows = await sql<{ brief: string; label: Label; answer: string | null; answerLabel: Label | null; taskId: string; at: Date }[]>`
    SELECT d.brief, d.label, m.body AS answer, m.label AS "answerLabel", d.task_id::text AS "taskId", d.created_at AS at
      FROM task_delegations d JOIN tasks t ON t.id = d.task_id LEFT JOIN messages m ON m.id = d.message_id
      WHERE t.conversation_id = ${conversationId} AND d.agent = ${delegation.agent} AND d.repo IS NOT DISTINCT FROM ${delegation.repo}
        AND d.status = 'ok' AND d.id <> ${delegation.id}
      ORDER BY d.created_at DESC, d.id DESC LIMIT ${DIRECT_HISTORY_EXCHANGES}`;
  const units: { at: Date; exchange: BriefFragment[] }[] = rows.map((row) => {
    const exchange: BriefFragment[] = [{ text: `${EARLIER_MESSAGE}${row.brief}`, label: row.label, source: `task:${row.taskId}` }];
    if (row.answer !== null && row.answerLabel !== null) {
      exchange.push({ text: `${EARLIER_ANSWER}${row.answer}`, label: row.answerLabel, source: `task:${row.taskId}` });
    }
    return { at: row.at, exchange };
  });
  // D-158: what was said in a call with a local agent, before this message. Its words and the agent's spoken answers
  // have no delegation (a call answers on the spot); a cloud brief never reads them: the caller asks for them (`voice`).
  if (options.voice === true) {
    const said = await sql<{ id: string; role: 'user' | 'assistant'; body: string; label: Label; at: Date }[]>`
      SELECT m.id::text, m.role, m.body, m.label, m.ts AS at FROM messages m
        WHERE m.conversation_id = ${conversationId} AND m.channel = 'voice' AND m.task_id IS NULL AND m.role IN ('user', 'assistant')
          AND m.ts < (SELECT d.created_at FROM task_delegations d WHERE d.id = ${delegation.id})
        ORDER BY m.ts DESC, m.id DESC LIMIT ${DIRECT_HISTORY_EXCHANGES * 2}`;
    for (const message of said) {
      const opening = message.role === 'user' ? EARLIER_MESSAGE : EARLIER_ANSWER;
      units.push({ at: message.at, exchange: [{ text: `${opening}${message.body}`, label: message.label, source: `message:${message.id}` }] });
    }
    units.sort((a, b) => b.at.getTime() - a.at.getTime());
  }
  const kept: BriefFragment[][] = [];
  let chars = 0;
  for (const { exchange } of units.slice(0, options.voice === true ? DIRECT_HISTORY_EXCHANGES * 3 : DIRECT_HISTORY_EXCHANGES)) {
    const size = exchange.reduce((sum, fragment) => sum + fragment.text.length, 0);
    if (chars + size > DIRECT_HISTORY_CHARS) {
      // The latest exchange alone above the cap is cut, not left out: the start of the message, the end of the answer.
      if (kept.length === 0) kept.push(cutExchange(exchange, DIRECT_HISTORY_CHARS));
      break;
    }
    chars += size;
    kept.push(exchange);
  }
  return kept.reverse().flat();
}

const CUT = '[…]';

const addUsage = (a: RunUsage, b: RunUsage): RunUsage => {
  const sum = (x: number | undefined, y: number | undefined) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const tokensIn = sum(a.tokensIn, b.tokensIn);
  const tokensOut = sum(a.tokensOut, b.tokensOut);
  const cost = sum(a.cost, b.cost);
  return {
    steps: (a.steps ?? 1) + (b.steps ?? 1),
    ...(tokensIn === undefined ? {} : { tokensIn }),
    ...(tokensOut === undefined ? {} : { tokensOut }),
    ...(cost === undefined ? {} : { cost }),
  };
};

/** An exchange within `budget` characters: half to the start of the message, the rest to the end of the answer. */
function cutExchange(exchange: BriefFragment[], budget: number): BriefFragment[] {
  const [message, answer] = exchange;
  if (message === undefined) return [];
  const forMessage = answer === undefined ? budget : Math.min(message.text.length, Math.floor(budget / 2));
  const cutMessage = message.text.length <= forMessage ? message.text : `${message.text.slice(0, forMessage - CUT.length)}${CUT}`;
  if (answer === undefined) return [{ ...message, text: cutMessage }];
  const forAnswer = budget - cutMessage.length;
  // The end of the answer, its opening line kept: the local model reads it as its own turn.
  const opening = answer.text.startsWith(EARLIER_ANSWER) ? EARLIER_ANSWER : '';
  const cutAnswer =
    answer.text.length <= forAnswer ? answer.text : `${opening}${CUT}${answer.text.slice(answer.text.length - (forAnswer - CUT.length - opening.length))}`;
  return [{ ...message, text: cutMessage }, { ...answer, text: cutAnswer }];
}

/** What the Coder reads before the earlier exchanges, when its session could not be resumed: our fixed text, L0. */
export const DIRECT_HISTORY_TEXT =
  'Your earlier session of this chat could not be resumed: the latest exchanges follow, oldest first, then the new message of the user. Answer the new message.';

/** The same for an agent on the local model (D-111d): no project, nothing leaves the computer. */
export const DIRECT_LOCAL_TEXT = [
  'You are in a direct chat with the user inside Arianna, without Arianna in between: each message of the user reaches you as it is, and your answer is shown to the user as it is.',
  'Answer in the language of the user, as in a chat, briefly.',
  'Never ask the user for credentials.',
].join(' ');

/** What Arianna reads when no project is there for the Coder. */
export const NO_PROJECT = 'no project for the Coder: the user opens a work conversation with one of the approved projects (pnpm arianna:init --reconfigure adds one)';

/** Opens the project folder of a delegation, or says why the step cannot run there. */
async function folderOf(
  env: DelegateEnv,
  delegation: Delegation,
): Promise<{ opened: OpenedRepository; repo: string; label: Label; container: string; part: string | null } | { error: string }> {
  const repo = delegation.repo;
  if (repo === null) return { error: NO_PROJECT };
  const config = env.settings();
  // Read again at every attempt: a project taken off the list closes the delegation.
  // D-145: a part of a container (`<project>:<part>`), or the container that is itself the only part.
  const project = projectNamed(workParts(config.projects), repo);
  if (project === undefined) return { error: `the project ${repo} is no longer among the projects the user approved: tell the user` };
  const container = config.projects.find((item) => item.name === project.project);
  if (container === undefined) return { error: `the project ${repo} is no longer among the projects the user approved: tell the user` };
  if (project.part === null) {
    // The container is the Coder's folder: its management folders sit inside it. Until P3 denies them file by
    // file, a note or a file above L1 there keeps the Coder out (D-145).
    let held: string[];
    try {
      held = privateKnowledge(container);
    } catch {
      return { error: `the management folders of ${repo} cannot be checked for private knowledge: the Coder does not open it; tell the user` };
    }
    if (held.length > 0) {
      return { error: `the folder of ${repo} holds private knowledge of the project (${String(held.length)} file(s) above Interno in its management folders): the Coder does not open it; tell the user` };
    }
  }
  let opened: OpenedRepository;
  try {
    opened = await openRepository({ home: config.home, project: container, ...(project.part === null ? {} : { part: project.part }) });
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return { error: `the folder of ${repo} cannot be opened: ${error.message}` };
  }
  if (opened.path === undefined) {
    const kinds = opened.decision.decision === 'block' ? [...new Set(opened.decision.findings.map((finding) => finding.kind))].join(', ') : '';
    return { error: `the repository ${repo} cannot go to the cloud (${opened.decision.reason}${kinds === '' ? '' : `: ${kinds}`})` };
  }
  return { opened, repo, label: project.label, container: container.name, part: project.part };
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
    const decision = await routeLocalAgent(env, agent.card, task.clearance, label, delegation.brief);
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
      return closed('refused', `the user did not want ${delegation.agent} to work over uncommitted changes: tell the user, or wait for them to commit`);
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
    { kind: cloudStepKind(agent.card), agent: agent.card, text: delegation.brief, budgetApproved: budget?.state === 'approved', ...preferredModel },
    createContext(task.clearance, label),
    await budgetOf(env.sql),
    routerConfigOf(env.settings(), adaptersOf(env)),
  );
  if (decision.decision === 'wait') {
    if (decision.next === 'retry-later' && decision.retryAt !== undefined) return { kind: 'retry', delegation, decision, at: new Date(decision.retryAt) };
    return closed('failed', `no executor can take this step now (${decision.reason})`, decision);
  }
  const rest = { delegation, decision, label, ...(declassify === undefined ? {} : { declassify }) };
  if (decision.executor === 'claude' && env.claude !== undefined) {
    const model = (CLAUDE_MODELS as readonly string[]).includes(decision.model) ? (decision.model as ClaudeModel) : undefined;
    if (model === undefined) return closed('failed', `claude has no model ${decision.model}`, decision);
    if (decision.approval === 'budget') return { kind: 'budget', delegation, decision, executor: 'claude', model };
    return { kind: 'cloud', ...rest, executor: 'claude', model };
  }
  if (decision.executor === 'codex' && env.codex !== undefined) {
    const model = (CODEX_MODELS as readonly string[]).includes(decision.model) ? (decision.model as CodexModel) : undefined;
    if (model === undefined) return closed('failed', `codex has no model ${decision.model}`, decision);
    if (decision.approval === 'budget') return { kind: 'budget', delegation, decision, executor: 'codex', model };
    return { kind: 'cloud', ...rest, executor: 'codex', model };
  }
  return closed('failed', `${delegation.agent} runs delegated steps on Claude Code or Codex only, and neither is available for this step`, decision);
}

/**
 * The router's choice for one answer of an agent on the local model: the
 * step of a delegation (D-119), or a turn of a call in its direct chat (D-158).
 */
export async function routeLocalAgent(
  env: Pick<DelegateEnv, 'sql' | 'settings' | 'claude' | 'codex'>,
  card: AgentCard,
  clearance: Label,
  label: Label,
  text?: string,
): Promise<RouteDecision> {
  return route({ kind: 'judge', agent: card, ...(text === undefined ? {} : { text }) }, createContext(clearance, label), await budgetOf(env.sql), routerConfigOf(env.settings(), adaptersOf(env)));
}

/** The local model an agent answers on now, or undefined when none can (D-158: the calls of its direct chat). */
export async function localAgentModel(env: Pick<DelegateEnv, 'sql' | 'settings' | 'claude' | 'codex' | 'model'>, card: AgentCard, clearance: Label, label: Label): Promise<string | undefined> {
  if (env.model === undefined || delegationRoute(card) !== 'local') return undefined;
  const decision = await routeLocalAgent(env, card, clearance, label);
  return decision.decision !== 'wait' && decision.locality === 'local' ? decision.model : undefined;
}

/** Which cloud adapters run on this machine, for the router's candidates. */
export function adaptersOf(env: Pick<DelegateEnv, 'claude' | 'codex'>): { claude: boolean; codex: boolean } {
  return { claude: env.claude !== undefined, codex: env.codex !== undefined };
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

/** What the diary of a work reads besides the delegation (I-15, D-147). */
interface WorkRecord {
  task: Task;
  runId: string;
  delegation: Delegation;
  executor: CloudExecutor;
  alias: string;
  container: string;
  part: string | null;
  /** The project's label, or the brief's when higher: what the paths and the brief carry. */
  label: Label;
  outcome: WorkOutcome;
  reason?: string;
  files?: readonly FileChange[];
  commit?: string;
  /** The report as the chat stored it, with its label. */
  report?: { text: string; label: Label };
}

/** The address of a conversation in the chat that the core serves. */
export function conversationUrl(server: { host: string; port: number }, conversationId: string): string {
  const host = server.host.includes(':') ? `[${server.host}]` : server.host;
  return `http://${host}:${String(server.port)}/c/${conversationId}`;
}

/**
 * The entry of the diary of a work on a project (I-15, D-147), written by the
 * code: the brief only when the gateway let it out towards the cloud in this
 * run (a row in gateway_log), the report only as the chat stored it. Never in
 * an incognito conversation (D-136: nothing outlives it). Never fails the
 * work: an error is logged with its kind only.
 */
async function recordWork(env: DelegateEnv, work: WorkRecord): Promise<void> {
  try {
    const { sql } = env;
    if (work.task.conversationId !== null && (await isIncognitoConversation(sql, work.task.conversationId))) return;
    const [left] = await sql<{ left: boolean }[]>`
      SELECT EXISTS (SELECT FROM gateway_log WHERE run_id = ${work.runId} AND target_kind = 'executor' AND locality = 'cloud' AND decision = 'allow') AS left`;
    const [reported] = await sql<{ model: string | null }[]>`
      SELECT payload ->> 'model' AS model FROM events WHERE run_id = ${work.runId} AND kind = 'executor.model' ORDER BY id DESC LIMIT 1`;
    const config = env.settings();
    const label = work.report === undefined ? work.label : maxLabel(work.label, work.report.label);
    writeWorkDiary(
      config.projects,
      work.container,
      { home: config.home, rules: env.rules },
      {
        at: new Date(),
        agent: work.delegation.agent,
        executor: work.executor,
        alias: work.alias,
        ...(typeof reported?.model === 'string' ? { model: reported.model } : {}),
        project: work.container,
        part: work.part,
        outcome: work.outcome,
        ...(work.reason === undefined ? {} : { reason: work.reason }),
        ...(left?.left === true ? { request: work.delegation.brief } : {}),
        ...(work.files === undefined ? {} : { files: work.files }),
        ...(work.commit === undefined ? {} : { commit: work.commit }),
        ...(work.report === undefined ? {} : { report: work.report.text }),
        ...(work.task.conversationId === null ? {} : { conversationUrl: conversationUrl(config.server, work.task.conversationId) }),
        label,
      },
    );
  } catch (error) {
    // The work stays as it ended; the log says only the kind of error, never a text of the work.
    console.error(`work diary not written: ${error instanceof KnowledgeError ? error.code : error instanceof Error ? error.name : 'error'}`);
  }
}

/** Why a work stopped at the time cap says so in the diary. */
const TIME_CAP = 'limite di tempo del compito';

/** A stop at the task's time cap (AbortSignal.timeout), not a shutdown or a lost lock: the step does not come back. */
function stoppedAtTimeCap(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return signal.aborted && reason instanceof Error && reason.name === 'TimeoutError';
}

/** What a cloud step gave, on either executor: the fields the delegation reads are the same (D-140). */
type CloudStepResult =
  | { kind: 'answer'; result: { text: string; label: Label; sessionRef: string; usage: { context?: number } }; usage: RunUsage }
  | { kind: 'blocked'; decision: { reason: string } }
  | { kind: 'quota'; overage: boolean; resetsAt?: Date; usage: RunUsage }
  | { kind: 'failed'; reason: string; usage: RunUsage; error: ClaudeError | CodexError };

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
 * The skills of the agent (D-161) after its prompt: public text (L0) that is
 * not trusted, a block of data delimited, never an instruction to Arianna.
 * None for a card that closes untrusted_content, whatever the settings say.
 */
export function skillsPart(env: Pick<DelegateEnv, 'skills'>, agent: LoadedAgent, name: string, maxBytes: number): BriefFragment | undefined {
  if (env.skills === undefined || !agent.card.trifecta.untrusted_content) return undefined;
  const block = env.skills(name, maxBytes);
  return block === undefined || block === '' ? undefined : { text: block, label: 'L0', source: `skills:${name}` };
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

/**
 * The step as `executor` runs it (D-140): an interrupted run of the other
 * cloud executor is not resumed, its session is not one of this binary.
 */
export function stepFor(ctx: StepContext, executor: CloudExecutor): StepContext {
  if (ctx.resume?.executor === undefined || ctx.resume.executor === executor) return ctx;
  const copy = { ...ctx };
  delete copy.resume;
  return copy;
}

/**
 * The cloud step: the plan is `cloud`. Every run of a task of an incognito
 * conversation, resumed ones included, runs `claude` with
 * `--no-session-persistence` (D-136): its session is not saved, so it is
 * never resumed. An incognito conversation has no direct chat (migration
 * 0031), so the direct chat always continues its saved session.
 */
export async function runDelegation(env: DelegateEnv, ctx: StepContext, plan: Extract<DelegationPlan, { kind: 'cloud' }>): Promise<StepOutcome> {
  const { task, step, runId } = ctx;
  const { delegation } = plan;
  const { sql } = env;
  const persistSession = !(task.conversationId !== null && (await isIncognitoConversation(sql, task.conversationId)));
  const executor = plan.executor;
  if (env[executor] === undefined) throw new Error(`${executor} is not available`);
  const runCtx = stepFor(ctx, executor);
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
  const { repo, container, part } = folder;
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
  // The commit the folder starts from: a run that commits moves it (the diary names the new one, I-15).
  const headBefore = await repositoryHead(path).catch(() => undefined);
  await updateDelegation(sql, delegation.id, { status: 'running', executor, model: plan.model, runId });
  await show(sql, task, step, 'delegate', `${delegation.agent} · ${executor}/${plan.model}`);
  // From here on the work is the agent's: however it ends, it goes in the diary of the project (I-15, D-147).
  const diary = (outcome: WorkOutcome, details: Pick<WorkRecord, 'reason' | 'files' | 'commit' | 'report'> = {}): Promise<void> =>
    recordWork(env, { task, runId, delegation, executor, alias: plan.model, container, part, label: editLabel, outcome, ...details });
  // What the run left changed: the user's own changes from before, unless the run changed them again, are not counted.
  const changesOf = async (): Promise<FileChange[] | undefined> => {
    const after = await repositoryChanges(path).catch(() => undefined);
    if (after === undefined) return undefined;
    const again = await fileFingerprints(path, [...before]).catch(() => new Map<string, string>());
    return after.filter((item) => !before.has(item.path) || dirtyPrints.get(item.path) !== again.get(item.path));
  };
  // What a run that did not end well left in the folder, read only while its git configuration is the one from before.
  const leftBehind = async (): Promise<Pick<WorkRecord, 'files' | 'commit'>> => {
    if ((await gitConfigFingerprint(path).catch(() => undefined)) !== fingerprint) return {};
    const listed = await changesOf();
    const head = await repositoryHead(path).catch(() => undefined);
    return { ...(listed === undefined ? {} : { files: storableFiles(listed) }), ...(typeof head === 'string' && head !== headBefore ? { commit: head } : {}) };
  };

  // The Coder's own prompt, then the brief: both leave through the gateway.
  // At its first delegation in this conversation the agent also reads how to enter it (D-125): our fixed text, L0.
  const entry = await isEntryDelegation(sql, delegation.id);
  // In the direct chat it reads how to talk with the user without Arianna (D-111): our fixed text, L0.
  const direct = (await directChatOf(sql, task, delegation.agent)) !== undefined;
  const message: BriefFragment = { text: delegation.brief, label, source: `task:${task.id}` };
  const skills = skillsPart(env, agent, delegation.agent, SKILLS_BYTES.cloud);
  const opening: BriefFragment[] = [
    promptPart(agent, delegation.agent),
    ...(skills === undefined ? [] : [skills]),
    ...(entry ? [{ text: ENTRY_TEXT, label: 'L0' as const, source: 'arianna:entry' }] : []),
    ...(direct ? [{ text: DIRECT_CHAT_TEXT, label: 'L0' as const, source: 'arianna:direct' }] : []),
  ];
  // The direct chat continues the session of its latest answer (D-111, tappa A2): only the new message leaves.
  const session = direct && task.conversationId !== null ? await directChatSession(sql, task.conversationId, delegation, executor) : undefined;
  const reply = task.conversationId === null ? undefined : await openReply(sql, task.id, { runId, agent: delegation.agent });
  let streamed = 0;
  const onText = async (text: string): Promise<void> => {
    // One block per model message: separated, so that the chat reads them as paragraphs.
    await reply?.delta(`${streamed === 0 ? '' : '\n\n'}${text}`);
    streamed += 1;
  };
  const attempt = (brief: readonly BriefFragment[], sessionRef: string | null | undefined): Promise<CloudStepResult> => {
    const common = {
      // The run has read only the brief and the agent's prompt (docs/PRIVACY-POLICY-SPEC.md): a context of its own,
      // at the highest label of what it reads, as the local run (a prompt of the user is L1, tappa T3b).
      context: createContext(task.clearance, brief.reduce<Label>((top, fragment) => maxLabel(top, fragment.label), promptLabelOf(agent))),
      brief,
      ...(sessionRef === undefined ? {} : { sessionRef }),
      ...(persistSession ? {} : { persistSession: false }),
      workspace,
      ...runLimitsOf(agent),
      summary: `delegated step for ${delegation.agent}`,
    };
    if (plan.executor === 'codex') {
      const codex = env.codex;
      if (codex === undefined) throw new Error('codex is not available');
      // Codex gives no diff of a change (D-140): the files changed are read from git after the run, as for Claude.
      return runCodexStep(sql, codex, runCtx, {
        ...common,
        model: plan.model,
        access: codexAccessOf(agent.card.tools),
        onEvent: async (event) => {
          if (event.type === 'text') await onText(event.text);
          else await show(sql, task, step, 'tool', event.name);
        },
      });
    }
    const claude = env.claude;
    if (claude === undefined) throw new Error('claude is not available');
    return runClaudeStep(sql, claude, runCtx, {
      ...common,
      model: plan.model,
      tools: claudeToolsOf(agent.card.tools),
      onEvent: async (event) => {
        if (event.type === 'text') {
          await onText(event.text);
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
  };
  // No session of this executor to continue, after earlier answers (the model moved from Claude to Codex or back, D-140):
  // the new start carries the latest exchanges, as when a session is lost.
  const earlier = direct && session === undefined && task.conversationId !== null ? await directChatHistory(sql, task.conversationId, delegation) : [];
  const carried = earlier.length === 0 ? [] : [{ text: DIRECT_HISTORY_TEXT, label: 'L0' as const, source: 'arianna:direct-history' }, ...earlier];
  let result: CloudStepResult;
  try {
    result = await attempt(session === undefined ? [...opening, ...carried, message] : [message], session);
    // The session is gone (refused before it started, or another one began): one new start with the latest exchanges.
    if (session !== undefined && task.conversationId !== null && result.kind === 'failed' && sessionLost(result.error)) {
      const history = await directChatHistory(sql, task.conversationId, delegation);
      const fallback = history.length === 0 ? [] : [{ text: DIRECT_HISTORY_TEXT, label: 'L0' as const, source: 'arianna:direct-history' }, ...history];
      const lost = result.usage;
      result = await attempt([...opening, ...fallback, message], null);
      // The failed resume counts too.
      if (result.kind !== 'blocked') result = { ...result, usage: addUsage(lost, result.usage) };
    }
  } catch (error) {
    // Stopped at the time cap of the task: the work ends here (a shutdown or a lost lock runs it again, and writes then).
    if (stoppedAtTimeCap(ctx.signal)) await diary('stopped', { reason: TIME_CAP, ...(await leftBehind()) });
    throw error;
  }

  switch (result.kind) {
    case 'answer': {
      // No git command of Arianna's runs in a folder whose git configuration the run changed: the user looks first.
      if ((await gitConfigFingerprint(path)) !== fingerprint) {
        await close(env, task, step, delegation, 'failed', `error: ${TOOL}: the run changed the git configuration of the project ${repo} (.git/config, hooks or .gitattributes): the user must check that folder before using git there`);
        await diary('failed', { reason: 'il lavoro ha cambiato la configurazione git del progetto: va controllata prima di usare git lì' });
        return { kind: 'continue', usage: result.usage };
      }
      // What the Coder left changed in the folder, for Arianna to tell the user; its own report is stored as it is.
      // The commit the changes are against (D-117): the chat diffs each file from it later.
      const head = await repositoryHead(path).catch(() => undefined);
      const listed = await changesOf();
      const changed = listed ?? [];
      // Saved before the report (D-082): the chat lists them under it as soon as it appears.
      if (listed !== undefined) await updateDelegation(sql, delegation.id, { files: storableFiles(changed), ...(typeof head === 'string' ? { baseCommit: head } : {}) });
      const commit = typeof head === 'string' && head !== headBefore ? { commit: head } : {};
      const files = listed === undefined ? {} : { files: storableFiles(changed) };
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
          await diary('failed', { reason: 'il rapporto non si poteva mostrare nella conversazione', ...files, ...commit });
          return { kind: 'continue', usage: result.usage };
        }
        messageId = saved.message.id;
      }
      await updateDelegation(sql, delegation.id, {
        status: 'ok',
        result: text,
        resultLabel: result.result.label,
        // A session that was not saved is never offered for resume, nor kept as a trace (D-136).
        ...(persistSession ? { sessionRef: result.result.sessionRef } : {}),
        ...(result.result.usage.context === undefined ? {} : { contextTokens: result.result.usage.context }),
        ...(messageId === undefined ? {} : { messageId }),
      });
      // The report only as the chat stored it: without a conversation it passed no gateway towards the user.
      const stored = messageId !== undefined && result.result.text.trim() !== '';
      await diary('ok', { ...files, ...commit, ...(stored ? { report: { text: report, label: result.result.label } } : {}) });
      return { kind: 'continue', usage: result.usage };
    }
    case 'blocked':
      await close(env, task, step, delegation, 'failed', `error: ${TOOL}: the gateway refused the brief (${result.decision.reason})`);
      await diary('failed', { reason: 'il gateway ha fermato la richiesta' });
      return { kind: 'continue', usage: { steps: 1 } };
    case 'quota': {
      // Back to pending: the same step runs again when the subscription takes requests.
      await updateDelegation(sql, delegation.id, { status: 'pending' });
      // A reset time already past (or none): an hour, so that a stale clock does not loop.
      const at = result.resetsAt !== undefined && result.resetsAt.getTime() > Date.now() ? result.resetsAt : new Date(Date.now() + 60 * 60_000);
      await show(sql, task, step, 'wait', `${executor} · ${at.toISOString()}`);
      return { kind: 'retry', at, reason: result.overage ? `${executor} is on paid extra usage` : `${executor} is out of quota`, usage: result.usage };
    }
    case 'failed': {
      await close(env, task, step, delegation, 'failed', `error: ${TOOL}: ${result.reason}`);
      // A run stopped by a shutdown or a lost lock comes back and writes then; at the time cap it ends here.
      if (stoppedAtTimeCap(ctx.signal)) await diary('stopped', { reason: TIME_CAP, ...(await leftBehind()) });
      else if (!ctx.signal.aborted) await diary('failed', { reason: result.reason, ...(await leftBehind()) });
      return { kind: 'continue', usage: result.usage };
    }
  }
}

/**
 * A resume that found no session to continue (D-111, tappa A2): the binary
 * ended before its first message, or reported another session.
 */
export function sessionLost(error: ClaudeError | CodexError): boolean {
  // Another session and nothing else: a binary that broke the profile in any other way is not started again.
  if (error.kind === 'profile') return error.violations.length === 1 && error.violations[0] === 'session';
  // A result before the init is refused as bad-output by the stream.
  return error.sessionRef === undefined && (error.kind === 'exit' || error.kind === 'bad-output');
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
  // In the direct chat (D-111d) the local model keeps no session: it reads how to talk with the user and the latest exchanges.
  const direct = task.conversationId !== null && (await directChatOf(sql, task, delegation.agent)) !== undefined;
  // Never an earlier exchange above what the card may read now: a card lowered after the conversation began reads less.
  const ceiling = briefCeiling(agent.card);
  const history = direct && task.conversationId !== null ? (await directChatHistory(sql, task.conversationId, delegation, { voice: true })).filter((part) => isAtMost(part.label, ceiling)) : [];
  // Each earlier exchange is a turn: the role comes from the fragment, before the gateway, never from the text it lets out.
  const roles = history.map((part) => (part.text.startsWith(EARLIER_ANSWER) ? ('assistant' as const) : ('user' as const)));
  // The skills of the agent join its instructions (D-161), as data within a smaller limit.
  const skills = skillsPart(env, agent, delegation.agent, SKILLS_BYTES.local);
  const parts = [
    prompt,
    ...(skills === undefined ? [] : [skills]),
    ...(direct ? [{ text: DIRECT_LOCAL_TEXT, label: 'L0' as const, source: 'arianna:direct' }] : []),
    ...history,
    { text: delegation.brief, label, source: `task:${task.id}` },
  ];
  const read = parts.reduce<Label>((top, part) => maxLabel(top, part.label), prompt.label);
  const decision = await passGateway(
    sql,
    parts.map((part) => ({ value: part.text, label: part.label, source: part.source })),
    createContext(task.clearance, read),
    { kind: 'executor', id: 'local', locality: 'local' },
    { taskId: task.id, runId },
  );
  if (decision.decision === 'block') return failed(`the gateway refused the brief (${decision.reason})`);
  if (decision.texts.length !== parts.length) throw new Error('the gateway allowed a different number of texts');
  const brief = decision.texts.at(-1) ?? '';
  const between = decision.texts.slice(1, -1);
  const allowedSkills = skills === undefined ? undefined : between.shift();
  const instructions = `${decision.texts[0] ?? ''}${allowedSkills === undefined ? '' : `\n\n${allowedSkills}`}`;
  const middle = between;
  // The fixed text of the direct chat joins the instructions; each earlier exchange is a turn of the chat.
  const system = direct ? `${instructions}\n\n${middle[0] ?? ''}` : instructions;
  const turns = (direct ? middle.slice(1) : middle).map((text, index) => {
    const role = roles[index] ?? 'user';
    const opening = role === 'assistant' ? EARLIER_ANSWER : EARLIER_MESSAGE;
    return { role, content: text.startsWith(opening) ? text.slice(opening.length) : text };
  });

  const entry = await isEntryDelegation(sql, delegation.id);
  let report: string;
  const usage = { steps: 1, tokensIn: 0, tokensOut: 0 };
  try {
    const result = await model().chat({
      model: plan.model,
      messages: [
        { role: 'system', content: localSystem(system, entry) },
        ...turns,
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
