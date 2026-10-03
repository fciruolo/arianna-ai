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
  createdAt: string;
  lastMessageAt: string | null;
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
