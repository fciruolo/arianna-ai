import { knownAgentName } from '../italian.ts';
import { poseOf, type Pose } from '../sprites.ts';
import type { ActivityKind, AgentStatus, Label } from '../types.ts';

/**
 * The "photograph" of the office (D-106): the only thing the canvas
 * receives. A closed list of fields: who, pose, place, label, local or
 * cloud, counts. Never a title, a message, a path, a command or an activity
 * detail; project names only when they are names of approved projects
 * (lower case, digits and hyphens). A test checks the list.
 */
export type OfficePose = Pose;

/**
 * Where an agent sits. On an island or at the archive a second agent sits
 * beside the first (D-124): `seat` 1, 2… is the chair next to the main one,
 * absent for the main one.
 */
export type OfficePlace =
  | { kind: 'private' }
  | { kind: 'island'; slot: number; seat?: number }
  | { kind: 'archive'; seat?: number }
  | { kind: 'pause'; seat: number };

export interface OfficeAgent {
  id: string;
  /** The fixed name of the agent's card (lib/italian.ts), never one written by the user; "Agente" for an unknown id. */
  name: string;
  pose: OfficePose;
  place: OfficePlace;
  locality: 'local' | 'cloud' | null;
}

export interface OfficeIsland {
  slot: number;
  project: string;
  label: Label;
}

export interface OfficeSnapshot {
  agents: OfficeAgent[];
  islands: OfficeIsland[];
  /** Projects beyond the slots, behind the archive: names of approved projects only. */
  archived: string[];
  /** Projects behind the archive whose name is not a project name: counted, never named. */
  unnamed: number;
  decisions: { total: number; hidden: number };
}

/** A line of activity reduced to what the office may know: where, what kind, when. Never the detail. */
export interface ActivitySignal {
  conversationId: string;
  kind: ActivityKind;
  at: number;
}

export interface OfficeInput {
  agents: readonly AgentStatus[];
  projects: readonly { name: string; path: string; label: string }[];
  /** Island slots of the map. */
  slots: number;
  /** Recent activity kinds, any conversation. */
  activity: readonly ActivitySignal[];
  /** The conversations of the Coder's running delegations: their activity is his. */
  coderConversations: readonly string[];
  /** What waits for the user, counted as in "Decisioni in attesa" (D-091): the Coder's share is the folder requests. */
  pending: { total: number; hidden: number; coder: number };
  /** Agent → until when (ms) it is paused by a quota of its executor. */
  quota: Readonly<Record<string, number>>;
  now: number;
  /** Reduced motion: Arianna, free, stays at Privata instead of wandering (D-124). */
  still?: boolean;
}

/** A project name may become an island's name: the names of approved projects (D-058). */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** An activity line older than this no longer says what the agent is doing. */
export const ACTIVITY_FRESH_MS = 20_000;
/** A quota without its reset time pauses for an hour. */
export const QUOTA_PAUSE_MS = 60 * 60 * 1000;

/**
 * Arianna free or waiting for the user wanders between her office and the
 * pause (D-124): this long at each, by the clock, so the same time gives the
 * same place (the tests inject the clock).
 */
export const WANDER_MS = 30_000;

/** The name of an agent the chat does not know: never its raw id. */
export const UNKNOWN_AGENT = 'Agente';

const LABELS: readonly Label[] = ['L0', 'L1', 'L2', 'L3'];

/**
 * Islands: "Privata" is always there (it is not a slot); the approved
 * projects fill the slots in their stable order (the order of arianna.toml),
 * the others go behind the archive. A name that is not a project name never
 * reaches the office: only counted behind the archive, apart from the names
 * (so a real project named like a placeholder is never confused with one).
 */
export function assignIslands(projects: OfficeInput['projects'], slots: number): { islands: OfficeIsland[]; archived: string[]; unnamed: number } {
  const seen = new Set<string>();
  const valid: OfficeIsland[] = [];
  const archived: string[] = [];
  let unnamed = 0;
  for (const project of projects) {
    if (seen.has(project.name)) continue;
    seen.add(project.name);
    if (!PROJECT_NAME.test(project.name)) {
      unnamed++;
      continue;
    }
    const label = LABELS.find((item) => item === project.label) ?? 'L2';
    if (valid.length < slots) valid.push({ slot: valid.length, project: project.name, label });
    else archived.push(project.name);
  }
  return { islands: valid, archived, unnamed };
}

/** The island of a repository the core names (a project name, or its path), or the archive. */
export function placeOfRepo(repo: string | null, projects: OfficeInput['projects'], islands: readonly OfficeIsland[]): OfficePlace {
  if (repo !== null) {
    const project = projects.find((item) => item.name === repo || item.path === repo || item.path.split('/').at(-1) === repo);
    const island = project === undefined ? undefined : islands.find((item) => item.project === project.name);
    if (island !== undefined) return { kind: 'island', slot: island.slot };
  }
  return { kind: 'archive' };
}

/**
 * Arianna's place (D-124): running in a work conversation, the island of its
 * project (the archive without one); running elsewhere, Privata; free or
 * waiting, Privata and the pause in turn by the clock, or Privata when still.
 */
export function ariannaPlace(
  run: AgentStatus['run'],
  running: boolean,
  projects: OfficeInput['projects'],
  islands: readonly OfficeIsland[],
  now: number,
  still: boolean,
  pauseSeat: () => number,
): OfficePlace {
  if (running) return run?.mode === 'work' ? placeOfRepo(run.repo, projects, islands) : { kind: 'private' };
  if (still || Math.floor(now / WANDER_MS) % 2 === 0) return { kind: 'private' };
  return { kind: 'pause', seat: pauseSeat() };
}

