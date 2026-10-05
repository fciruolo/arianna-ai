import type { Activity, AgentState, Approval, Task } from './types.ts';

/**
 * Which frames of a character sheet (D-060, the format of pixel-agents) a
 * pixel agent shows. Columns: 0–2 walk, 3–4 type, 5–6 read; rows: down, up,
 * right, and Arianna's own fourth row with think (0–1), wait (2–3), pause
 * (4–5) and blink (6). A sheet of another pack has three rows: the poses it
 * lacks are made from the other frames, and the bubble says the rest.
 */
export type Pose = 'idle' | 'thinking' | 'working' | 'reading' | 'waiting' | 'paused';

export interface Frame {
  column: number;
  row: number;
}

export interface PoseFrames {
  frames: Frame[];
  /** How long each frame stays. */
  ms: number;
}

export const FRAME_WIDTH = 16;
export const FRAME_HEIGHT = 32;

const at = (column: number, row = 0): Frame => ({ column, row });

/** Standing still for about four seconds, then a blink when the sheet has one. */
function idle(rows: 3 | 4): PoseFrames {
  const still = Array.from({ length: 26 }, () => at(1));
  return { frames: rows === 4 ? [...still, at(6, 3)] : still, ms: 150 };
}

export function poseFrames(pose: Pose, rows: 3 | 4): PoseFrames {
  switch (pose) {
    case 'idle':
      return idle(rows);
    case 'working':
      return { frames: [at(3), at(4)], ms: 180 };
    case 'reading':
      return { frames: [at(5), at(6)], ms: 520 };
    case 'thinking':
      return rows === 4 ? { frames: [at(0, 3), at(1, 3)], ms: 650 } : { frames: [at(5), at(6)], ms: 650 };
    case 'waiting':
      return rows === 4 ? { frames: [at(2, 3), at(3, 3)], ms: 450 } : idle(rows);
    case 'paused':
      return rows === 4 ? { frames: [at(4, 3), at(5, 3)], ms: 1200 } : { frames: [at(1)], ms: 1000 };
  }
}

/** The bubble over the head: the HUD of the mockup, also what a three-row sheet cannot draw. */
export const POSE_BUBBLE: Record<Pose, string | undefined> = {
  idle: undefined,
  thinking: '…',
  working: '⌨',
  reading: undefined,
  waiting: '!',
  paused: 'zz',
};

/** What the user reads under the agent's name. */
export const POSE_TEXT: Record<Pose, string> = {
  idle: 'Qui con te',
  thinking: 'Sta pensando…',
  working: 'Al lavoro',
  reading: 'Sta leggendo',
  waiting: 'Aspetta una tua decisione',
  paused: 'In pausa',
};

/**
 * The pose of an agent from the status of the core and, for the open
 * conversation, the last line of activity of its running task: the line says
 * more than the run (reading the knowledge base, writing, delegating).
 */
export function poseOf(state: AgentState | undefined, activity: Activity | undefined): Pose {
  if (activity !== undefined) {
    switch (activity.kind) {
      case 'search':
      case 'read':
        return 'reading';
      case 'write':
      case 'card':
      case 'delegate':
      case 'tool':
        return 'working';
      case 'thinking':
      case 'plan':
      case 'wait':
      case 'error':
        return 'thinking';
    }
  }
  switch (state) {
    case 'thinking':
      return 'thinking';
    case 'working':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'idle':
    case undefined:
      return 'idle';
  }
}

/**
 * What Arianna is doing for the open conversation, from its tasks only: the
 * status of the core is about every conversation, so a task running or
 * waiting elsewhere would show here too. A task at work wins over one waiting.
 * "Waiting" needs a real reason in this conversation (D-084): a pending
 * approval of one of its tasks, or a task waiting for the user whose approval,
 * if it has one, is still pending (one decided elsewhere no longer counts). A
 * task of another conversation (a system chat points at the failed task of
 * its source conversation) never counts.
 */
