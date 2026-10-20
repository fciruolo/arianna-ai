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
  // The cards are created only once the user approves the plan in the web chat (D-159).
  'task.plan': { description: 'Propose cards with their dependencies, created after the user approves them', opens: [] },
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
  // The IM of a project (D-167, P4b): an item in an Interno file, reversible, written at once from a work
  // conversation; from a step that read more than the IM holds, after the user confirms the exact text in
  // the web chat. Written by code on this machine, never by a cloud executor.
  'im.add': { description: 'Add an item to the current or next IM of a project; above the IM label, after the user confirms the text', opens: [], localOnly: true },
  // The expense tracker (I-18, D-183): read only, computed by code from the database. Finance data never
  // leaves this machine: the read marks the task, and the gateway sends nothing of it to the cloud.
  'finance.summary': { description: 'Totals of the expense tracker per month and per category in a span, computed by the core', opens: [], localOnly: true },
  'finance.search': { description: 'Movements of the expense tracker by text, category and span, at most a few', opens: [], localOnly: true },
  'finance.alerts': { description: 'Checks of a month of the expense tracker: double charges, budgets, unusual expenses, changed subscriptions', opens: [], localOnly: true },
  // The user's profile «Su di te» (D-114, tappa B): read only, the text the step's clearance admits, written by
  // the core from the database. On this machine only: no fact leaves with it (one leaves with profile.share, tappa C).
  'profile.read': { description: "Read the text of a fact of the user's profile by its topic, within the clearance", opens: [], localOnly: true },
  // One fact to one agent (D-114, tappa C; D-213): the core reads the text and asks the user in the web chat, every
  // time; approved, it goes next to the brief of the next delegation to that agent, through the gateway, once. Not
  // external communication for the asking agent: it never sees nor sends the text, the delegation does (task.delegate).
  'profile.share': { description: "Ask the user to let one fact of the profile out to an agent, once, with the next delegation", opens: [], localOnly: true },
  // A fact Arianna heard in the conversation (D-114, tappa D): written "Solo in casa" only after the user confirms it.
  'profile.propose': { description: "Propose a fact for the user's profile, written as private only after the user confirms it", opens: [], localOnly: true },
  // A routine of the user (D-110, tappa A2; D-256): closed fields only, written off ("proposed") by the core; it
  // runs only after the user approves it in the web chat or on the page «Routine». Never a free recurring prompt.
  'routine.propose': { description: 'Propose a recurring report (days, time, closed sources), active only after the user approves it', opens: [], localOnly: true },
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

/**
 * The tools a card may give its runs on Claude Code through Arianna's MCP
 * server (`cloud_tools`, D-261): read only, served by the core within the
 * run's clearance (never above L1), each answer through the gateway. Apart
 * from `tools`, which the local steps use: a card listing them here does not
 * give the knowledge base to its local steps, nor the other way round.
 * `web.fetch` (D-262) reads one public page through the core: only an
 * address the user wrote in the request or a site of `[web] coder_sites`,
 * each address through the gateway; the run already opens untrusted content
 * and external communication by being in the cloud.
 */
export const CLOUD_TOOLS = ['kb.search', 'kb.read', 'web.fetch'] as const satisfies readonly ToolId[];
export type CloudToolId = (typeof CLOUD_TOOLS)[number];

export function isCloudToolId(value: unknown): value is CloudToolId {
  return (CLOUD_TOOLS as readonly unknown[]).includes(value);
}

/** The tools that read finance data (D-183): a card listing one answers only in its own private conversation. */
export const FINANCE_TOOLS = ['finance.summary', 'finance.search', 'finance.alerts'] as const satisfies readonly ToolId[];

export function isFinanceTool(tool: ToolId): boolean {
  return (FINANCE_TOOLS as readonly string[]).includes(tool);
}

/** A card that reads finance data (the agent of the Finances): any tool of FINANCE_TOOLS. */
export function isFinanceCard(card: { readonly tools: readonly ToolId[] }): boolean {
  return card.tools.some(isFinanceTool);
}
