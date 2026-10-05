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
export function fitView(nodes: readonly SimNode[], width: number, height: number, pad = 60): View {
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
