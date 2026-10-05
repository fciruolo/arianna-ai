import type { Label } from './types.ts';

/**
 * The force graph of the "Conoscenza" page (D-087), written here without
 * libraries: a simulation in the manner of d3-force (repulsion between all
 * nodes, Barnes-Hut above BARNES_HUT_FROM nodes; springs on the edges;
 * gravity to the centre; cooling), hit testing and the zoom transform. Pure:
 * the component draws on a <canvas> and feeds the pointer in.
 */

export interface GraphNodeData {
  id: string;
  title: string;
  folder: string;
  kind: string | null;
  tags: string[];
  label: Label;
  degree: number;
  updatedAt: string | null;
}

export interface GraphEdgeData {
  source: string;
  target: string;
  type: 'link' | 'tag';
}

export interface GraphData {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  hidden: number;
  truncated: boolean;
}

/** A page with its text, as the side panel shows it. */
export interface KnowledgePage {
  id: string;
  title: string;
  folder: string;
  kind: string | null;
  tags: string[];
  label: Label;
  updatedAt: string;
  body: string;
}

export interface SimNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radius in world units, from the degree. */
  r: number;
  /** Held by the pointer: the simulation does not move it. */
  fixed: boolean;
}

export interface SimLink {
  source: number;
  target: number;
  /** Index of the edge in the list given to createSimulation. */
  edge: number;
  /** Share of the correction the target takes (the less connected end moves more). */
  bias: number;
  strength: number;
  distance: number;
}

export interface Simulation {
  nodes: SimNode[];
  links: SimLink[];
  alpha: number;
  alphaTarget: number;
}

export interface SimParams {
  /** Negative: nodes push each other away. */
  charge: number;
  linkDistance: number;
  gravity: number;
  velocityDecay: number;
  alphaDecay: number;
  alphaMin: number;
  theta: number;
}

export const DEFAULT_PARAMS: SimParams = {
  charge: -70,
  linkDistance: 46,
  gravity: 0.045,
  velocityDecay: 0.4,
  // From 1 to alphaMin in about 300 steps, as d3 does.
  alphaDecay: 1 - Math.pow(0.001, 1 / 300),
  alphaMin: 0.001,
  theta: 0.9,
};

/** Above this many nodes the repulsion is approximated with a quadtree. */
export const BARNES_HUT_FROM = 500;

export function radiusFor(degree: number): number {
  return Math.min(18, 3.5 + Math.sqrt(Math.max(0, degree)) * 2.2);
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * A simulation for these nodes and edges: positions kept from `previous` (a
 * reload of the graph), the others on a spiral, so the start is the same at
 * every load. Edges whose ends are missing are dropped.
 */
export function createSimulation(
  nodes: readonly { id: string; degree: number }[],
  edges: readonly { source: string; target: string }[],
  previous?: ReadonlyMap<string, { x: number; y: number }>,
  params: SimParams = DEFAULT_PARAMS,
): Simulation {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const simNodes: SimNode[] = nodes.map((node, i) => {
    const kept = previous?.get(node.id);
    const radius = 10 * Math.sqrt(i + 0.5);
    return {
      x: kept?.x ?? radius * Math.cos(i * GOLDEN),
      y: kept?.y ?? radius * Math.sin(i * GOLDEN),
      vx: 0,
      vy: 0,
      r: radiusFor(node.degree),
      fixed: false,
    };
  });
  const count = new Array<number>(nodes.length).fill(0);
  const pairs: [number, number, number][] = [];
  for (const [at, edge] of edges.entries()) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined || source === target) continue;
    pairs.push([source, target, at]);
    count[source] = (count[source] ?? 0) + 1;
    count[target] = (count[target] ?? 0) + 1;
  }
  const links = pairs.map(([source, target, edge]) => {
    const cs = count[source] ?? 1;
    const ct = count[target] ?? 1;
    const a = simNodes[source];
    const b = simNodes[target];
    return {
      source,
      target,
      edge,
      bias: cs / (cs + ct),
      strength: 1 / Math.min(cs, ct),
      distance: params.linkDistance + (a?.r ?? 0) + (b?.r ?? 0),
    };
  });
  return { nodes: simNodes, links, alpha: previous !== undefined && previous.size > 0 ? 0.3 : 1, alphaTarget: 0 };
}

