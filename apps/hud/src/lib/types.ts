// Shapes of the core's API (apps/core/src/server/http.ts) as they arrive in JSON.
export type Label = 'L0' | 'L1' | 'L2' | 'L3';
export type ConversationMode = 'work' | 'private';

export interface Conversation {
  id: string;
  mode: ConversationMode;
  clearance: Label;
  effectiveLabel: Label;
  workspace: string | null;
  createdAt: string;
  lastMessageAt: string | null;
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
  kind: 'action' | 'declassify' | 'budget' | 'setting';
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
