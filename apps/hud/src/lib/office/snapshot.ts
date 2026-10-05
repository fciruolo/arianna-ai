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

export type OfficePlace =
  | { kind: 'private' }
  | { kind: 'island'; slot: number }
  | { kind: 'archive' }
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
}

/** A project name may become an island's name: the names of approved projects (D-058). */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** An activity line older than this no longer says what the agent is doing. */
export const ACTIVITY_FRESH_MS = 20_000;
/** A quota without its reset time pauses for an hour. */
export const QUOTA_PAUSE_MS = 60 * 60 * 1000;

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
  let pauseSeat = 0;
  const agents = ordered.map((agent): OfficeAgent => {
    const arianna = agent.id === 'arianna';
    const activity = latest(input.activity, input.now, (signal) => (arianna ? !coderSet.has(signal.conversationId) : coderSet.has(signal.conversationId)));
    const others = input.pending.total - input.pending.coder;
    const waits = arianna ? others > 0 : agent.id === 'coder' && input.pending.coder > 0;
    const pose = agentPose(agent.state, activity, waits, input.quota[agent.id], input.now);
    const running = agent.state === 'thinking' || agent.state === 'working';
    let place: OfficePlace;
    if (arianna) place = { kind: 'private' };
    else if (running) place = placeOfRepo(agent.run?.repo ?? null, input.projects, islands);
    else place = { kind: 'pause', seat: pauseSeat++ };
    return {
      id: agent.id,
      name: knownAgentName(agent.id) ?? UNKNOWN_AGENT,
      pose,
      place,
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
      return `island-${String(place.slot)}`;
    case 'pause':
      return `pause-${String(place.seat)}`;
    default:
      return place.kind;
  }
}
