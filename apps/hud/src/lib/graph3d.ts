import { BARNES_HUT_FROM, createSimulation, DEFAULT_PARAMS, type SimLink, type SimParams } from './graph.ts';

/**
 * The 3D view of the "Conoscenza" page (D-104): the same force simulation
 * as graph.ts with a third axis (an octree instead of the quadtree above
 * BARNES_HUT_FROM nodes), an orbital camera and a perspective projection on
 * a 2D <canvas>. Pure: the component draws and feeds the pointer in.
 */

export interface SimNode3 {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Radius in world units, from the degree (as in 2D). */
  r: number;
}

export interface Simulation3 {
  nodes: SimNode3[];
  links: SimLink[];
  alpha: number;
  alphaTarget: number;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * A 3D simulation for these nodes and edges: positions kept from `previous`
 * (a reload of the graph), the others on a spiral of growing spheres, so the
 * start is the same at every load. Links and radii are those of the 2D
 * simulation: same distances, same strengths.
 */
export function createSimulation3(
  nodes: readonly { id: string; degree: number }[],
  edges: readonly { source: string; target: string }[],
  previous?: ReadonlyMap<string, Point3>,
  params: SimParams = DEFAULT_PARAMS,
): Simulation3 {
  const flat = createSimulation(nodes, edges, undefined, params);
  const count = Math.max(1, nodes.length);
  const simNodes = nodes.map((node, i): SimNode3 => {
    const stored = previous?.get(node.id);
    // A position is kept only when it is a real point (a NaN would spread to every node).
    const kept = stored !== undefined && Number.isFinite(stored.x) && Number.isFinite(stored.y) && Number.isFinite(stored.z) ? stored : undefined;
    const shell = 12 * Math.cbrt(i + 0.5);
    const y = 1 - (2 * (i + 0.5)) / count;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    return {
      x: kept?.x ?? shell * ring * Math.cos(i * GOLDEN),
      y: kept?.y ?? shell * y,
      z: kept?.z ?? shell * ring * Math.sin(i * GOLDEN),
      vx: 0,
      vy: 0,
      vz: 0,
      r: flat.nodes[i]?.r ?? 4,
    };
  });
  return { nodes: simNodes, links: flat.links, alpha: previous !== undefined && previous.size > 0 ? 0.3 : 1, alphaTarget: 0 };
}

interface Oct {
  x0: number;
  y0: number;
  z0: number;
  size: number;
  mass: number;
  cx: number;
  cy: number;
  cz: number;
  /** A single body in a leaf; -1 for an inner cell or an empty one. */
  body: number;
  /** Bodies stacked on the same point beyond the depth limit: made only when that happens (rare). */
  extra: number[] | undefined;
  children: (Oct | undefined)[] | undefined;
}

function newOct(x0: number, y0: number, z0: number, size: number): Oct {
  return { x0, y0, z0, size, mass: 0, cx: 0, cy: 0, cz: 0, body: -1, extra: undefined, children: undefined };
}

function insert(oct: Oct, nodes: readonly SimNode3[], i: number, depth: number): void {
  if (oct.children === undefined) {
    if (oct.body < 0 && oct.extra === undefined) {
      oct.body = i;
      return;
    }
    if (depth > 24) {
      (oct.extra ??= []).push(i);
      return;
    }
    const old = oct.body;
    oct.body = -1;
    oct.children = new Array<Oct | undefined>(8).fill(undefined);
    if (old >= 0) insertChild(oct, nodes, old, depth);
  }
  insertChild(oct, nodes, i, depth);
}

function insertChild(oct: Oct, nodes: readonly SimNode3[], i: number, depth: number): void {
  const node = nodes[i];
  if (node === undefined || oct.children === undefined) return;
  const half = oct.size / 2;
  const right = node.x >= oct.x0 + half ? 1 : 0;
  const bottom = node.y >= oct.y0 + half ? 1 : 0;
  const back = node.z >= oct.z0 + half ? 1 : 0;
  const slot = back * 4 + bottom * 2 + right;
  let child = oct.children[slot];
  if (child === undefined) {
    child = newOct(oct.x0 + right * half, oct.y0 + bottom * half, oct.z0 + back * half, half);
    oct.children[slot] = child;
  }
  insert(child, nodes, i, depth + 1);
}

function accumulate(oct: Oct, nodes: readonly SimNode3[]): void {
  let mass = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  if (oct.children === undefined) {
    const first = nodes[oct.body];
    if (first !== undefined) {
      mass += 1;
      cx += first.x;
      cy += first.y;
      cz += first.z;
    }
    if (oct.extra !== undefined) {
      for (const j of oct.extra) {
        const node = nodes[j];
        if (node === undefined) continue;
        mass += 1;
        cx += node.x;
        cy += node.y;
        cz += node.z;
      }
    }
  } else {
    for (const child of oct.children) {
      if (child === undefined) continue;
      accumulate(child, nodes);
      if (child.mass === 0) continue;
      mass += child.mass;
      cx += child.cx * child.mass;
      cy += child.cy * child.mass;
      cz += child.cz * child.mass;
    }
  }
  oct.mass = mass;
  oct.cx = mass > 0 ? cx / mass : 0;
  oct.cy = mass > 0 ? cy / mass : 0;
  oct.cz = mass > 0 ? cz / mass : 0;
}

/** The octree of the positions, with the mass and centre of every cell. */
export function buildOctree(nodes: readonly SimNode3[]): Oct | undefined {
  if (nodes.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const node of nodes) {
    x0 = Math.min(x0, node.x);
    y0 = Math.min(y0, node.y);
    z0 = Math.min(z0, node.z);
    x1 = Math.max(x1, node.x);
    y1 = Math.max(y1, node.y);
    z1 = Math.max(z1, node.z);
  }
  const size = Math.max(x1 - x0, y1 - y0, z1 - z0, 1) * 1.0001;
  const root = newOct(x0, y0, z0, size);
  for (let i = 0; i < nodes.length; i += 1) insert(root, nodes, i, 0);
  accumulate(root, nodes);
  return root;
}

/** A tiny deterministic push for two nodes on the same point. */
function jiggle(i: number): number {
  return ((i * 9301 + 49297) % 233280) / 233280 / 1e3 - 0.5e-3;
}

/** Adds to `out` the push node i (at `node`) gets from `mass` bodies at (x, y, z). No closure, no allocation. */
function addPush(out: Point3, i: number, node: SimNode3, x: number, y: number, z: number, mass: number, chargeAlpha: number): void {
  let dx = x - node.x;
  let dy = y - node.y;
  let dz = z - node.z;
  if (dx === 0) dx = jiggle(i);
  if (dy === 0) dy = jiggle(i + 1);
  if (dz === 0) dz = jiggle(i + 2);
  const f = (chargeAlpha * mass) / Math.max(dx * dx + dy * dy + dz * dz, 1);
  out.x += dx * f;
  out.y += dy * f;
  out.z += dz * f;
}

/**
 * The walk of the octree, reused by every node of every tick: the module is
 * single-threaded and the walk is not re-entrant, so one stack is enough.
 */
const walk: Oct[] = [];

/** As repulsion3On, into `out` (set to zero first): what step3 uses, without allocating. */
export function repulsion3Into(out: Point3, i: number, nodes: readonly SimNode3[], tree: Oct | undefined, charge: number, alpha: number, theta: number): Point3 {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  const node = nodes[i];
  if (node === undefined) return out;
  const ca = charge * alpha;
  if (tree === undefined) {
    for (let j = 0; j < nodes.length; j += 1) {
      const other = nodes[j];
      if (j !== i && other !== undefined) addPush(out, i, node, other.x, other.y, other.z, 1, ca);
    }
    return out;
  }
  walk.length = 0;
  walk.push(tree);
  for (let oct = walk.pop(); oct !== undefined; oct = walk.pop()) {
    if (oct.mass === 0) continue;
    if (oct.children === undefined) {
      const first = nodes[oct.body];
      if (oct.body !== i && first !== undefined) addPush(out, i, node, first.x, first.y, first.z, 1, ca);
      if (oct.extra !== undefined) {
        for (const j of oct.extra) {
          const other = nodes[j];
          if (j !== i && other !== undefined) addPush(out, i, node, other.x, other.y, other.z, 1, ca);
        }
      }
      continue;
    }
    const distance = Math.hypot(oct.cx - node.x, oct.cy - node.y, oct.cz - node.z);
    if (distance > 0 && oct.size / distance < theta) addPush(out, i, node, oct.cx, oct.cy, oct.cz, oct.mass, ca);
    else for (const child of oct.children) if (child !== undefined) walk.push(child);
  }
  return out;
}

/**
 * The velocity change repulsion gives node i, as in 2D (`charge` per body,
 * over the squared distance); with a tree, cells seen under `theta` count as
 * one body at their centre of mass.
 */
export function repulsion3On(i: number, nodes: readonly SimNode3[], tree: Oct | undefined, charge: number, alpha: number, theta: number): Point3 {
  return repulsion3Into({ x: 0, y: 0, z: 0 }, i, nodes, tree, charge, alpha, theta);
}

/**
 * Scratch buffers of step3, kept at module level and grown when a bigger
 * graph comes: no allocation per tick below BARNES_HUT_FROM nodes. They hold
 * nothing between ticks, so sharing them between simulations is safe as long
 * as ticks do not interleave (JavaScript runs one at a time).
 */
let pushX = new Float64Array(0);
let pushY = new Float64Array(0);
let pushZ = new Float64Array(0);
const push: Point3 = { x: 0, y: 0, z: 0 };

/** One tick: springs, repulsion, gravity, then positions; returns the new alpha. */
export function step3(sim: Simulation3, params: SimParams = DEFAULT_PARAMS): number {
  sim.alpha += (sim.alphaTarget - sim.alpha) * params.alphaDecay;
  const { alpha, nodes } = sim;
  for (const link of sim.links) {
    const a = nodes[link.source];
    const b = nodes[link.target];
    if (a === undefined || b === undefined) continue;
    let dx = b.x + b.vx - a.x - a.vx;
    let dy = b.y + b.vy - a.y - a.vy;
    let dz = b.z + b.vz - a.z - a.vz;
    if (dx === 0) dx = jiggle(link.source);
    if (dy === 0) dy = jiggle(link.target);
    if (dz === 0) dz = jiggle(link.edge);
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const k = ((l - link.distance) / l) * alpha * link.strength;
    dx *= k;
    dy *= k;
    dz *= k;
    b.vx -= dx * link.bias;
    b.vy -= dy * link.bias;
    b.vz -= dz * link.bias;
    a.vx += dx * (1 - link.bias);
    a.vy += dy * (1 - link.bias);
    a.vz += dz * (1 - link.bias);
  }
  const n = nodes.length;
  if (pushX.length < n) {
    pushX = new Float64Array(n);
    pushY = new Float64Array(n);
    pushZ = new Float64Array(n);
  }
  pushX.fill(0, 0, n);
  pushY.fill(0, 0, n);
  pushZ.fill(0, 0, n);
  if (n > BARNES_HUT_FROM) {
    const tree = buildOctree(nodes);
    for (let i = 0; i < n; i += 1) {
      repulsion3Into(push, i, nodes, tree, params.charge, alpha, params.theta);
      pushX[i] = push.x;
      pushY[i] = push.y;
      pushZ[i] = push.z;
    }
  } else {
    // Every pair once: the same force, opposite signs.
    const c = params.charge * alpha;
    for (let i = 0; i < n; i += 1) {
      const a = nodes[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < n; j += 1) {
        const b = nodes[j];
        if (b === undefined) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dz = b.z - a.z;
        if (dx === 0) dx = jiggle(i);
        if (dy === 0) dy = jiggle(i + 1);
        if (dz === 0) dz = jiggle(i + 2);
        const f = c / Math.max(dx * dx + dy * dy + dz * dz, 1);
        pushX[i] = (pushX[i] ?? 0) + dx * f;
        pushY[i] = (pushY[i] ?? 0) + dy * f;
        pushZ[i] = (pushZ[i] ?? 0) + dz * f;
        pushX[j] = (pushX[j] ?? 0) - dx * f;
        pushY[j] = (pushY[j] ?? 0) - dy * f;
        pushZ[j] = (pushZ[j] ?? 0) - dz * f;
      }
    }
  }
  const keep = 1 - params.velocityDecay;
  const pull = params.gravity * alpha;
  for (let i = 0; i < n; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    node.vx = (node.vx + (pushX[i] ?? 0) - node.x * pull) * keep;
    node.vy = (node.vy + (pushY[i] ?? 0) - node.y * pull) * keep;
    node.vz = (node.vz + (pushZ[i] ?? 0) - node.z * pull) * keep;
    node.x += node.vx;
    node.y += node.vy;
    node.z += node.vz;
  }
  return sim.alpha;
}

export function isSettled3(sim: Simulation3, params: SimParams = DEFAULT_PARAMS): boolean {
  return sim.alpha < params.alphaMin && sim.alphaTarget === 0;
}

// The camera.

/**
 * An orbital camera: it looks at `target` from `distance` world units away,
 * turned by `yaw` around the vertical axis and tilted by `pitch` (negative:
 * from above, as world y grows downwards like the screen's).
 */
export interface Camera {
  target: Point3;
  yaw: number;
  pitch: number;
  distance: number;
}

export const FOV = (55 * Math.PI) / 180;
/** The camera never comes closer to its target than this, so the target stays whole and clickable. */
export const MIN_DISTANCE = 80;
export const MAX_DISTANCE = 12_000;
/** Points closer to the camera than this (world units) are not drawn. */
export const NEAR = 20;
/**
 * Between NEAR and NEAR_FADE a node fades to nothing and cannot be clicked:
 * a node grazing the camera would otherwise be a huge disc stealing clicks.
 */
export const NEAR_FADE = 60;
/** The largest radius of a node on the screen, in pixels. */
export const MAX_NODE_PX = 40;
export const MAX_PITCH = 1.45;

/** The camera and the screen, with the sines and cosines worked out once per frame. */
export interface Projector {
  tx: number;
  ty: number;
  tz: number;
  cosYaw: number;
  sinYaw: number;
  cosPitch: number;
  sinPitch: number;
  distance: number;
  /** Screen pixels per world unit at depth 1. */
  focal: number;
  cx: number;
  cy: number;
}

/** The projector for this camera on a width × height screen whose centre is moved by `shiftX` pixels. */
export function makeProjector(camera: Camera, width: number, height: number, shiftX = 0): Projector {
  const p: Projector = { tx: 0, ty: 0, tz: 0, cosYaw: 1, sinYaw: 0, cosPitch: 1, sinPitch: 0, distance: 1, focal: 1, cx: 0, cy: 0 };
  return updateProjector(p, camera, width, height, shiftX);
}

/** As makeProjector, into an existing projector: once per frame without allocating. */
export function updateProjector(p: Projector, camera: Camera, width: number, height: number, shiftX = 0): Projector {
  p.tx = camera.target.x;
  p.ty = camera.target.y;
  p.tz = camera.target.z;
  p.cosYaw = Math.cos(camera.yaw);
  p.sinYaw = Math.sin(camera.yaw);
  p.cosPitch = Math.cos(camera.pitch);
  p.sinPitch = Math.sin(camera.pitch);
  p.distance = camera.distance;
  p.focal = Math.max(1, height) / 2 / Math.tan(FOV / 2);
  p.cx = (width + shiftX) / 2;
  p.cy = height / 2;
  return p;
}

/** A world point turned into the camera's axes (x right, y down, z towards the camera), before the perspective. */
export function toCamera(p: Projector, x: number, y: number, z: number): Point3 {
  const dx = x - p.tx;
  const dy = y - p.ty;
  const dz = z - p.tz;
  const x1 = dx * p.cosYaw - dz * p.sinYaw;
  const z1 = dx * p.sinYaw + dz * p.cosYaw;
  return { x: x1, y: dy * p.cosPitch - z1 * p.sinPitch, z: dy * p.sinPitch + z1 * p.cosPitch };
}

/** Where a world point falls on the screen. */
export interface Projected {
  x: number;
  y: number;
  /** Screen pixels per world unit at that point (0 behind the camera). */
  scale: number;
  /** Distance from the camera along its axis; below NEAR the point is not drawn. */
  depth: number;
}

export function project(p: Projector, x: number, y: number, z: number): Projected {
  return projectInto({ x: 0, y: 0, scale: 0, depth: 0 }, p, x, y, z);
}

/** As project, into `out`: for the points drawn every frame. */
export function projectInto(out: Projected, p: Projector, x: number, y: number, z: number): Projected {
  const dx = x - p.tx;
  const dy = y - p.ty;
  const dz = z - p.tz;
  const x1 = dx * p.cosYaw - dz * p.sinYaw;
  const z1 = dx * p.sinYaw + dz * p.cosYaw;
  const y2 = dy * p.cosPitch - z1 * p.sinPitch;
  const depth = p.distance - (dy * p.sinPitch + z1 * p.cosPitch);
  out.depth = depth;
  if (depth < NEAR) {
    out.x = p.cx;
    out.y = p.cy;
    out.scale = 0;
    return out;
  }
  out.scale = p.focal / depth;
  out.x = p.cx + x1 * out.scale;
  out.y = p.cy + y2 * out.scale;
  return out;
}

/** The depth of a world point from the camera, without the perspective. */
function depthOf(p: Projector, x: number, y: number, z: number): number {
  const dx = x - p.tx;
  const dz = z - p.tz;
  const z1 = dx * p.sinYaw + dz * p.cosYaw;
  return p.distance - ((y - p.ty) * p.sinPitch + z1 * p.cosPitch);
}

/** A segment on the screen. */
export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const segmentEnd: Projected = { x: 0, y: 0, scale: 0, depth: 0 };

/**
 * The world segment a-b on the screen, cut where it passes the NEAR plane;
 * false when it is all behind it. Into `out`, without allocating.
 */
export function projectSegment(p: Projector, ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: Segment): boolean {
  const da = depthOf(p, ax, ay, az);
  const db = depthOf(p, bx, by, bz);
  if (da < NEAR && db < NEAR) return false;
  let sx = ax;
  let sy = ay;
  let sz = az;
  let ex = bx;
  let ey = by;
  let ez = bz;
  // The depth is linear along the segment: cut the hidden end at NEAR.
  if (da < NEAR) {
    const t = (NEAR - da) / (db - da);
    sx = ax + (bx - ax) * t;
    sy = ay + (by - ay) * t;
    sz = az + (bz - az) * t;
  } else if (db < NEAR) {
    const t = (NEAR - db) / (da - db);
    ex = bx + (ax - bx) * t;
    ey = by + (ay - by) * t;
    ez = bz + (az - bz) * t;
  }
  projectInto(segmentEnd, p, sx, sy, sz);
  out.x0 = segmentEnd.x;
  out.y0 = segmentEnd.y;
  projectInto(segmentEnd, p, ex, ey, ez);
  out.x1 = segmentEnd.x;
  out.y1 = segmentEnd.y;
  return true;
}

/** How much of a node shows at this depth: 0 up to NEAR, 1 from NEAR_FADE on. */
export function nearFade(depth: number): number {
  return Math.max(0, Math.min(1, (depth - NEAR) / (NEAR_FADE - NEAR)));
}

/** The screen positions of all the nodes into reused arrays, without allocating. */
export interface ProjectedNodes {
  x: Float64Array;
  y: Float64Array;
  /** Radius on the screen in pixels; 0 behind the camera. */
  r: Float64Array;
  depth: Float64Array;
}

export function emptyProjection(count: number): ProjectedNodes {
  return { x: new Float64Array(count), y: new Float64Array(count), r: new Float64Array(count), depth: new Float64Array(count) };
}

export function projectNodes(p: Projector, nodes: readonly { x: number; y: number; z: number; r: number }[], out: ProjectedNodes): void {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const dx = node.x - p.tx;
    const dy = node.y - p.ty;
    const dz = node.z - p.tz;
    const x1 = dx * p.cosYaw - dz * p.sinYaw;
    const z1 = dx * p.sinYaw + dz * p.cosYaw;
    const y2 = dy * p.cosPitch - z1 * p.sinPitch;
    const z2 = dy * p.sinPitch + z1 * p.cosPitch;
    const depth = p.distance - z2;
    out.depth[i] = depth;
    if (depth < NEAR) {
      out.x[i] = p.cx;
      out.y[i] = p.cy;
      out.r[i] = 0;
      continue;
    }
    const scale = p.focal / depth;
    out.x[i] = p.cx + x1 * scale;
    out.y[i] = p.cy + y2 * scale;
    out.r[i] = Math.min(MAX_NODE_PX, node.r * scale);
  }
}

