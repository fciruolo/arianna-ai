import type { Activity, Delta, EditPiece, EditTool, LiveEditError, Message, SavedActivity, TerminalPiece } from './types.ts';

/**
 * The open conversation: stored messages plus the answers being written.
 * Pure and immutable, so the views can hold it in a ref and the tests need no
 * browser. Fragments arrive in order per reply; a gap is held until it fills.
 */
export interface StreamingReply {
  replyId: string;
  taskId: string;
  text: string;
  nextSeq: number;
  /** Fragments that arrived ahead of a missing one, by sequence number. */
  ahead: Record<number, string>;
}

export interface ChatState {
  conversationId: string;
  messages: Message[];
  streaming: StreamingReply[];
  /** What each task of this conversation did so far, by task id, oldest first. */
  activity: Record<string, Activity[]>;
  /** The Coder's live changes to files (D-117), by task id, oldest first: in memory only. */
  edits: Record<string, LiveEdit[]>;
  /** The paths the Coder's run changed so far (D-095, the "File" tab), by task id: paths only, in memory only. */
  touched: Record<string, string[]>;
  /** The terminal of the Coder's run (D-095), by task id, oldest first: in memory only, never stored. */
  terminal: Record<string, TerminalCall[]>;
}

export function emptyChat(conversationId: string): ChatState {
  return { conversationId, messages: [], streaming: [], activity: {}, edits: {}, touched: {}, terminal: {} };
}

/** A command or its output, as its pieces arrive. */
export interface TerminalText {
  total: number;
  /** Pieces arrived so far, by sequence number; emptied once `text` is set. */
  pieces: Record<number, string>;
  /** Set once every piece arrived. */
  text?: string;
  truncated: boolean;
  hidden: number;
  refused: boolean;
  error: boolean;
}

/** One call to Bash of a run (D-095): its command and, once it ended, its output. */
export interface TerminalCall {
  callId: string;
  step: number;
  command?: TerminalText;
  output?: TerminalText;
}

/** Calls kept per task: older ones scroll away. */
const MAX_TERMINAL_CALLS = 50;
/** More pieces than the core ever sends for one part (MAX_TERMINAL_PIECES of apps/core/src/live-terminal.ts). */
const MAX_TERMINAL_PIECES = 64;
/** Paths kept per task in the "File" tab while the run works. */
const MAX_TOUCHED = 200;

/** Adds a piece of the terminal of a task in this conversation; a part appears once every piece is there. */
export function applyTerminal(state: ChatState, piece: TerminalPiece): ChatState {
  if (piece.conversationId !== state.conversationId || piece.total > MAX_TERMINAL_PIECES) return state;
  const list = state.terminal[piece.taskId] ?? [];
  const call = list.find((item) => item.callId === piece.callId) ?? { callId: piece.callId, step: piece.step };
  const current: TerminalText = call[piece.part] ?? {
    total: piece.total,
    pieces: {},
    truncated: piece.truncated,
    hidden: piece.hidden,
    refused: piece.refused === true,
    error: piece.error === true,
  };
  if (current.text !== undefined || piece.total !== current.total || piece.seq in current.pieces) return state;
  const pieces = { ...current.pieces, [piece.seq]: piece.text };
  let next: TerminalText = { ...current, pieces };
  if (Object.keys(pieces).length === current.total) {
    next = { ...current, pieces: {}, text: Array.from({ length: current.total }, (_, seq) => pieces[seq] ?? '').join('') };
  }
  const updated: TerminalCall = { ...call, [piece.part]: next };
  const calls = list.some((item) => item.callId === piece.callId) ? list.map((item) => (item.callId === piece.callId ? updated : item)) : [...list, updated];
  return { ...state, terminal: { ...state.terminal, [piece.taskId]: calls.slice(-MAX_TERMINAL_CALLS) } };
}

/** A row of a live change: `gap` stands between two hunks or two parts of a change. */
export interface LiveEditRow {
  kind: 'context' | 'added' | 'removed' | 'gap';
  text: string;
}

