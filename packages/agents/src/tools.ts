/**
 * The closed registry of tools an agent card may list (docs/AGENT-CARDS.md).
 * A card naming anything else is rejected. Each tool declares which sides of
 * the lethal trifecta it opens by itself and which approval its use needs, so
 * a card cannot claim to have removed a side that one of its tools opens.
 *
 * Reading private data is not a property of a tool but of the clearance:
 * `kb.read` opens it only for a card whose `max_label` is L2 (checked in card.ts).
 */
export const TRIFECTA_SIDES = ['private_data', 'untrusted_content', 'external_comms'] as const;
export type TrifectaSide = (typeof TRIFECTA_SIDES)[number];

/** Actions that need the user's approval (`approvals.action`, kind `action`). */
export const APPROVAL_ACTIONS = ['delete', 'send_external', 'payment', 'call'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export interface ToolSpec {
  description: string;
  /** Sides of the trifecta this tool opens whatever the clearance. */
  opens: readonly TrifectaSide[];
  /** Approval needed before each use; the card must list it in `approvals`. */
  approval?: ApprovalAction;
}

export const TOOLS = {
  'kb.read': { description: 'Read a knowledge base page within the clearance', opens: [] },
  'kb.search': { description: 'Search the knowledge base within the clearance', opens: [] },
  'kb.write': { description: 'Write a knowledge base page (A1: inbox only)', opens: [] },
  'task.create': { description: 'Create a card (A1: inbox only)', opens: [] },
  'task.update': { description: 'Update a card the agent is working on', opens: [] },
  // Not external communication for the delegating agent, because the delegated
  // step runs in a separate per-task context that has read only the brief: the
  // delegator's private context never reaches the other side. The gateway alone
  // would not be a reason (channel.send passes it too, and opens the side).
  // The executor that receives the step is judged by its own card.
  'task.delegate': { description: 'Hand a step to another agent or executor, through the gateway', opens: [] },
  'user.ask': { description: 'Ask the user in the web chat', opens: [] },
  'repo.read': { description: 'Read files in the run worktree', opens: [] },
  'repo.write': { description: 'Write files in the run worktree', opens: [] },
  // Tests of an untrusted repository may try the network: opens nothing only
  // because the sandbox of task 1.6 blocks it, for the local executor too.
  'repo.test': { description: 'Run the project checks in the run worktree', opens: [] },
  'file.delete': { description: 'Delete a file outside the sandbox', opens: [], approval: 'delete' },
  'web.search': { description: 'Search the web', opens: ['untrusted_content', 'external_comms'] },
  'web.fetch': { description: 'Fetch a web page', opens: ['untrusted_content', 'external_comms'] },
  'channel.send': {
    description: 'Send a message on an external channel (Telegram, phone), through the gateway',
    opens: ['external_comms'],
    approval: 'send_external',
  },
} as const satisfies Record<string, ToolSpec>;

export type ToolId = keyof typeof TOOLS;

export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && Object.hasOwn(TOOLS, value);
}

export function toolSpec(id: ToolId): ToolSpec {
  return TOOLS[id];
}