/** Same island or archive, second comer: the chair beside (Arianna is always the one who comes second). */
function shareSeats(places: Map<string, OfficePlace>, order: readonly string[]): void {
  const taken = new Map<string, number>();
  for (const id of order) {
    const place = places.get(id);
    if (place === undefined || (place.kind !== 'island' && place.kind !== 'archive')) continue;
    const key = placeKey(place);
    const count = taken.get(key) ?? 0;
    taken.set(key, count + 1);
    if (count > 0) places.set(id, { ...place, seat: count });
  }
}

function latest(signals: readonly ActivitySignal[], now: number, keep: (signal: ActivitySignal) => boolean): ActivitySignal | undefined {
  let found: ActivitySignal | undefined;
  for (const signal of signals) {
    if (now - signal.at > ACTIVITY_FRESH_MS || signal.at > now + 1000 || !keep(signal)) continue;
    if (found === undefined || signal.at >= found.at) found = signal;
  }
  return found;
}

/**
 * The pose of an agent, the rules of D-106:
 * - running: the kind of its latest fresh activity line (search/read → legge;
 *   write/card/delegate/tool → scrive; thinking/plan/wait/error → pensa), else
 *   its state (thinking on the local model, working on a cloud executor);
 * - not running and something waits for the user that is its own (an approval
 *   or a question, as conversationState says for a conversation) → aspetta te;
 * - not running and paused by a quota of its executor → in pausa;
 * - otherwise free.
 */
export function agentPose(
  state: AgentStatus['state'],
  activity: ActivitySignal | undefined,
  waits: boolean,
  pausedUntil: number | undefined,
  now: number,
): OfficePose {
  if (state === 'thinking' || state === 'working') {
    return poseOf(state, activity === undefined ? undefined : { conversationId: activity.conversationId, taskId: '', step: 0, kind: activity.kind, detail: '' });
  }
  if (waits || state === 'waiting') return 'waiting';
  if (pausedUntil !== undefined && pausedUntil > now) return 'paused';
  return 'idle';
}

export function officeSnapshot(input: OfficeInput): OfficeSnapshot {
  const { islands, archived, unnamed } = assignIslands(input.projects, input.slots);
  const coderSet = new Set(input.coderConversations);
  const ordered = [...input.agents].sort((a, b) => (a.id === 'arianna' ? -1 : b.id === 'arianna' ? 1 : a.id.localeCompare(b.id)));
  // Places: the other agents first, so that Arianna takes the pause seat and
  // the island chair left free and nobody moves when she comes.
  const placing = [...ordered.filter((agent) => agent.id !== 'arianna'), ...ordered.filter((agent) => agent.id === 'arianna')];
  let pauseSeat = 0;
  const places = new Map<string, OfficePlace>();
  for (const agent of placing) {
    const running = agent.state === 'thinking' || agent.state === 'working';
    if (agent.id === 'arianna') places.set(agent.id, ariannaPlace(agent.run, running, input.projects, islands, input.now, input.still === true, () => pauseSeat++));
    else if (running) places.set(agent.id, placeOfRepo(agent.run?.repo ?? null, input.projects, islands));
    else places.set(agent.id, { kind: 'pause', seat: pauseSeat++ });
  }
  shareSeats(places, placing.map((agent) => agent.id));
  const agents = ordered.map((agent): OfficeAgent => {
    const arianna = agent.id === 'arianna';
    const activity = latest(input.activity, input.now, (signal) => (arianna ? !coderSet.has(signal.conversationId) : coderSet.has(signal.conversationId)));
    const others = input.pending.total - input.pending.coder;
    const waits = arianna ? others > 0 : agent.id === 'coder' && input.pending.coder > 0;
    const pose = agentPose(agent.state, activity, waits, input.quota[agent.id], input.now);
    return {
      id: agent.id,
      name: knownAgentName(agent.id) ?? UNKNOWN_AGENT,
      pose,
      place: places.get(agent.id) ?? { kind: 'private' },
      locality: agent.state === 'thinking' ? 'local' : agent.state === 'working' ? 'cloud' : null,
    };
  });
  return {
    agents,
    islands,
    archived,
    unnamed,
    decisions: { total: Math.max(0, input.pending.total), hidden: Math.max(0, input.pending.hidden) },
  };
}

/** The bubble over an agent: "…" thinks, "!" waits for you, "zZ" paused. */
export type Bubble = 'dots' | 'bang' | 'zz';

export function bubbleOf(pose: OfficePose, walking: boolean): Bubble | null {
  if (walking) return null;
  if (pose === 'thinking') return 'dots';
  if (pose === 'waiting') return 'bang';
  if (pose === 'paused') return 'zz';
  return null;
}

/** What the user reads next to the name: short, the state only. */
export const POSE_SHORT: Record<OfficePose | 'walking', string> = {
  idle: 'libero',
  thinking: 'pensa',
  working: 'scrive',
  reading: 'legge',
  waiting: 'aspetta te',
  paused: 'in pausa',
  walking: 'cammina',
};

/** Same key for the same place: an agent walks only when its place changes. */
export function placeKey(place: OfficePlace): string {
  switch (place.kind) {
    case 'island':
      return place.seat === undefined ? `island-${String(place.slot)}` : `island-${String(place.slot)}-${String(place.seat)}`;
    case 'archive':
      return place.seat === undefined ? 'archive' : `archive-${String(place.seat)}`;
    case 'pause':
      return `pause-${String(place.seat)}`;
    default:
      return place.kind;
  }
}