/** A change the Coder is making to a file, as its pieces arrive (D-117). */
export interface LiveEdit {
  editId: string;
  step: number;
  path: string;
  tool: EditTool;
  added: number;
  removed: number;
  error?: LiveEditError;
  total: number;
  /** Pieces arrived so far, by sequence number; emptied once the rows are set. */
  pieces: Record<number, string>;
  /** Set once every piece arrived. */
  rows?: LiveEditRow[];
}

/** Changes kept per task: older ones scroll away. */
const MAX_EDITS = 10;
/** More pieces than the core ever sends for one change (64 KiB of text): a larger total is dropped. */
const MAX_PIECES = 256;

/** The rows of the lines of a live change, as the core writes them (apps/core/src/live-edit.ts). */
export function liveEditRows(text: string): LiveEditRow[] {
  if (text === '') return [];
  return text.split('\n').map((line): LiveEditRow => {
    const sign = line.charAt(0);
    const rest = line.slice(1);
    if (sign === '+') return { kind: 'added', text: rest };
    if (sign === '-') return { kind: 'removed', text: rest };
    if (sign === '@') return { kind: 'gap', text: '' };
    return { kind: 'context', text: rest };
  });
}

/** Adds a piece of a live change of a task in this conversation; the rows appear once every piece is there. */
export function applyEdit(state: ChatState, piece: EditPiece): ChatState {
  if (piece.conversationId !== state.conversationId || piece.total > MAX_PIECES) return state;
  const list = state.edits[piece.taskId] ?? [];
  const current = list.find((edit) => edit.editId === piece.editId) ?? {
    editId: piece.editId,
    step: piece.step,
    path: piece.path,
    tool: piece.tool,
    added: piece.added,
    removed: piece.removed,
    ...(piece.error === undefined ? {} : { error: piece.error }),
    total: piece.total,
    pieces: {},
  };
  if (current.rows !== undefined || piece.total !== current.total || piece.seq in current.pieces) return state;
  const pieces = { ...current.pieces, [piece.seq]: piece.text };
  let next: LiveEdit = { ...current, pieces };
  if (Object.keys(pieces).length === current.total) {
    const text = Array.from({ length: current.total }, (_, seq) => pieces[seq] ?? '').join('');
    next = { ...current, pieces: {}, rows: current.error === undefined ? liveEditRows(text) : [] };
  }
  const edits = list.some((edit) => edit.editId === piece.editId) ? list.map((edit) => (edit.editId === piece.editId ? next : edit)) : [...list, next];
  // The path, for the "File" tab of the Computer panel (D-095): paths only, never the contents.
  const paths = state.touched[piece.taskId] ?? [];
  const touched = paths.includes(piece.path) || paths.length >= MAX_TOUCHED ? state.touched : { ...state.touched, [piece.taskId]: [...paths, piece.path] };
  return { ...state, edits: { ...state.edits, [piece.taskId]: edits.slice(-MAX_EDITS) }, touched };
}

/** The complete live changes the card of a task shows: only while it is queued or running, as its lines. */
export function liveEdits(state: ChatState, taskId: string, status: string | undefined): LiveEdit[] {
  if (status !== undefined && status !== 'ready' && status !== 'running') return [];
  return (state.edits[taskId] ?? []).filter((edit) => edit.rows !== undefined);
}

/** The detail of the waiting line of a queued task (step 0, never a real step). */
export const QUEUED = 'queued';

/** Longest activity kept per task: older lines scroll away. */
const MAX_ACTIVITY = 30;

/**
 * Adds a line of activity of a task in this conversation. A "thinking" line
 * stands for the step in progress, so only the latest one is kept: any next
 * line replaces it.
 */
