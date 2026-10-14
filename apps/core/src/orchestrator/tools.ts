import type { Autonomy, ToolId } from '@arianna/agents';
import { isAtMost, maxLabel, profileRead, type Context, type Label } from '@arianna/policy';

import { PROJECT_NAME } from '../cardwall.ts';
import { clientsForIm } from '../clients.ts';
import type { Queryable } from '../db/client.ts';
import { runFinanceTool } from '../finance-tools.ts';
import { createTask, type Task } from '../tasks.ts';
import { listUserFacts } from '../user-facts.ts';
import { updateCard } from './cards.ts';
import { addImTool, clientProject, namesInText, type ImProposal, type ImToolEnv } from './im-tool.ts';
import { KbError, type Kb } from './kb.ts';

/**
 * The tools the orchestrator runs itself, on this machine (task 1.10, D-053).
 * A result is data for the model: it reaches it fenced in <tool_result>, with
 * the label of what the tool read. Errors are results too ("error: ..."), so
 * that the model can recover (docs/EVALS.md, recovery).
 *
 * `user.ask` is not here: like a reply, it ends the step with a message in
 * the chat. Neither is `task.delegate`, whose next step runs elsewhere
 * (delegate.ts). `task.update` moves a card of the conversation (cards.ts).
 * `im.add` writes an item in an IM file of a project (im-tool.ts, D-167).
 * `finance.*` read the expense tracker and mark the task (finance-tools.ts, D-183).
 * `profile.read` reads one fact of «Su di te» within the step's clearance (D-114, tappa B).
 */
export const LOCAL_TOOLS = [
  'kb.search',
  'kb.read',
  'kb.write',
  'task.create',
  'task.update',
  'im.add',
  'finance.summary',
  'finance.search',
  'finance.alerts',
  'profile.read',
] as const satisfies readonly ToolId[];
export type LocalTool = (typeof LOCAL_TOOLS)[number];

export function isLocalTool(tool: ToolId): tool is LocalTool {
  return (LOCAL_TOOLS as readonly string[]).includes(tool);
}

export interface ToolEnv {
  /** The transaction that also records the step's turn. */
  sql: Queryable;
  kb: Kb;
  task: Task;
  /** The step's context: clearance of the task, effective label of everything read so far. */
  context: Context;
  /** Autonomy of the agent's card: with A0 and A1 a card leaves the inbox only through the user. */
  autonomy: Autonomy;
  /** The IM of the projects (D-167); without it `im.add` answers with an error. */
  ims?: ImToolEnv;
  /**
   * What of the profile the step may read (D-114, tappa B): the lower of the
   * task's clearance and the card's `max_label`, as the tail of its prompt.
   * Without it `profile.read` reads nothing (default-deny).
   */
  profileClearance?: Label;
}

export interface ToolResult {
  text: string;
  /** Highest label of the data the tool returned; L0 when it returned none. */
  label: Label;
  /** `im.add` above the label of the IM (D-167): nothing written, the user confirms this first. */
  confirm?: ImProposal;
  /** The step's context after the tool, when the tool changed it (a finance read marks it, D-183). */
  context?: Context;
}

/** Longest page text shown to the model in one result. */
export const MAX_READ = 6_000;

// Fixed text: whether pages above the clearance matched is never said.
const SKIPPED_NOTE = 'Private pages were not searched: this conversation may not read them. For private documents, the user can open a private conversation.';

export async function runTool(tool: LocalTool, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  try {
    switch (tool) {
      case 'kb.search':
        return search(args, env);
      case 'kb.read':
        return read(args, env);
      case 'kb.write':
        return write(args, env);
      case 'task.create':
        return await card(args, env);
      case 'task.update':
        return await updateCard(args, env);
      case 'im.add':
        return await imItem(args, env);
      case 'finance.summary':
      case 'finance.search':
      case 'finance.alerts':
        return await runFinanceTool(tool, args, { sql: env.sql, taskId: env.task.id, context: env.context });
      case 'profile.read':
        return await readFact(args, env);
    }
  } catch (error) {
    if (error instanceof KbError) return { text: `error: ${tool}: ${error.message}`, label: 'L0' };
    throw error;
  }
}