/**
 * The indices from the farthest to the nearest, for painting in order; into
 * `order` when it has the right length (no allocation per frame).
 */
export function depthOrder(depth: ArrayLike<number>, count: number, order?: Uint32Array): Uint32Array {
  const out = order !== undefined && order.length === count ? order : new Uint32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = i;
  return out.sort((a, b) => (depth[b] ?? 0) - (depth[a] ?? 0));
}

/**
 * The node under a screen point: among those whose projected circle, widened
 * by `slack` pixels, contains it, the nearest to the camera; -1 for none.
 * Nodes closer than NEAR_FADE (fading, or behind the camera) and those
 * `skip` says no to are ignored.
 */
export function hitTest3(projected: ProjectedNodes, count: number, sx: number, sy: number, slack = 0, skip?: (i: number) => boolean): number {
  let found = -1;
  let best = Infinity;
  for (let i = 0; i < count; i += 1) {
    const r = projected.r[i] ?? 0;
    const depth = projected.depth[i] ?? 0;
    if (r <= 0 || depth < NEAR_FADE || depth >= best) continue;
    if (skip?.(i) === true) continue;
    const dx = (projected.x[i] ?? 0) - sx;
    const dy = (projected.y[i] ?? 0) - sy;
    const reach = Math.max(r, 2) + slack;
    if (dx * dx + dy * dy <= reach * reach) {
      best = depth;
      found = i;
    }
  }
  return found;
}

