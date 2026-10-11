/**
 * The work of GOD (D-127, G2-G3): the plan under an answer of GOD, the
 * subtasks with their states and actions, the quota line. What the core
 * sends and the texts the page shows, in Italian.
 */

/** How full the fullest window of Claude is projected, and how many subtasks work at once. */
export interface GodQuota {
  projection: number | null;
  concurrency: number;
}

export type SubtaskState = 'queued' | 'working' | 'reviewing' | 'reviewed' | 'attention' | 'stopped' | 'branch' | 'discarded';
export type ReviewVerdict = 'ok' | 'changes' | 'unknown';

export interface GodSubtask {
  id: string;
  position: number;
  part: string;
  title: string;
  goal: string;
  files: string[];
  blockedBy: number[];
  state: SubtaskState;
  reason: string | null;
  review: ReviewVerdict | null;
  conversationId: string | null;
  reviewConversationId: string | null;
  commitSha: string | null;
  branch: string;
  path: string;
  changed: string[];
  outside: string[];
  merged?: boolean;
  mergeCommands?: string[];
}

export interface GodPlan {
  id: string;
  conversationId: string;
  messageId: string;
  title: string;
  model: string | null;
  createdAt: string;
  subtasks: GodSubtask[];
}

export interface PlannedSubtask {
  title: string;
  goal: string;
  files: string[];
  blockedBy: number[];
}

/** The plan under an answer of GOD (GET /api/god/messages/:id/plan). */
export interface MessagePlan {
  proposal?: { title: string; subtasks: PlannedSubtask[] };
  error?: string;
  approved?: GodPlan;
}

export type SubtaskAction = 'stop' | 'resume' | 'discard' | 'branch';

const FENCE = /```god-plan[ \t]*\n[\s\S]*?\n```/;

/** An answer of GOD that carries a plan block: the chat shows the card of the plan under it. */
export function hasPlanBlock(body: string): boolean {
  return FENCE.test(body);
}

/** The answer without its plan blocks: the card shows the plan instead of the JSON. */
export function withoutPlan(body: string): string {
  return body.replace(new RegExp(FENCE.source, 'g'), '').trim();
}

export const STATE_TEXT: Record<SubtaskState, string> = {
  queued: 'in coda',
  working: 'al lavoro',
  reviewing: 'in revisione',
  reviewed: 'rivisto',
  attention: 'serve te',
  stopped: 'fermato',
  branch: 'ramo pronto',
  discarded: 'scartato',
};

export type Tone = 'ok' | 'info' | 'warn' | 'neutral';

export const STATE_TONE: Record<SubtaskState, Tone> = {
  queued: 'neutral',
  working: 'info',
  reviewing: 'info',
  reviewed: 'ok',
  attention: 'warn',
  stopped: 'neutral',
  branch: 'ok',
  discarded: 'neutral',
};

/** The Reviewer's verdict in words; null before the review. */
export function verdictText(review: ReviewVerdict | null): string | null {
  if (review === null) return null;
  return review === 'ok' ? 'revisione: approvato' : review === 'changes' ? 'revisione: da correggere' : 'revisione: esito non detto';
}

/** The actions a subtask offers now, in the order of the buttons. */
export function actionsOf(subtask: Pick<GodSubtask, 'state'>): SubtaskAction[] {
  switch (subtask.state) {
    case 'queued':
    case 'working':
    case 'reviewing':
      return ['stop', 'discard'];
    case 'reviewed':
    case 'attention':
      return ['branch', 'stop', 'discard'];
    case 'stopped':
      return ['resume', 'branch', 'discard'];
    case 'branch':
      return ['discard'];
    case 'discarded':
      return [];
  }
}

export const ACTION_TEXT: Record<SubtaskAction, string> = {
  stop: 'Ferma',
  resume: 'Riprendi',
  discard: 'Scarta',
  branch: 'Prepara il ramo',
};

/** The projected quota in words. */
export function quotaText(quota: GodQuota): string {
  const at = quota.concurrency === 1 ? '1 sottocompito alla volta' : `${String(quota.concurrency)} sottocompiti alla volta`;
  if (quota.projection === null) return `Quota di Claude non ancora letta · ${at}`;
  return `Quota di Claude: ${String(Math.round(quota.projection * 100))}% previsto a fine finestra · ${at}`;
}

/** "aspetta 1 e 2": the subtasks one waits for, by number. */
export function waitsText(blockedBy: readonly number[]): string | null {
  if (blockedBy.length === 0) return null;
  return `aspetta ${blockedBy.length === 1 ? 'il' : 'i'} ${blockedBy.join(' e ')}`;
}