interface Quad {
  x0: number;
  y0: number;
  size: number;
  mass: number;
  cx: number;
  cy: number;
  /** A single body in a leaf; -1 for an inner quad or an empty one. */
  body: number;
  /** Bodies stacked on the same point beyond the depth limit. */
  extra: number[];
  children: (Quad | undefined)[] | undefined;
}

function newQuad(x0: number, y0: number, size: number): Quad {
  return { x0, y0, size, mass: 0, cx: 0, cy: 0, body: -1, extra: [], children: undefined };
}

function insert(quad: Quad, nodes: readonly SimNode[], i: number, depth: number): void {
  const node = nodes[i];
  if (node === undefined) return;
  if (quad.children === undefined) {
    if (quad.body < 0 && quad.extra.length === 0) {
      quad.body = i;
      return;
    }
    if (depth > 24) {
      quad.extra.push(i);
      return;
    }
    const old = quad.body;
    quad.body = -1;
    quad.children = [undefined, undefined, undefined, undefined];
    if (old >= 0) insertChild(quad, nodes, old, depth);
  }
  insertChild(quad, nodes, i, depth);
}

function insertChild(quad: Quad, nodes: readonly SimNode[], i: number, depth: number): void {
  const node = nodes[i];
  if (node === undefined || quad.children === undefined) return;
  const half = quad.size / 2;
  const right = node.x >= quad.x0 + half ? 1 : 0;
  const bottom = node.y >= quad.y0 + half ? 1 : 0;
  const slot = bottom * 2 + right;
  let child = quad.children[slot];
  if (child === undefined) {
    child = newQuad(quad.x0 + right * half, quad.y0 + bottom * half, half);
    quad.children[slot] = child;
  }
  insert(child, nodes, i, depth + 1);
}

function accumulate(quad: Quad, nodes: readonly SimNode[]): void {
  let mass = 0;
  let cx = 0;
  let cy = 0;
  const add = (x: number, y: number, m: number) => {
    mass += m;
    cx += x * m;
    cy += y * m;
  };
  if (quad.children === undefined) {
    for (const i of quad.body >= 0 ? [quad.body, ...quad.extra] : quad.extra) {
      const node = nodes[i];
      if (node !== undefined) add(node.x, node.y, 1);
    }
  } else {
    for (const child of quad.children) {
      if (child === undefined) continue;
      accumulate(child, nodes);
      if (child.mass > 0) add(child.cx, child.cy, child.mass);
    }
  }
  quad.mass = mass;
  quad.cx = mass > 0 ? cx / mass : 0;
  quad.cy = mass > 0 ? cy / mass : 0;
}

/** The quadtree of the positions, with the mass and centre of every quad. */
export function buildQuadtree(nodes: readonly SimNode[]): Quad | undefined {
  if (nodes.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const node of nodes) {
    x0 = Math.min(x0, node.x);
    y0 = Math.min(y0, node.y);
    x1 = Math.max(x1, node.x);
    y1 = Math.max(y1, node.y);
  }
  const size = Math.max(x1 - x0, y1 - y0, 1) * 1.0001;
  const root = newQuad(x0, y0, size);
  for (let i = 0; i < nodes.length; i += 1) insert(root, nodes, i, 0);
  accumulate(root, nodes);
  return root;
}

/** A tiny deterministic push for two nodes on the same point. */
function jiggle(i: number): number {
  return ((i * 9301 + 49297) % 233280) / 233280 / 1e3 - 0.5e-3;
}