function search(args: Record<string, unknown>, env: ToolEnv): ToolResult {
  const query = String(args.query);
  const limit = typeof args.limit === 'number' ? args.limit : 5;
  const { hits, skippedAbove } = env.kb.search(query, env.context, limit);
  const note = skippedAbove ? `\n${SKIPPED_NOTE}` : '';
  if (hits.length === 0) return { text: `no pages match '${query}'${note}`, label: 'L0' };
  const lines = hits.map((hit, index) => `${String(index + 1)}. ${hit.path} (${hit.title})\n   ${hit.snippet}`);
  return { text: `${lines.join('\n')}${note}`, label: maxLabel(...hits.map((hit) => hit.label)) };
}

function read(args: Record<string, unknown>, env: ToolEnv): ToolResult {
  const page = env.kb.read(String(args.path), env.context);
  const body = page.body.length > MAX_READ ? `${page.body.slice(0, MAX_READ)}\n[page cut at ${String(MAX_READ)} characters]` : page.body;
  return { text: `${page.path} (${page.title})\n\n${body}`, label: page.label };
}

function write(args: Record<string, unknown>, env: ToolEnv): ToolResult {
  // The content was written from the task's context: it carries its label.
  const written = env.kb.write(String(args.path), String(args.content), env.context.effective, `task:${env.task.id}`);
  return { text: `written ${written.path}`, label: 'L0' };
}

/**
 * One fact of the profile by its topic (D-114, tappa B), within the step's
 * clearance (`profileRead`): the text with the fact's label; for an L2 fact
 * in a work step only that it is private (the topic is L1); for an unknown
 * topic the topics the step may know (L1), or nothing in an L0 step.
 */
async function readFact(args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const topic = String(args.topic);
  const read = profileRead(env.profileClearance ?? 'L0', await listUserFacts(env.sql), topic);
  switch (read.kind) {
    case 'text':
      return { text: `${read.topic}: ${read.text}`, label: read.label };
    case 'private':
      return { text: `error: profile.read: the text of '${read.topic}' is private and not available in this conversation; ask the user if you need it`, label: 'L1' };
    case 'missing':
      return read.topics.length === 0
        ? { text: 'error: profile.read: the profile has no fact this conversation may read', label: 'L0' }
        : { text: `error: profile.read: no fact '${topic}'; the topics are: ${read.topics.join(', ')}`, label: 'L1' };
  }
}

/** The project of the conversation's workspace (a container, or `container:part`, D-145), when it has one. */
async function workspaceProject(env: ToolEnv): Promise<string | undefined> {
  if (env.task.conversationId === null) return undefined;
  const [conversation] = await env.sql<{ workspace: string | null }[]>`SELECT workspace FROM conversations WHERE id = ${env.task.conversationId}`;
  const project = conversation?.workspace?.split(':')[0];
  return project !== undefined && PROJECT_NAME.test(project) ? project : undefined;
}

