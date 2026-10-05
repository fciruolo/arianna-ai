// Shapes of the core's API (apps/core/src/server/http.ts) as they arrive in JSON.
export type Label = 'L0' | 'L1' | 'L2' | 'L3';
export type ConversationMode = 'work' | 'private';

/** The agents a conversation can have in place of Arianna (D-111). */
export type ConversationAgent = 'coder';

export interface Conversation {
  id: string;
  mode: ConversationMode;
  clearance: Label;
  effectiveLabel: Label;
  workspace: string | null;
  /** The cloud model chosen for delegated steps (work only); null lets the router choose. */
  model: string | null;
  /** Who answers (D-111): null is Arianna, 'coder' the direct chat with the Coder; chosen at creation. */
  agent: ConversationAgent | null;
  /** Direct chat only: tokens in the Coder's session after its latest answer, for the context indicator. */
  contextTokens: number | null;
  /** From the first message or the user; null until the first message (D-057). */
  title: string | null;
  /** When it was archived; null while it is in the list. */
  archivedAt: string | null;
  /** The conversation of the Telegram channel: it cannot be archived. */
  telegram: boolean;
  /** 'system' for a system chat, opened by the system (D-064). */
  origin: 'user' | 'system';
  systemReason: 'failure' | null;
  /** The failed task a system chat is about, and its conversation. */
  sourceTaskId: string | null;
  sourceConversationId: string | null;
  /** The question of the failed task is attached to the system chat. */
  questionAttached: boolean;
  /** The status of the source task now: "Riprova" only while it is failed. */
  sourceTaskStatus: TaskStatus | null;
  createdAt: string;
  lastMessageAt: string | null;
  /** When the user pinned it at the top of the list (D-089); null when not pinned, always null while archived. */
  pinnedAt: string | null;
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
  /** The cloud model that wrote Arianna's answer (Claude in a system chat, D-064); null for the local model. */
  model: string | null;
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

/** Why a task failed (D-064): no text, the page explains the code (lib/failures.ts). */
export interface TaskFailure {
  id: string;
  taskId: string;
  ts: string;
  origin: 'local-model' | 'claude' | 'tool' | 'engine';
  code: string;
  details: Record<string, string | number | boolean>;
  label: Label;
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

/** One line of what a task is doing (D-054), live over the WebSocket; saved lines come as SavedActivity (D-083). */
export interface Activity {
  conversationId: string;
  taskId: string;
  step: number;
  kind: ActivityKind;
  detail: string;
}

export type EditTool = 'Edit' | 'MultiEdit' | 'Write';
export type LiveEditError = 'too-large' | 'refused';

/**
 * A piece of a change the Coder is making to a file (D-117, second stage),
 * live over the WebSocket only: the lines come in `total` pieces, joined by
 * `seq`. Never stored.
 */
export interface EditPiece {
  editId: string;
  conversationId: string;
  taskId: string;
  step: number;
  /** Relative to the project. */
  path: string;
  tool: EditTool;
  label: 'L0' | 'L1';
  added: number;
  removed: number;
  error?: LiveEditError;
  seq: number;
  total: number;
  text: string;
}

/** A line a task saved (D-083), from GET /api/tasks/:id/activities; "thinking" is never saved. */
export interface SavedActivity {
  id: string;
  step: number;
  kind: Exclude<ActivityKind, 'thinking'>;
  detail: string;
  label: Label;
  /** ISO time. */
  at: string;
}

/** What an agent is doing, from GET /api/status (apps/core/src/status.ts). */
export type AgentState = 'idle' | 'thinking' | 'working' | 'waiting';

export interface AgentStatus {
  id: string;
  state: AgentState;
  /** `mode`: the kind of the run's conversation (D-124); absent from an older core. */
  run: { executor: string; model: string | null; startedAt: string; repo: string | null; mode?: 'work' | 'private' | null } | null;
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

/** How a file changed in the run of a delegation (D-082). */
export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DelegationFile {
  /** Relative to the project. */
  path: string;
  change: FileChangeKind;
  /** The old path of a rename. */
  from?: string;
}

/** Under an answer written in the cloud: who wrote it, on what, in how long (D-082). */
export interface MessageCredit {
  messageId: string;
  delegationId: string | null;
  agent: string | null;
  executor: string | null;
  alias: string | null;
  model: string | null;
  durationMs: number | null;
  cost: number | null;
  repo: string | null;
  files: DelegationFile[] | null;
}

/** A row of "Deleghe recenti": metadata only. */
export interface RecentDelegation {
  id: string;
  conversationId: string | null;
  conversationTitle: string | null;
  agent: string;
  repo: string | null;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'refused';
  executor: string | null;
  alias: string | null;
  model: string | null;
  createdAt: string;
  durationMs: number | null;
  cost: number | null;
  files: number | null;
}

/** A line of a diff (D-117). */
export interface DiffLine {
  kind: 'context' | 'added' | 'removed';
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Why the diff of a file is not shown: the preview's reasons, plus `too-many`, `no-base` and `unreadable`. */
export type FileDiffError = 'not-found' | 'deleted' | 'not-approved' | 'refused' | 'too-large' | 'binary' | 'archived' | 'busy' | 'too-many' | 'no-base' | 'unreadable';

/** The diff of one file of a delegation, or why it is not shown. */
export type FileDiff = DelegationFile & { index: number } & ({ added: number; removed: number; hunks: DiffHunk[] } | { error: FileDiffError });

/** What the run changed, file by file, against the commit its files were listed against. */
export interface DelegationDiff {
  repo: string;
  baseCommit: string | null;
  files: FileDiff[];
}

/** A changed file as it is now, read only. */
export interface FilePreview {
  path: string;
  change: FileChangeKind;
  repo: string;
  size: number;
  text: string;
}

/** "Novità": a section of a version of CHANGELOG.md (Aggiunto, Cambiato, Corretto, Sicurezza, Rimosso, or another title). */
export interface ChangelogSection {
  title: string;
  /** Markdown on one line. */
  items: string[];
}

/** A version of the register; `version` and `date` are null for "Non rilasciato". */
export interface ChangelogVersion {
  version: string | null;
  date: string | null;
  unreleased: boolean;
  /** Free text before the first section (Markdown), or null. */
  summary: string | null;
  sections: ChangelogSection[];
}

/** The register of the versions, read by the core from CHANGELOG.md. */
export interface Changelog {
  /** The highest released version, or null. */
  current: string | null;
  versions: ChangelogVersion[];
  /** Lines the core did not understand. */
  skipped: number;
}

/** An agent that joined the conversation as a colleague (D-125), from GET /api/conversations/:id/participants. */
export interface Participant {
  agent: string;
  addedBy: 'arianna' | 'user';
  /** ISO time. */
  addedAt: string;
  /** 'claude' or 'local'; null for an agent no longer active. */
  executor: string | null;
}
