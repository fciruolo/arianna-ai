import type { Autonomy, ToolId } from '@arianna/agents';
import { maxLabel, type Context, type Label } from '@arianna/policy';

import type { Queryable } from '../db/client.ts';
import { createTask, type Task } from '../tasks.ts';
import { updateCard } from './cards.ts';
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
 */
export const LOCAL_TOOLS = ['kb.search', 'kb.read', 'kb.write', 'task.create', 'task.update'] as const satisfies readonly ToolId[];
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
}

export interface ToolResult {
  text: string;
  /** Highest label of the data the tool returned; L0 when it returned none. */
  label: Label;
}

/** Longest page text shown to the model in one result. */
const MAX_READ = 6_000;

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

/** A card in the inbox (autonomy A1), child of this task, labeled as what it was written from. */
async function card(args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const title = String(args.title).trim();
  const goal = typeof args.goal === 'string' && args.goal.trim() !== '' ? args.goal.trim() : undefined;
  // Created in the transaction of the step's turn: a step that runs again finds its turn, not a second card.
  const created = await createTask(env.sql, {
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