/** An item in the current or next IM of a project (D-167, P4b): the file is written by code, the model reads one line. */
async function imItem(args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  // "del cliente Rossi" (I-17 S3, D-173): the client's project, read at the client's label.
  let read: Label = 'L0';
  let named = '';
  let call = args;
  const said = typeof args.project === 'string' && args.project.trim() !== '' ? args.project.trim() : undefined;
  const known = env.ims?.projects().some((project) => project.name.toLowerCase() === said?.toLowerCase()) === true;
  // A "project" that is no project may be the client the user named ("Rossi"): tried as one, when no client is given.
  const typed = typeof args.client === 'string' && args.client.trim() !== '' ? args.client.trim() : undefined;
  const readable = env.ims !== undefined && isAtMost('L2', env.task.clearance);
  const guess = typed === undefined && said !== undefined && !known && readable;
  const workspace = await workspaceProject(env);
  // Nothing said at all, outside a project: the user's own last messages, when the model left the names out
  // ("del cliente Rossi", then "progetto-test" to the question which).
  const texts = typed === undefined && said === undefined && workspace === undefined && env.ims !== undefined ? await userTexts(env) : undefined;
  const heard = texts === undefined || env.ims === undefined ? undefined : namesInText(texts.bodies, env.ims.projects().map((project) => project.name));
  // The user's words were read: what they carry is read too.
  if (texts !== undefined && (heard?.project !== undefined || heard?.client !== undefined)) read = maxLabel(read, texts.label);
  const spoken = readable ? heard?.client : undefined;
  const client = typed ?? (guess ? said : spoken);
  const asked = guess ? undefined : (said ?? heard?.project);
  // A name the core found and the model did not say: the user confirms where the item goes, whatever the labels.
  const confirm = heard?.project !== undefined || spoken !== undefined;
  // Below Private the clients are not read: a project said is enough, the client is left aside.
  if (client !== undefined && env.ims !== undefined && (asked === undefined || isAtMost('L2', env.task.clearance))) {
    // Below Private no client is read at all, not even to refuse.
    const clients = isAtMost('L2', env.task.clearance) ? await clientsForIm(env.sql) : [];
    // Only the projects approved as containers: one that is no longer cannot take the item.
    const approved = new Set(env.ims.projects().map((project) => project.name));
    const found = clientProject(clients.map((entry) => ({ ...entry, projects: entry.projects.filter((name) => approved.has(name)) })), client, asked, env.task.clearance);
    if (found.kind === 'project') {
      read = maxLabel(read, found.label);
      // The client chosen is named in the result: a different "Rossi" than meant shows at once.
      named = ` (cliente ${found.client})`;
      call = { ...args, project: found.project };
    } else if (found.none === true && (guess || (spoken !== undefined && heard?.project !== undefined))) {
      // No such client: a project misspelled stays a project (its error names the known ones), a project heard is used alone.
      read = maxLabel(read, found.label);
      if (heard?.project !== undefined) call = { ...args, project: heard.project };
    } else {
      return { text: `error: im.add: ${found.error}`, label: maxLabel(read, found.label) };
    }
  } else if (asked !== undefined && asked !== said) {
    call = { ...args, project: asked };
  }
  const outcome = addImTool(env.ims, { args: call, workspace, effective: maxLabel(env.context.effective, read), ...(confirm ? { confirm } : {}) });
  switch (outcome.kind) {
    case 'done':
      return { text: `${outcome.text}${named}`, label: maxLabel(outcome.label, read) };
    case 'error':
      return { text: `error: im.add: ${outcome.error}`, label: read };
    case 'confirm':
      // The approval and the answer once decided keep the label of the client that named the project.
      return { text: '', label: read, confirm: read === 'L0' ? outcome.proposal : { ...outcome.proposal, readLabel: read } };
  }
}

/**
 * The user's last three messages the task sees, newest first, with their
 * highest label: where a client or project left out is looked for, never
 * sent anywhere. The same bounds as the view of the conversation: up to the
 * task's own message, and within the session of the secretary (D-146).
 */
async function userTexts(env: ToolEnv): Promise<{ bodies: string[]; label: Label }> {
  if (env.task.conversationId === null) return { bodies: [], label: 'L0' };
  const rows = await env.sql<{ body: string; label: Label }[]>`
    SELECT m.body, m.label FROM messages m
    WHERE m.conversation_id = ${env.task.conversationId} AND m.role = 'user'
      AND m.id <= (SELECT max(id) FROM messages WHERE task_id = ${env.task.id} AND role = 'user')
      AND m.ts >= coalesce((
        SELECT max(coalesce((e.payload ->> 'from')::timestamptz, e.ts)) FROM events e, tasks t, conversations c
        WHERE t.id = ${env.task.id} AND c.id = ${env.task.conversationId} AND c.secretary
          AND e.kind = 'secretary.session' AND e.payload ->> 'conversationId' = c.id::text AND e.ts <= t.created_at
      ), '-infinity'::timestamptz)
    ORDER BY m.id DESC LIMIT 3`;
  return { bodies: rows.map((row) => row.body), label: maxLabel('L0', ...rows.map((row) => row.label)) };
}

/** A card in the inbox (autonomy A1), child of this task, labeled as what it was written from. */
async function card(args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const title = String(args.title).trim();
  const goal = typeof args.goal === 'string' && args.goal.trim() !== '' ? args.goal.trim() : undefined;
  // The project of the conversation's workspace: the card's on the wall (D-152).
  const project = await workspaceProject(env);
  // Created in the transaction of the step's turn: a step that runs again finds its turn, not a second card.
  const created = await createTask(env.sql, {
    ...(project === undefined ? {} : { project }),
    title,
    ...(goal === undefined ? {} : { goal }),
    parentId: env.task.id,
    label: env.context.effective,
    clearance: env.task.clearance,
    effectiveLabel: env.context.effective,
    assignee: 'user',
    status: 'inbox',
  });
  return { text: `created card ${created.id} in the inbox: ${title}`, label: 'L0' };
}