export function applyActivity(state: ChatState, activity: Activity): ChatState {
  if (activity.conversationId !== state.conversationId) return state;
  const lines = (state.activity[activity.taskId] ?? []).filter((line) => line.kind !== 'thinking');
  const last = lines.at(-1);
  if (last !== undefined && last.step === activity.step && last.kind === activity.kind && last.detail === activity.detail) return state;
  return { ...state, activity: { ...state.activity, [activity.taskId]: [...lines, activity].slice(-MAX_ACTIVITY) } };
}

/**
 * The lines a task saved so far (D-083), put back after a reload while it is
 * still queued or running: the live lines arrived meanwhile follow them, once.
 */
export function restoreActivity(state: ChatState, taskId: string, saved: readonly SavedActivity[]): ChatState {
  const key = (line: Pick<Activity, 'step' | 'kind' | 'detail'>): string => `${String(line.step)}\u0000${line.kind}\u0000${line.detail}`;
  const restored: Activity[] = saved.map(({ step, kind, detail }) => ({ conversationId: state.conversationId, taskId, step, kind, detail }));
  const known = new Set(restored.map(key));
  const lastStep = Math.max(0, ...saved.map((line) => line.step));
  // "thinking" is never saved: one of a step the saved lines went past is stale.
  const live = (state.activity[taskId] ?? []).filter((line) => !known.has(key(line)) && !(line.kind === 'thinking' && line.step < lastStep));
  const lines = [...restored, ...live].slice(-MAX_ACTIVITY);
  if (lines.length === 0) return state;
  return { ...state, activity: { ...state.activity, [taskId]: lines } };
}

/**
 * What the card of a task shows: its lines while it is queued or running,
 * and a waiting line when none arrived yet (a page reloaded before the first
 * saved line). A stopped task shows nothing: its saved steps open below the
 * answer.
 */
export function activityLines(state: ChatState, taskId: string, status: string | undefined): Activity[] {
  if (status !== undefined && status !== 'ready' && status !== 'running') return [];
  const lines = state.activity[taskId] ?? [];
  if (lines.length > 0 || status === undefined) return lines;
  return [{ conversationId: state.conversationId, taskId, step: 0, kind: 'thinking', detail: status === 'ready' ? QUEUED : '' }];
}

/** Adds messages of this conversation, without duplicates, in id order. */
export function mergeMessages(state: ChatState, incoming: readonly Message[]): ChatState {
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  for (const message of incoming) {
    if (message.conversationId === state.conversationId) byId.set(message.id, message);
  }
  const messages = [...byId.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  return { ...state, messages };
}

/** Appends a fragment of an answer being written in this conversation. */
export function applyDelta(state: ChatState, delta: Delta): ChatState {
  if (delta.conversationId !== state.conversationId) return state;
  const current = state.streaming.find((reply) => reply.replyId === delta.replyId) ?? {
    replyId: delta.replyId,
    taskId: delta.taskId,
    text: '',
    nextSeq: 0,
    ahead: {},
  };
  if (delta.seq < current.nextSeq) return state;
  const ahead = { ...current.ahead, [delta.seq]: delta.text };
  let { text, nextSeq } = current;
  for (let piece = ahead[nextSeq]; piece !== undefined; piece = ahead[nextSeq]) {
    text += piece;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a plain record of pending fragments
    delete ahead[nextSeq];
    nextSeq += 1;
  }
  const next: StreamingReply = { ...current, text, nextSeq, ahead };
  const others = state.streaming.filter((reply) => reply.replyId !== delta.replyId);
  return { ...state, streaming: [...others, next] };
}

/** The stored message replaced the answer being written. */
export function settleReply(state: ChatState, replyId: string): ChatState {
  if (!state.streaming.some((reply) => reply.replyId === replyId)) return state;
  return { ...state, streaming: state.streaming.filter((reply) => reply.replyId !== replyId) };
}

/** Ids of the tasks started or answered in the conversation, newest last. */
export function taskIds(state: ChatState): string[] {
  const ids: string[] = [];
  for (const message of state.messages) {
    if (message.taskId !== null && !ids.includes(message.taskId)) ids.push(message.taskId);
  }
  return ids;
}