/** The velocity change repulsion gives node i: `charge` per body, approximated beyond `theta`. */
export function repulsionOn(i: number, nodes: readonly SimNode[], tree: Quad | undefined, charge: number, alpha: number, theta: number): { vx: number; vy: number } {
  const node = nodes[i];
  let vx = 0;
  let vy = 0;
  if (node === undefined) return { vx, vy };
  const apply = (x: number, y: number, mass: number) => {
    let dx = x - node.x;
    let dy = y - node.y;
    if (dx === 0) dx = jiggle(i);
    if (dy === 0) dy = jiggle(i + 1);
    const l2 = Math.max(dx * dx + dy * dy, 1);
    const f = (charge * mass * alpha) / l2;
    vx += dx * f;
    vy += dy * f;
  };
  if (tree === undefined) {
    for (let j = 0; j < nodes.length; j += 1) {
      const other = nodes[j];
      if (j !== i && other !== undefined) apply(other.x, other.y, 1);
    }
    return { vx, vy };
  }
  const stack: Quad[] = [tree];
  while (stack.length > 0) {
    const quad = stack.pop();
    if (quad === undefined || quad.mass === 0) continue;
    const dx = quad.cx - node.x;
    const dy = quad.cy - node.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (quad.children === undefined) {
      for (const j of quad.body >= 0 ? [quad.body, ...quad.extra] : quad.extra) {
        const other = nodes[j];
        if (j !== i && other !== undefined) apply(other.x, other.y, 1);
      }
    } else if (distance > 0 && quad.size / distance < theta) {
      apply(quad.cx, quad.cy, quad.mass);
    } else {
      for (const child of quad.children) if (child !== undefined) stack.push(child);
    }
  }
  return { vx, vy };
}

/** One tick: forces, then positions; returns the new alpha. */
export function step(sim: Simulation, params: SimParams = DEFAULT_PARAMS): number {
  sim.alpha += (sim.alphaTarget - sim.alpha) * params.alphaDecay;
  const { alpha } = sim;
  const { nodes } = sim;
  for (const link of sim.links) {
    const a = nodes[link.source];
    const b = nodes[link.target];
    if (a === undefined || b === undefined) continue;
    let dx = b.x + b.vx - a.x - a.vx;
    let dy = b.y + b.vy - a.y - a.vy;
    if (dx === 0) dx = jiggle(link.source);
    if (dy === 0) dy = jiggle(link.target);
    const l = Math.sqrt(dx * dx + dy * dy);
    const k = ((l - link.distance) / l) * alpha * link.strength;
    dx *= k;
    dy *= k;
    b.vx -= dx * link.bias;
    b.vy -= dy * link.bias;
    a.vx += dx * (1 - link.bias);
    a.vy += dy * (1 - link.bias);
  }
  const tree = nodes.length > BARNES_HUT_FROM ? buildQuadtree(nodes) : undefined;
  const pushes = nodes.map((_, i) => repulsionOn(i, nodes, tree, params.charge, alpha, params.theta));
  nodes.forEach((node, i) => {
    const push = pushes[i];
    node.vx += (push?.vx ?? 0) - node.x * params.gravity * alpha;
    node.vy += (push?.vy ?? 0) - node.y * params.gravity * alpha;
    if (node.fixed) {
      node.vx = 0;
      node.vy = 0;
      return;
    }
    node.vx *= 1 - params.velocityDecay;
    node.vy *= 1 - params.velocityDecay;
    node.x += node.vx;
    node.y += node.vy;
  });
  return sim.alpha;
}

export function isSettled(sim: Simulation, params: SimParams = DEFAULT_PARAMS): boolean {
  return sim.alpha < params.alphaMin && sim.alphaTarget === 0;
}

/** Warms the simulation again (a node dragged, a graph reloaded). */
export function reheat(sim: Simulation, alpha = 0.3): void {
  sim.alpha = Math.max(sim.alpha, alpha);
}

/** Screen = world × k + (x, y), in CSS pixels. */
export interface View {
  x: number;
  y: number;
  k: number;
}

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 6;

export function toWorld(view: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
}

export function toScreen(view: View, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * view.k + view.x, y: wy * view.k + view.y };
}

/** Zoom by `factor` keeping the world point under (sx, sy) where it is. */
export function zoomAt(view: View, sx: number, sy: number, factor: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
  const world = toWorld(view, sx, sy);
  return { k, x: sx - world.x * k, y: sy - world.y * k };
}

/** The wheel's zoom factor: smooth for trackpads, a notch for mice. */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-300, Math.min(300, pixels)) * 0.0018);
}