/**
 * The fog: full opacity at `front` (the nearest edge of the graph), down to
 * `min` at `back` (the farthest).
 */
export function fogAlpha(depth: number, front: number, back: number, min = 0.14): number {
  if (!(back > front)) return 1;
  const t = Math.max(0, Math.min(1, (depth - front) / (back - front)));
  return 1 - t * (1 - min);
}

/** The centre of the nodes and the radius of the sphere around them (at least 40). */
export function boundingSphere(nodes: readonly { x: number; y: number; z: number; r: number }[]): { center: Point3; radius: number } {
  if (nodes.length === 0) return { center: { x: 0, y: 0, z: 0 }, radius: 40 };
  let x = 0;
  let y = 0;
  let z = 0;
  for (const node of nodes) {
    x += node.x;
    y += node.y;
    z += node.z;
  }
  const center = { x: x / nodes.length, y: y / nodes.length, z: z / nodes.length };
  let radius = 40;
  for (const node of nodes) radius = Math.max(radius, Math.hypot(node.x - center.x, node.y - center.y, node.z - center.z) + node.r);
  return { center, radius };
}

/** The distance at which a sphere of this radius fills the narrower side of the screen, with a margin. */
export function fitDistance(radius: number, width: number, height: number, margin = 1.08): number {
  const aspect = height > 0 ? width / height : 1;
  const half = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * Math.max(0.2, aspect)));
  return clampDistance((Math.max(1, radius) / Math.sin(half)) * margin);
}

