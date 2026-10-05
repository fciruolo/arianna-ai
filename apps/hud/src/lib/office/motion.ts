import { archiveTiles, deskTiles, isWalkable, seatFace, seatPoint, tileCenter, type OfficeMap, type Point, type Room } from './map.ts';
import { findPath, tileOf } from './path.ts';
import type { OfficePlace } from './snapshot.ts';
import { placeKey } from './snapshot.ts';

/**
 * Agents on the map (D-106): seated at their place, or walking to a new one
 * along a path of tiles. A change of place starts a walk; with reduced motion,
 * or without a path, the agent appears at the new place.
 */
export type Facing = 'down' | 'up' | 'right' | 'left';

export interface Actor {
  x: number;
  y: number;
  facing: Facing;
  walking: boolean;
  /** Points still to reach, the seat last. */
  path: Point[];
  /** The place the actor sits at or walks to. */
  goal: string;
  seat: Point;
}

/**
 * The chair beside a seat (D-124), for the second agent at the same island or
 * archive: the floor tiles along the same furniture (above a desk, below the
 * cabinet), nearest first and right before left; past those, the floor of
 * the room nearest the seat; with nothing free, the seat itself.
 */
export function besideSeat(map: OfficeMap, main: Point, furniture: readonly Point[], side: -1 | 1, room: Room, index: number): Point {
  if (index <= 0) return main;
  const distance = (at: Point): number => Math.abs(at[0] - main[0]) + Math.abs(at[1] - main[1]);
  const order = (a: Point, b: Point): number => distance(a) - distance(b) || b[0] - a[0] || a[1] - b[1];
  const same = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];
  const along = furniture
    .map(([c, r]): Point => [c, r + side])
    .filter((at) => !same(at, main) && isWalkable(map, at[0], at[1]))
    .sort(order);
  const floor: Point[] = [];
  for (let r = room[1]; r <= room[3]; r++) {
    for (let c = room[0]; c <= room[2]; c++) {
      const at: Point = [c, r];
      if (isWalkable(map, c, r) && !same(at, main) && !along.some((item) => same(item, at))) floor.push(at);
    }
  }
  return [...along, ...floor.sort(order)][index - 1] ?? main;
}

/** The seat of a place on this map; a slot beyond the map's islands is the archive, a pause seat beyond its seats the last one. */
export function seatOf(map: OfficeMap, place: OfficePlace): Point {
  const { anchors } = map;
  const archive = (index: number): Point => besideSeat(map, anchors.archive.seat, archiveTiles(map), 1, anchors.archive.room, index);
  switch (place.kind) {
    case 'private':
      return anchors.private.seat;
    case 'island': {
      const island = anchors.islands[place.slot];
      if (island === undefined) return archive(place.seat ?? 0);
      return besideSeat(map, island.seat, deskTiles(island.desk), -1, island.room, place.seat ?? 0);
    }
    case 'archive':
      return archive(place.seat ?? 0);
    case 'pause':
      return anchors.pause.seats[Math.min(place.seat, anchors.pause.seats.length - 1)] ?? anchors.entrance;
  }
}

export function seated(map: OfficeMap, place: OfficePlace): Actor {
  const seat = seatOf(map, place);
  const [x, y] = seatPoint(map, seat);
  return { x, y, facing: seatFace(map, seat), walking: false, path: [], goal: placeKey(place), seat };
}

/**
 * The tile a walk starts from: the seat while seated; walking, the tile under
 * the feet, or, on the last stretch onto a sofa (not floor), the seat it was
 * heading to, right next to it: the actor never jumps.
 */
function startTile(actor: Actor, map: OfficeMap): Point {
  if (!actor.walking) return actor.seat;
  const under = tileOf(actor.x, actor.y);
  return isWalkable(map, under[0], under[1]) ? under : actor.seat;
}

/** Sends the actor to a place: nothing when it is already its goal. */
export function retarget(actor: Actor, map: OfficeMap, place: OfficePlace, reduceMotion: boolean): Actor {
  const key = placeKey(place);
  if (key === actor.goal) return actor;
  const seat = seatOf(map, place);
  const from = startTile(actor, map);
  const tiles = reduceMotion ? null : findPath(map, from, [seat]);
  if (tiles === null) return seated(map, place);
  return { ...actor, walking: true, path: [...tiles.map(tileCenter), seatPoint(map, seat)], goal: key, seat };
}

function facingOf(dx: number, dy: number, before: Facing): Facing {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return before;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
}

/** Walks `distance` pixels along the path; at the end the actor sits facing as its seat says. */
export function advance(actor: Actor, map: OfficeMap, distance: number): Actor {
  if (!actor.walking) return actor;
  let { x, y, facing } = actor;
  const path = [...actor.path];
  let left = distance;
  while (left > 0 && path.length > 0) {
    const [tx, ty] = path[0] ?? [x, y];
    const dx = tx - x;
    const dy = ty - y;
    const d = Math.hypot(dx, dy);
    facing = facingOf(dx, dy, facing);
    if (d <= left) {
      x = tx;
      y = ty;
      left -= d;
      path.shift();
    } else {
      x += (dx / d) * left;
      y += (dy / d) * left;
      left = 0;
    }
  }
  if (path.length === 0) return { ...actor, x, y, path, walking: false, facing: seatFace(map, actor.seat) };
  return { ...actor, x, y, path, facing };
}

/** Follows a path of points (the user's walk to a clicked tile). */
export function followPath(at: Point, path: readonly Point[], distance: number, before: Facing): { at: Point; path: Point[]; facing: Facing } {
  let [x, y] = at;
  let facing = before;
  const rest = [...path];
  let left = distance;
  while (left > 0 && rest.length > 0) {
    const [tx, ty] = rest[0] ?? [x, y];
    const dx = tx - x;
    const dy = ty - y;
    const d = Math.hypot(dx, dy);
    facing = facingOf(dx, dy, facing);
    if (d <= left) {
      x = tx;
      y = ty;
      left -= d;
      rest.shift();
    } else {
      x += (dx / d) * left;
      y += (dy / d) * left;
      left = 0;
    }
  }
  return { at: [x, y], path: rest, facing };
}

/**
 * The frame of a sheet for a character: walking cycles 0-1-2-1 in its
 * direction (left is right mirrored); seated facing down shows its pose;
 * facing up types (columns 3–4) or stands.
 */
export function walkFrame(facing: Facing, elapsed: number, reduceMotion: boolean): { column: number; row: number; mirror: boolean } {
  const cycle = [0, 1, 2, 1];
  const column = reduceMotion ? 1 : (cycle[Math.floor(Math.max(0, elapsed) / 130) % cycle.length] ?? 1);
  return { column, row: facing === 'up' ? 1 : facing === 'down' ? 0 : 2, mirror: facing === 'left' };
}