export function conversationState(
  tasks: readonly Pick<Task, 'id' | 'conversationId' | 'status' | 'waitingApprovalId'>[],
  conversationId: string | undefined,
  approvals: readonly Pick<Approval, 'id' | 'taskId' | 'state'>[] = [],
): AgentState {
  const own = tasks.filter((task) => conversationId !== undefined && task.conversationId === conversationId);
  if (own.some((task) => task.status === 'running' || task.status === 'ready' || task.status === 'inbox')) return 'thinking';
  const pending = approvals.filter((approval) => approval.state === 'pending');
  const ownIds = new Set(own.map((task) => task.id));
  const pendingIds = new Set(pending.map((approval) => approval.id));
  if (pending.some((approval) => approval.taskId !== null && ownIds.has(approval.taskId))) return 'waiting';
  if (own.some((task) => task.status === 'waiting_user' && (task.waitingApprovalId === null || pendingIds.has(task.waitingApprovalId)))) return 'waiting';
  return 'idle';
}

/** The frame to show at `elapsed` milliseconds into the pose; the first one with reduced motion. */
export function frameAt(pose: PoseFrames, elapsed: number, reduceMotion: boolean): Frame {
  const index = reduceMotion ? 0 : Math.floor(Math.max(0, elapsed) / pose.ms) % pose.frames.length;
  return pose.frames[index] ?? at(1);
}

/** The rows of a sheet from its size (D-060): 112×96 or 112×128; undefined for any other size. */
export function sheetRowsOf(width: number, height: number): 3 | 4 | undefined {
  if (width !== FRAME_WIDTH * 7) return undefined;
  return height === FRAME_HEIGHT * 3 ? 3 : height === FRAME_HEIGHT * 4 ? 4 : undefined;
}

/** One animation of the preview (D-118): `mirror` draws the frames flipped, as the office does for left. */
export interface SheetAnimation {
  id: string;
  label: string;
  frames: Frame[];
  ms: number;
  mirror: boolean;
}

const walk = (row: number): Frame[] => [at(0, row), at(1, row), at(2, row), at(1, row)];

/** Every animation a sheet holds, in the order of the preview: the fourth row only when there is one. */
export function sheetAnimations(rows: 3 | 4): SheetAnimation[] {
  const list: SheetAnimation[] = [
    { id: 'walk-down', label: 'Cammina giù', frames: walk(0), ms: 160, mirror: false },
    { id: 'walk-up', label: 'Cammina su', frames: walk(1), ms: 160, mirror: false },
    { id: 'walk-right', label: 'Cammina a destra', frames: walk(2), ms: 160, mirror: false },
    { id: 'walk-left', label: 'Cammina a sinistra', frames: walk(2), ms: 160, mirror: true },
    { id: 'type', label: 'Scrive', frames: [at(3), at(4)], ms: 180, mirror: false },
    { id: 'read', label: 'Legge', frames: [at(5), at(6)], ms: 520, mirror: false },
  ];
  if (rows === 4) {
    list.push(
      { id: 'think', label: 'Pensa', frames: [at(0, 3), at(1, 3)], ms: 650, mirror: false },
      { id: 'wait', label: 'Aspetta', frames: [at(2, 3), at(3, 3)], ms: 450, mirror: false },
      { id: 'pause', label: 'Pausa', frames: [at(4, 3), at(5, 3)], ms: 1200, mirror: false },
      { id: 'blink', label: 'Sbatte gli occhi', frames: [at(1), at(1), at(1), at(6, 3)], ms: 250, mirror: false },
    );
  }
  return list;
}

/** The id the core makes from the name of an uploaded character (D-118): the same rule as `characterId` in apps/core. */
export function characterId(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** A name the core accepts: one line of 1-40 characters, no control or format characters, giving a non-empty id. */
export function characterNameValid(name: string): boolean {
  const trimmed = name.trim();
  return trimmed !== '' && trimmed.length <= 40 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) && characterId(name) !== '';
}