export function clampDistance(distance: number): number {
  return Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, distance));
}

/** The camera that shows every node, keeping the angle it has. */
export function fitCamera(camera: Camera, nodes: readonly { x: number; y: number; z: number; r: number }[], width: number, height: number): Camera {
  const sphere = boundingSphere(nodes);
  return { ...camera, target: sphere.center, distance: fitDistance(sphere.radius, width, height) };
}

/** The camera turned by a drag of (dx, dy) pixels: the side of the graph facing the camera follows the pointer. */
export function orbitBy(camera: Camera, dx: number, dy: number, speed = 0.006): Camera {
  return { ...camera, yaw: wrapAngle(camera.yaw - dx * speed), pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, camera.pitch - dy * speed)) };
}

/** Closer by `factor` (> 1), farther below 1, within the limits. */
export function zoomCamera(camera: Camera, factor: number): Camera {
  return factor > 0 ? { ...camera, distance: clampDistance(camera.distance / factor) } : camera;
}

/** An angle within [-π, π). */
export function wrapAngle(angle: number): number {
  const turn = Math.PI * 2;
  const a = (((angle + Math.PI) % turn) + turn) % turn;
  return a - Math.PI;
}

/** A copy that shares nothing with the original. */
export function copyCamera(camera: Camera): Camera {
  return { target: { ...camera.target }, yaw: camera.yaw, pitch: camera.pitch, distance: camera.distance };
}

