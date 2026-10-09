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
  /**
   * The tool reads or writes private data of the user by its nature (the
   * commitments of the secretary, L2, D-144): only a card that reads L2 and
   * runs on the local model alone may list it.
   */
  localOnly?: boolean;
}

export const TOOLS = {
  'kb.read': { description: 'Read a knowledge base page within the clearance', opens: [] },
  'kb.search': { description: 'Search the knowledge base within the clearance', opens: [] },
  'kb.write': { description: 'Write a knowledge base page (A1: inbox only)', opens: [] },
  'task.create': { description: 'Create a card (A1: inbox only)', opens: [] },
  'task.update': { description: 'Update a card of this conversation (status and note), never the task in progress', opens: [] },
  // Not external communication for the delegating agent, because the delegated
  // step runs in a separate per-task context that has read only the brief: the
  // delegator's private context never reaches the other side. The gateway alone
  // would not be a reason (channel.send passes it too, and opens the side).
  // The executor that receives the step is judged by its own card.
  'task.delegate': { description: 'Hand a step to another agent or executor, through the gateway', opens: [] },
  'user.ask': { description: 'Ask the user in the web chat', opens: [] },
  // The secretary (I-12, D-144): the commitments are L2 and never leave this machine.
  // Noting one or marking it done waits for the user's confirmation in the web chat.
  'commitment.add': { description: 'Note a commitment of the user with its day, after the user confirms the day', opens: [], localOnly: true },
  'commitment.list': { description: 'List the commitments of a day, written by the core from the database', opens: [], localOnly: true },
  'commitment.done': { description: 'Mark a commitment done, after the user confirms it', opens: [], localOnly: true },
  'commitment.move': { description: 'Move a commitment to another day or time, after the user confirms it', opens: [], localOnly: true },
  'commitment.report': { description: 'Note how commitments went (done, not done, postponed) and why, after the user confirms it', opens: [], localOnly: true },
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