/** The view that shows every node inside width × height with `pad` pixels around. */
export function fitView(nodes: readonly { x: number; y: number; r: number }[], width: number, height: number, pad = 60): View {
  if (nodes.length === 0 || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, k: 1 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const node of nodes) {
    x0 = Math.min(x0, node.x - node.r);
    y0 = Math.min(y0, node.y - node.r);
    x1 = Math.max(x1, node.x + node.r);
    y1 = Math.max(y1, node.y + node.r);
  }
  const k = Math.min(2, Math.max(MIN_ZOOM, Math.min((width - 2 * pad) / Math.max(x1 - x0, 1), (height - 2 * pad) / Math.max(y1 - y0, 1))));
  return { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
}

/** The view centred on a world point at zoom k. */
export function centerOn(width: number, height: number, wx: number, wy: number, k: number): View {
  return { k, x: width / 2 - wx * k, y: height / 2 - wy * k };
}

/** Linear step from one view to another (0 ≤ t ≤ 1), for a short glide. */
export function blendView(from: View, to: View, t: number): View {
  const e = t >= 1 ? 1 : 1 - Math.pow(1 - Math.max(0, t), 3);
  return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e };
}

/**
 * The node under a world point: the closest whose circle, widened by `slack`
 * world units (a finger), contains it; -1 for none.
 */
export function nodeAt(nodes: readonly SimNode[], wx: number, wy: number, slack = 0): number {
  let found = -1;
  let best = Infinity;
  nodes.forEach((node, i) => {
    const d = Math.hypot(node.x - wx, node.y - wy);
    if (d <= node.r + slack && d < best) {
      best = d;
      found = i;
    }
  });
  return found;
}