/**
 * A step of the flight from one camera to another (0 ≤ t ≤ 1, eased); the
 * yaw turns the short way round. Into `out` when given (it may be `from`
 * itself): no allocation per frame.
 */
export function blendCamera(from: Camera, to: Camera, t: number, out?: Camera): Camera {
  const e = t >= 1 ? 1 : 1 - Math.pow(1 - Math.max(0, t), 3);
  // Everything read before anything is written: `out` may be `from`.
  const x = from.target.x + (to.target.x - from.target.x) * e;
  const y = from.target.y + (to.target.y - from.target.y) * e;
  const z = from.target.z + (to.target.z - from.target.z) * e;
  const yaw = wrapAngle(from.yaw + wrapAngle(to.yaw - from.yaw) * e);
  const pitch = from.pitch + (to.pitch - from.pitch) * e;
  // The distance in log space: the flight feels even from far and from near.
  const distance = Math.exp(Math.log(from.distance) + (Math.log(to.distance) - Math.log(from.distance)) * e);
  if (out === undefined) return { target: { x, y, z }, yaw, pitch, distance };
  out.target.x = x;
  out.target.y = y;
  out.target.z = z;
  out.yaw = yaw;
  out.pitch = pitch;
  out.distance = distance;
  return out;
}

/** The camera after flying to a node: looking at it from close by, the angle unchanged. */
export function flyTarget(camera: Camera, node: { x: number; y: number; z: number; r: number }): Camera {
  return { ...camera, target: { x: node.x, y: node.y, z: node.z }, distance: clampDistance(Math.max(140, node.r * 14)) };
}

/** Radians per second of the slow drift when nobody touches the graph: a turn in two and a half minutes. */
export const DRIFT_SPEED = (Math.PI * 2) / 150;
/** Milliseconds without interaction before the drift starts, and the time it takes to reach full speed. */
export const DRIFT_IDLE_MS = 2_500;
export const DRIFT_RAMP_MS = 2_000;

/** How much of the drift applies after `idle` ms without interaction: 0, then up to 1. */
export function driftWeight(idle: number): number {
  return Math.max(0, Math.min(1, (idle - DRIFT_IDLE_MS) / DRIFT_RAMP_MS));
}

/** The yaw after `dt` ms of drift at this weight; a long pause counts as one frame. */
export function driftYaw(yaw: number, dt: number, weight: number): number {
  if (weight <= 0) return yaw;
  return wrapAngle(yaw + (Math.max(0, Math.min(dt, 100)) / 1000) * DRIFT_SPEED * Math.min(1, weight));
}

/** The view the page shows: remembered in this browser, 2D unless 3D was chosen. */
export function readViewMode(stored: string | null | undefined): '2d' | '3d' {
  return stored === '3d' ? '3d' : '2d';
}
