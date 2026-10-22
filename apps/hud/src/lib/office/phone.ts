import type { Pose } from '../sprites.ts';

/**
 * The office on the phone (D-293): below 48rem the plan is drawn at a whole
 * scale (crisp pixels) and scrolls sideways under a finger, the whole height
 * shown so the page keeps scrolling vertically; a tap has a wider target than
 * a click; the list under the scene puts first who needs the user. Pure
 * functions: the canvas and the page only read them.
 */

/** The width from which the office is the desktop one: the same as Tailwind's `md` (and the `phone:` variant below it). */
export const WIDE_QUERY = '(min-width: 48rem)';

/** Map pixels added around an agent's box for a finger (a coarse pointer); a mouse keeps the exact box. */
export const TOUCH_PAD = 8;

/** The scale on the phone: whole pixels, at least 1 (then the plan scrolls sideways), at most 4. */
export function compactScale(width: number, worldWidth: number): number {
  if (!(width > 0) || !(worldWidth > 0)) return 1;
  return Math.max(1, Math.min(4, Math.floor(width / worldWidth)));
}

/** The window on the phone: as wide as the page allows, as tall as the whole map (no vertical scroll inside it). */
export function compactView(width: number, worldWidth: number, worldHeight: number, scale: number): { viewW: number; viewH: number } {
  const full = worldWidth * scale;
  return { viewW: Math.max(0, Math.min(full, Math.floor(width))), viewH: worldHeight * scale };
}

/** Where an agent stands on the map: its feet, in map pixels. */
export interface AgentFoot {
  id: string;
  x: number;
  y: number;
}

/**
 * The agent under a click or a tap at (x, y), map pixels: the box of its
 * figure (16 wide, 30 tall above the feet) grown by `pad`. Without pad the
 * first hit, as the desktop has always done; with pad the closest to the
 * middle of the body, so two neighbours do not steal each other's tap.
 */
export function agentAt(agents: Iterable<AgentFoot>, x: number, y: number, pad = 0): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const agent of agents) {
    if (x < agent.x - 8 - pad || x > agent.x + 8 + pad || y < agent.y - 30 - pad || y > agent.y + pad) continue;
    if (pad <= 0) return agent.id;
    const distance = Math.hypot(x - agent.x, y - (agent.y - 15));
    if (distance < bestDistance) {
      best = agent.id;
      bestDistance = distance;
    }
  }
  return best;
}

/** First who waits for the user, then who works, then who is free, last who is paused. */
const POSE_RANK: Record<Pose, number> = { waiting: 0, working: 1, thinking: 1, reading: 1, idle: 2, paused: 3 };

/** The list under the scene on the phone: by what the agent does (stable: the same order as the page within a group). */
export function rosterOrder<T extends { pose: Pose }>(agents: readonly T[]): T[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => POSE_RANK[a.agent.pose] - POSE_RANK[b.agent.pose] || a.index - b.index)
    .map(({ agent }) => agent);
}
