import { isWalkable, TILE, type OfficeMap, type Point } from './map.ts';

export { tilesNear } from './map.ts';

type Grid = Pick<OfficeMap, 'width' | 'height' | 'tiles'>;

const STEPS: readonly Point[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * A simple A* on the tiles, four directions, every step costs one: the
 * shortest path from `start` to the first goal tile, both included, or null
 * when no goal can be reached. `goals` are floor tiles; the others are left out.
 */
export function findPath(grid: Grid, start: Point, goals: readonly Point[]): Point[] | null {
  const targets = goals.filter((goal) => isWalkable(grid, goal[0], goal[1]));
  if (targets.length === 0 || !isWalkable(grid, start[0], start[1])) return null;
  const key = (c: number, r: number): number => r * grid.width + c;
  const goalKeys = new Set(targets.map(([c, r]) => key(c, r)));
  const h = (c: number, r: number): number => Math.min(...targets.map(([gc, gr]) => Math.abs(gc - c) + Math.abs(gr - r)));
  const cost = new Map<number, number>([[key(start[0], start[1]), 0]]);
  const previous = new Map<number, number>();
  // A small open list: maps are at most 40×30 tiles.
  const open: { c: number; r: number; f: number; order: number }[] = [{ c: start[0], r: start[1], f: h(start[0], start[1]), order: 0 }];
  let order = 0;
  const closedSet = new Set<number>();
  while (open.length > 0) {
    let best = 0;
    for (let index = 1; index < open.length; index++) {
      const a = open[index];
      const b = open[best];
      if (a !== undefined && b !== undefined && (a.f < b.f || (a.f === b.f && a.order < b.order))) best = index;
    }
    const current = open.splice(best, 1)[0];
    if (current === undefined) break;
    const here = key(current.c, current.r);
    if (closedSet.has(here)) continue;
    closedSet.add(here);
    if (goalKeys.has(here)) {
      const path: Point[] = [];
      for (let at: number | undefined = here; at !== undefined; at = previous.get(at)) path.push([at % grid.width, Math.floor(at / grid.width)]);
      return path.reverse();
    }
    const g = (cost.get(here) ?? 0) + 1;
    for (const [dc, dr] of STEPS) {
      const c = current.c + dc;
      const r = current.r + dr;
      if (!isWalkable(grid, c, r)) continue;
      const next = key(c, r);
      if (closedSet.has(next) || g >= (cost.get(next) ?? Number.POSITIVE_INFINITY)) continue;
      cost.set(next, g);
      previous.set(next, here);
      open.push({ c, r, f: g + h(c, r), order: ++order });
    }
  }
  return null;
}

/** The tile under a walker's feet. */
export function tileOf(x: number, y: number): Point {
  return [Math.floor(x / TILE), Math.floor((y - 3) / TILE)];
}

/** Half the width of a walker's feet, in pixels: the box that must stay on the floor. */
const FEET: readonly Point[] = [
  [-5, -5],
  [5, -5],
  [-5, -1],
  [5, -1],
];
/** Closer than this to another character is a bump. */
export const PERSONAL_SPACE = 9;

/**
 * Collisions: a walker may stand at (x, y) when its feet are on the floor and
 * it does not walk into someone. Getting away from someone close is always
 * allowed, so nobody is ever trapped by an agent standing next to them.
 */
export function canStand(grid: Grid, x: number, y: number, from: Point, others: readonly Point[]): boolean {
  for (const [dx, dy] of FEET) {
    if (!isWalkable(grid, Math.floor((x + dx) / TILE), Math.floor((y + dy) / TILE))) return false;
  }
  for (const [ox, oy] of others) {
    const d = Math.hypot(ox - x, oy - y);
    if (d < PERSONAL_SPACE && d < Math.hypot(ox - from[0], oy - from[1])) return false;
  }
  return true;
}

/** One step of free movement with the keys: each axis moves on its own, so a walker slides along a wall. */
export function moveFree(grid: Grid, at: Point, vx: number, vy: number, distance: number, others: readonly Point[]): Point {
  const length = Math.hypot(vx, vy);
  if (length === 0) return at;
  let [x, y] = at;
  const nx = x + (vx / length) * distance;
  if (canStand(grid, nx, y, [x, y], others)) x = nx;
  const ny = y + (vy / length) * distance;
  if (canStand(grid, x, ny, [x, y], others)) y = ny;
  return [x, y];
}
