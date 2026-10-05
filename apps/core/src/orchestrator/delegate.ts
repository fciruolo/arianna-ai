import type { LoadedAgent, ToolId } from '@arianna/agents';
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
  type OpenedRepository,
} from '@arianna/executors';
import { createContext, isAtMost, maxLabel, sha256Hex, type Label, type LabelRules } from '@arianna/policy';
import { MODEL_ALIASES, route, type ModelAlias, type RouteDecision } from '@arianna/router';

import { runClaudeStep } from '../claude-step.ts';
import { loadConversation, type Message } from '../conversations.ts';
import type { Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { applyDeclassifyIn } from '../gateway.ts';
import { liveEditFailure, liveEditOf, postLiveEdit } from '../live-edit.ts';
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
}

/** What the step with an open delegation will do. */
export type DelegationPlan =
  | { kind: 'cloud'; delegation: Delegation; decision: RouteDecision; model: ClaudeModel; label: Label; declassify?: { approvalId: string; to: Label } }
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

  // A brief written after reading L2 leaves only as the exact text the user approved.
  let label = delegation.label;
  let declassify: { approvalId: string; to: Label } | undefined;
  if (!isAtMost(label, 'L1')) {
    const approval = await declassificationOf(env.sql, delegation);
    if (approval?.state !== 'approved') {
      return closed('refused', 'the user did not approve sending the brief to the cloud: do what you can here, or tell the user');
    }
    const to = approval.detail.to;
    if (to !== 'L0' && to !== 'L1') return closed('failed', 'the declassification does not say a cloud label');
    declassify = { approvalId: approval.id, to };
    label = to;
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
    if (dirty.some((path) => !covered.has(path))) return { kind: 'workspace', delegation, repo: folder.repo, files: dirty };
  }

  // Every attempt is a cloud run of the task after the delegating step; the quota ones failed.
  const [refusals] = await env.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM runs
    WHERE task_id = ${delegation.taskId} AND step > ${delegation.step} AND locality = 'cloud' AND status = 'failed'`;
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

/** The cloud step: the plan is `cloud`. */
export async function runDelegation(env: DelegateEnv, ctx: StepContext, plan: Extract<DelegationPlan, { kind: 'cloud' }>): Promise<StepOutcome> {
  const { task, step, runId } = ctx;
  const { delegation } = plan;
  const { sql } = env;
  const claude = env.claude;
  if (claude === undefined) throw new Error('claude is not available');
  const agent = env.agents.get(delegation.agent);
  if (agent === undefined) throw new Error(`no agent card for ${delegation.agent}`);
  const failed = async (result: string): Promise<StepOutcome> => {
    await close(env, task, step, delegation, 'failed', `error: ${TOOL}: ${result}`);
    return { kind: 'continue', usage: { steps: 1 } };
  };

  // The declassification, once: the lowered label is written with its label_changes row.
  let label = delegation.label;
  if (plan.declassify !== undefined && !isAtMost(label, plan.declassify.to)) {
    const { approvalId, to } = plan.declassify;
    await sql.begin(async (tx) => {
      await applyDeclassifyIn(tx, { value: delegation.brief, label, source: `task:${task.id}` }, to, approvalId);
      await updateDelegation(tx, delegation.id, { label: to });
    });
    label = to;
  }

  // A crash after the report was stored, before the delegation was closed: the
  // run is not launched again, the stored report is the result.
  const [stored] = await sql<Pick<Message, 'id' | 'body' | 'label'>[]>`
    SELECT id::text, body, label FROM messages WHERE task_id = ${task.id} AND agent = ${delegation.agent} ORDER BY id DESC LIMIT 1`;
  if (stored !== undefined) {
    await updateDelegation(sql, delegation.id, { status: 'ok', result: stored.body, resultLabel: stored.label, messageId: stored.id });
    return { kind: 'continue', usage: { steps: 1 } };
  }

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
  const brief = [
    { text: agent.prompt, label: 'L0' as const, source: `agent:${delegation.agent}` },
    { text: delegation.brief, label, source: `task:${task.id}` },
  ];
  const reply = task.conversationId === null ? undefined : await openReply(sql, task.id, { runId, agent: delegation.agent });
  let streamed = 0;
  const result = await runClaudeStep(sql, claude, ctx, {
    // The run has read only the brief (docs/PRIVACY-POLICY-SPEC.md): a context of its own.
    context: createContext(task.clearance, label),
    brief,
    workspace,
    model: plan.model,
    tools: claudeToolsOf(agent.card.tools),
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
