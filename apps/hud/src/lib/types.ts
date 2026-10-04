// Shapes of the core's API (apps/core/src/server/http.ts) as they arrive in JSON.
export type Label = 'L0' | 'L1' | 'L2' | 'L3';
export type ConversationMode = 'work' | 'private';

export interface Conversation {
  id: string;
  mode: ConversationMode;
  clearance: Label;
  effectiveLabel: Label;
  workspace: string | null;
  /** The cloud model chosen for delegated steps (work only); null lets the router choose. */
  model: string | null;
  /** From the first message or the user; null until the first message (D-057). */
  title: string | null;
  /** When it was archived; null while it is in the list. */
  archivedAt: string | null;
  /** The conversation of the Telegram channel: it cannot be archived. */
  telegram: boolean;
  createdAt: string;
  lastMessageAt: string | null;
}

/** A project the user approved (D-058): the folder where the Coder works, as written in arianna.toml. */
export interface ProjectInfo {
  name: string;
  path: string;
  label: string;
}

/** A cloud model a work conversation may choose: a router alias and its executor. */
export interface CloudModel {
  executor: string;
  model: string;
}

export interface Message {
  id: string;
  conversationId: string;
  ts: string;
  role: 'user' | 'assistant' | 'system';
  channel: 'web' | 'telegram' | 'voice';
  label: Label;
  body: string;
  taskId: string | null;
  /** The agent that wrote an assistant message when it is not Arianna (`coder`); null otherwise. */
  agent: string | null;
}

export type TaskStatus = 'inbox' | 'ready' | 'running' | 'waiting_user' | 'to_verify' | 'done' | 'failed';

export interface Task {
  id: string;
  conversationId: string | null;
  title: string;
  status: TaskStatus;
  effectiveLabel: Label;
  waitingReason: string | null;
  waitingApprovalId: string | null;
}

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Approval {
  id: string;
  taskId: string | null;
  kind: 'action' | 'declassify' | 'budget' | 'setting' | 'workspace';
  action: string;
  detail: Record<string, unknown>;
  label: Label;
  state: ApprovalState;
  requestedAt: string;
  decidedAt: string | null;
  decidedVia: 'web' | 'telegram' | 'phone' | null;
}

/** An entry of the event log: ids and references only, never content. */
export interface LiveEvent {
  id: string;
  ts: string;
  taskId: string | null;
  runId: string | null;
  agent: string | null;
  kind: string;
  label: Label;
  payload: Record<string, unknown>;
}

export interface Delta {
  replyId: string;
  conversationId: string;
  taskId: string;
  seq: number;
  text: string;
}

export type ActivityKind = 'thinking' | 'search' | 'read' | 'write' | 'card' | 'plan' | 'error' | 'delegate' | 'tool' | 'wait';

/** One line of what a task is doing (D-054): never stored, gone after a reload. */
export interface Activity {
  conversationId: string;
  taskId: string;
  step: number;
  kind: ActivityKind;
  detail: string;
}

/** What an agent is doing, from GET /api/status (apps/core/src/status.ts). */
export type AgentState = 'idle' | 'thinking' | 'working' | 'waiting';

export interface AgentStatus {
  id: string;
  state: AgentState;
  run: { executor: string; model: string | null; startedAt: string; repo: string | null } | null;
}

/** The status panel (D-060): counts and labels only, never content. */
export interface StatusSnapshot {
  agents: AgentStatus[];
  router: {
    ts: string;
    label: Label;
    difficulty: string;
    decision: 'route' | 'wait';
    executor: string | null;
    model: string | null;
    locality: string | null;
    reason: string;
  } | null;
  gateway: { since: string; allowedOut: number; blocked: number; privateOut: number; hours: number[] };
  waiting: number;
}

export interface CharacterInfo {
  id: string;
  name: string;
  rows: 3 | 4;
}

export interface CharacterPack {
  id: string;
  name: string;
  source: string;
  original: boolean;
  characters: CharacterInfo[];
}

/** The character an agent wears: a sheet served at /api/characters/<pack>/<character>. */
export interface CharacterChoice {
  pack: string;
  character: string;
  rows: 3 | 4;
}

export interface CharacterListing {
  packs: CharacterPack[];
  refused: { pack: string; reason: string }[];
  agents: Record<string, CharacterChoice>;
}
