import { isWalkable, seatFace, seatPoint, tileCenter, type OfficeMap, type Point } from './map.ts';
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

/** The seat of a place on this map; a slot beyond the map's islands is the archive, a pause seat beyond its seats the last one. */
export function seatOf(map: OfficeMap, place: OfficePlace): Point {
  const { anchors } = map;
  switch (place.kind) {
    case 'private':
      return anchors.private.seat;
    case 'island':
      return anchors.islands[place.slot]?.seat ?? anchors.archive.seat;
    case 'archive':
      return anchors.archive.seat;
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