/** The neighbours of every node, by index. */
export function neighbours(count: number, links: readonly { source: number; target: number }[]): Set<number>[] {
  const sets = Array.from({ length: count }, () => new Set<number>());
  for (const link of links) {
    sets[link.source]?.add(link.target);
    sets[link.target]?.add(link.source);
  }
  return sets;
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** True when every word of the query is in the title, a tag or the path. */
export function matchesFilter(node: Pick<GraphNodeData, 'id' | 'title' | 'tags'>, query: string): boolean {
  const words = fold(query).split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return true;
  const haystack = fold(`${node.title} ${node.tags.map((tag) => `#${tag}`).join(' ')} ${node.id}`);
  return words.every((word) => haystack.includes(word));
}

/** Lowercase, `.md` added, `kb/` dropped: as the core resolves links. */
function linkKey(target: string): string {
  let key = target.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (key.startsWith('kb/')) key = key.slice(3);
  if (!key.toLowerCase().endsWith('.md')) key += '.md';
  return key.toLowerCase();
}

/** The node a wikilink of the text points to, as the core resolves it; undefined for none. */
export function resolveWikilink(target: string, ids: readonly string[]): string | undefined {
  const clean = target.split('|')[0]?.split('#')[0]?.trim() ?? '';
  if (clean === '') return undefined;
  const key = linkKey(clean);
  const exact = ids.find((id) => id.toLowerCase() === key);
  if (exact !== undefined) return exact;
  const matches = key.includes('/')
    ? ids.filter((id) => id.toLowerCase().endsWith(`/${key}`))
    : ids.filter((id) => (id.split('/').at(-1) ?? '').toLowerCase() === key);
  return matches.length === 1 ? matches[0] : undefined;
}

export type TextPiece = { kind: 'text'; text: string } | { kind: 'wikilink'; target: string; text: string };

/** A text split around its `[[target|alias]]`: the alias (or the target) is what shows. */
export function splitWikilinks(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(/!?\[\[([^[\]\n]{1,300})\]\]/g)) {
    const start = match.index;
    if (start > at) pieces.push({ kind: 'text', text: text.slice(at, start) });
    const inner = match[1] ?? '';
    const [target = '', alias] = inner.split('|');
    pieces.push({ kind: 'wikilink', target: target.trim(), text: (alias ?? target).trim() || inner });
    at = start + match[0].length;
  }
  if (at < text.length) pieces.push({ kind: 'text', text: text.slice(at) });
  return pieces;
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` with this alpha, as rgba(); a colour it cannot read is left as it is. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return color;
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(Math.max(0, Math.min(1, alpha)))})`;
}

/** The palette slot of each folder: the usual ones fixed, the others in order of name. */
export const FOLDER_SLOTS: Readonly<Record<string, number>> = { inbox: 0, public: 1, work: 2, private: 3 };
export const PALETTE_SIZE = 6;

export function folderSlots(folders: readonly string[]): Map<string, number> {
  const slots = new Map<string, number>();
  const others = [...new Set(folders)].filter((folder) => folder !== '#' && FOLDER_SLOTS[folder] === undefined).sort();
  for (const folder of new Set(folders)) {
    if (folder === '#') continue;
    const fixed = FOLDER_SLOTS[folder];
    slots.set(folder, fixed ?? (4 + others.indexOf(folder)) % PALETTE_SIZE);
  }
  return slots;
}

/** "kb" for pages at the root, "#tag" for tag nodes, the folder otherwise. */
export function folderName(folder: string): string {
  return folder === '' ? 'kb' : folder === '#' ? 'tag' : folder;
}

// Motion of the settled graph (D-087b): pure, so the component only draws.

/** A small deterministic hash of an index, in [0, 1). */
function hashUnit(i: number, salt = 0): number {
  let h = Math.imul((i + 1) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The "breath" of node i at `time` seconds: an offset of at most `amplitude`
 * on each axis, with its own phase and pace. It is added when drawing only,
 * so the layout does not move.
 */
export function breathOffset(i: number, time: number, amplitude: number): { dx: number; dy: number } {
  const p1 = hashUnit(i, 1) * Math.PI * 2;
  const p2 = hashUnit(i, 2) * Math.PI * 2;
  const w1 = 0.55 + hashUnit(i, 3) * 0.5;
  const w2 = 0.45 + hashUnit(i, 4) * 0.5;
  return { dx: amplitude * Math.sin(time * w1 + p1), dy: amplitude * Math.sin(time * w2 + p2) };
}

/** A seeded pseudo-random generator (mulberry32): the same seed, the same sequence in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A light travelling along an edge, from `start` (ms) for `duration` ms. */
export interface Pulse {
  link: number;
  start: number;
  duration: number;
  /** True: from the target to the source. */
  reverse: boolean;
}

/** How many pulses travel at once for this many edges: a few, never a crowd. */
export function pulseBudget(linkCount: number): number {
  return linkCount <= 0 ? 0 : Math.min(7, Math.max(1, Math.ceil(linkCount / 10)));
}

/**
 * The pulses at `now`: those finished are replaced by new ones on edges not
 * in use, each after a pause, so the count stays at `max` whatever the frame
 * rate. A new pulse may start in the future: it waits.
 */
export function updatePulses(pulses: readonly Pulse[], now: number, random: () => number, linkCount: number, max = pulseBudget(linkCount)): readonly Pulse[] {
  if (linkCount <= 0 || max <= 0) return pulses.length === 0 ? pulses : [];
  // Every frame of every second: nothing over, nothing to add, nothing allocated.
  if (pulses.length === max && pulses.every((pulse) => pulse.link < linkCount && now < pulse.start + pulse.duration)) return pulses;
  const kept = pulses.filter((pulse) => pulse.link < linkCount && now < pulse.start + pulse.duration).slice(0, max);
  const used = new Set(kept.map((pulse) => pulse.link));
  while (kept.length < max) {
    let link = Math.floor(random() * linkCount);
    for (let tries = 0; tries < 4 && used.has(link) && used.size < linkCount; tries += 1) link = Math.floor(random() * linkCount);
    used.add(link);
    kept.push({ link, start: now + random() * 1800, duration: 1400 + random() * 1600, reverse: random() < 0.5 });
  }
  return kept;
}

/** Where a pulse is along its edge at `now`, from 0 to 1; undefined while it waits or once it is over. */
export function pulseProgress(pulse: Pulse, now: number): number | undefined {
  const t = (now - pulse.start) / pulse.duration;
  if (t < 0 || t > 1) return undefined;
  return pulse.reverse ? 1 - t : t;
}

/**
 * The glow of a node: the most connected ones pulse a little (up to +25 %),
 * those below 40 % of the highest degree stay still.
 */
export function hubGlow(degree: number, maxDegree: number, time: number, i: number): number {
  if (maxDegree <= 0 || degree <= 0) return 1;
  const weight = Math.max(0, Math.min(1, (degree / maxDegree - 0.4) / 0.6));
  if (weight === 0) return 1;
  return 1 + 0.25 * weight * (0.5 + 0.5 * Math.sin(time * 1.4 + hashUnit(i, 5) * Math.PI * 2));
}

export interface FrameState {
  /** The page is hidden (another tab, a minimised window). */
  hidden: boolean;
  /** The window has the focus. */
  focused: boolean;
  /** prefers-reduced-motion: nothing moves by itself. */
  reduced: boolean;
  /** The simulation is not settled, a glide or a drag is under way. */
  busy: boolean;
  /** The user did something a moment ago. */
  interacting: boolean;
}

/**
 * The least time between two drawings, in ms: 0 for every frame (60 fps),
 * 1000/30 for 30 fps, 100 for 10 fps; undefined: no drawing until something asks for one.
 */
export function frameInterval(state: FrameState): number | undefined {
  if (state.hidden) return undefined;
  if (state.busy) return 0;
  if (state.reduced) return state.interacting ? 0 : undefined;
  if (state.interacting) return 0;
  if (!state.focused) return 100;
  return 1000 / 30;
}

/** True when a drawing is due; a millisecond of slack keeps 30 fps on a 60 Hz screen. */
export function frameDue(now: number, lastDraw: number, interval: number): boolean {
  return now - lastDraw >= interval - 1;
}

/** A world point turned by `angle` radians around the origin (the centre of the graph). */
export function rotatePoint(x: number, y: number, angle: number): { x: number; y: number } {
  if (angle === 0) return { x, y };
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Radians per second of the "Orbita" view: a turn in seven minutes. */
export const ORBIT_SPEED = (Math.PI * 2) / 420;

/** The orbit angle after `dt` ms, kept within one turn; a long pause counts as one frame. */
export function advanceOrbit(angle: number, dt: number): number {
  const next = angle + (Math.max(0, Math.min(dt, 100)) / 1000) * ORBIT_SPEED;
  return next % (Math.PI * 2);
}

/** A star of the background: position in [0, 1), depth for the parallax, size and twinkle phase. */
export interface Star {
  x: number;
  y: number;
  depth: number;
  size: number;
  phase: number;
}

/** The background stars, the same at every visit for the same seed. */
export function makeStars(count: number, seed = 87): Star[] {
  const random = seededRandom(seed);
  return Array.from({ length: Math.max(0, count) }, () => {
    const depth = 0.15 + random() * 0.85;
    return { x: random(), y: random(), depth, size: depth > 0.85 ? 1.6 : depth > 0.5 ? 1.1 : 0.8, phase: random() * Math.PI * 2 };
  });
}

/** Pixels per second the nearest stars drift. */
export const STAR_DRIFT = 6;

function wrap(value: number, size: number): number {
  return size <= 0 ? 0 : ((value % size) + size) % size;
}

/**
 * A star on the screen at `time` seconds: it drifts slowly and follows the
 * view by a share of its depth (parallax); it wraps around the edges.
 */
export function starPosition(star: Star, time: number, panX: number, panY: number, width: number, height: number, parallax = 0.05): { x: number; y: number } {
  return {
    x: wrap(star.x * width + time * STAR_DRIFT * star.depth + panX * parallax * star.depth, width),
    y: wrap(star.y * height + time * STAR_DRIFT * 0.35 * star.depth + panY * parallax * star.depth, height),
  };
}

/**
 * The theme the chat shows, as style.css decides it: `data-theme` on <html>
 * when the user chose one, otherwise the system (dark unless it is light).
 */
export function themeIsDark(attribute: string | null | undefined, systemLight: boolean): boolean {
  if (attribute === 'dark') return true;
  if (attribute === 'light') return false;
  return !systemLight;
}

/**
 * The background of the "Conoscenza" page (D-087b): with the dark theme it is
 * always the black control room and there is no toggle; with the light theme
 * it follows the platform unless the user turned "Sfondo scuro" on.
 */
export function sceneMode(themeDark: boolean, darkChoice: boolean): { dark: boolean; toggle: boolean } {
  return themeDark ? { dark: true, toggle: false } : { dark: darkChoice, toggle: true };
}
