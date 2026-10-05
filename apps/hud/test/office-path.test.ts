import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseMapText, seatPoint, tileCenter, type OfficeMap, type Point } from '../src/lib/office/map.ts';
import { advance, followPath, retarget, seated, seatOf, walkFrame } from '../src/lib/office/motion.ts';
import { canStand, findPath, moveFree, tilesNear, tileOf } from '../src/lib/office/path.ts';

function base(): OfficeMap {
  const result = parseMapText(readFileSync(join(import.meta.dirname, '../src/office/maps/base.json'), 'utf8'));
  if (!result.ok) throw new Error(result.reason);
  return result.map;
}
const MAP = base();

test('A* finds the shortest path around a desk', () => {
  // From above the private desk to below it: the desk (columns 2–4, row 4) is in the way.
  const path = findPath(MAP, [3, 3], [[3, 5]]);
  assert.ok(path !== null);
  assert.deepEqual(path[0], [3, 3]);
  assert.deepEqual(path.at(-1), [3, 5]);
  // Around the desk: two columns sideways, two rows down, back: 6 steps, 7 tiles.
  assert.equal(path.length, 7);
  for (const [c, r] of path) assert.notEqual(MAP.tiles[r * MAP.width + c], 'desk');
  for (let index = 1; index < path.length; index++) {
    const a: Point = path[index - 1] ?? [0, 0];
    const b: Point = path[index] ?? [0, 0];
    assert.equal(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]), 1);
  }
});

test('A* takes the nearest of several goals and the start when it is a goal', () => {
  assert.deepEqual(findPath(MAP, [10, 7], [[10, 7]]), [[10, 7]]);
  const path = findPath(MAP, [10, 7], [[10, 13], [10, 8]]);
  assert.deepEqual(path?.at(-1), [10, 8]);
});

test('A* gives null for a goal on a wall, on furniture, or walled in', () => {
  assert.equal(findPath(MAP, [10, 7], [[0, 0]]), null);
  assert.equal(findPath(MAP, [10, 7], [[3, 4]]), null);
  assert.equal(findPath(MAP, [0, 0], [[10, 7]]), null);
  const walled: OfficeMap = { ...MAP, tiles: MAP.tiles.map((kind, index) => ([15 * MAP.width + 16 - 1, 15 * MAP.width + 17, 16 * MAP.width + 16].includes(index) ? 'plant' : kind)) };
  assert.equal(findPath(walled, [10, 7], [[16, 15]]), null);
});

test('tiles near a point stay within reach and off the point', () => {
  const near = tilesNear(MAP, 10 * 16 + 8, 7 * 16 + 11, 22);
  assert.ok(near.length > 0);
  assert.ok(!near.some(([c, r]) => c === 10 && r === 7));
});

test('collisions: feet on the floor only; a walker never walks into an agent but may walk away', () => {
  const [x, y] = tileCenter([10, 7]);
  assert.equal(canStand(MAP, x, y, [x, y], []), true);
  // Into the wall on the left of the room.
  assert.equal(canStand(MAP, 16 + 2, y, [x, y], []), false);
  // Onto a desk.
  assert.equal(canStand(MAP, 3 * 16 + 8, 4 * 16 + 11, [x, y], []), false);
  // Towards an agent standing close: refused; away from it: allowed.
  const agent: [number, number] = [x + 6, y];
  assert.equal(canStand(MAP, x + 2, y, [x, y], [agent]), false);
  assert.equal(canStand(MAP, x - 2, y, [x, y], [agent]), true);
});

test('free movement slides along a wall instead of stopping', () => {
  const [, y] = tileCenter([1, 7]);
  const x = 21;
  const moved = moveFree(MAP, [x, y], -1, 1, 4, []);
  assert.equal(moved[0], x);
  assert.ok(moved[1] > y);
  assert.deepEqual(moveFree(MAP, [x, y], 0, 0, 4, []), [x, y]);
});

test('an agent whose place changes walks there and sits facing its seat', () => {
  const start = seated(MAP, { kind: 'pause', seat: 0 });
  assert.equal(start.walking, false);
  const walking = retarget(start, MAP, { kind: 'island', slot: 1 }, false);
  assert.equal(walking.walking, true);
  assert.equal(walking.goal, 'island-1');
  // The same place again changes nothing.
  assert.equal(retarget(walking, MAP, { kind: 'island', slot: 1 }, false), walking);
  let actor = walking;
  for (let index = 0; index < 1000 && actor.walking; index++) actor = advance(actor, MAP, 3);
  assert.equal(actor.walking, false);
  assert.deepEqual([actor.x, actor.y], seatPoint(MAP, seatOf(MAP, { kind: 'island', slot: 1 })));
  assert.equal(actor.facing, 'down');
});

test('an agent whose goal changes on the last stretch onto the sofa walks on from there, never jumps', () => {
  let actor = retarget(seated(MAP, { kind: 'island', slot: 0 }), MAP, { kind: 'pause', seat: 0 }, false);
  // Walk until the feet are past the floor, onto the sofa.
  for (let index = 0; index < 2000; index++) {
    const [c, r] = tileOf(actor.x, actor.y);
    if (actor.path.length === 1 && MAP.tiles[r * MAP.width + c] === 'sofa') break;
    actor = advance(actor, MAP, 1);
  }
  assert.equal(actor.walking, true);
  const [c, r] = tileOf(actor.x, actor.y);
  assert.equal(MAP.tiles[r * MAP.width + c], 'sofa');
  const at: Point = [actor.x, actor.y];
  const turned = retarget(actor, MAP, { kind: 'island', slot: 1 }, false);
  assert.equal(turned.walking, true);
  assert.equal(turned.goal, 'island-1');
  // Still where it was, and the first step is to the seat next to it: no jump.
  assert.deepEqual([turned.x, turned.y], at);
  const first = turned.path[0] ?? [0, 0];
  assert.deepEqual(first, tileCenter(MAP.anchors.pause.seats[0] ?? [0, 0]));
  assert.ok(Math.hypot(first[0] - at[0], first[1] - at[1]) < 16);
  let end = turned;
  for (let index = 0; index < 2000 && end.walking; index++) end = advance(end, MAP, 3);
  assert.deepEqual([end.x, end.y], seatPoint(MAP, seatOf(MAP, { kind: 'island', slot: 1 })));
});

test('with reduced motion an agent appears at its place; a slot beyond the map goes to the archive', () => {
  const start = seated(MAP, { kind: 'pause', seat: 0 });
  const moved = retarget(start, MAP, { kind: 'archive' }, true);
  assert.equal(moved.walking, false);
  assert.deepEqual(moved.seat, MAP.anchors.archive.seat);
  assert.equal(moved.facing, 'up');
  assert.deepEqual(seatOf(MAP, { kind: 'island', slot: 9 }), MAP.anchors.archive.seat);
  assert.deepEqual(seatOf(MAP, { kind: 'pause', seat: 9 }), MAP.anchors.pause.seats.at(-1));
});

test('a path is followed by distance, and the walk frames cycle unless motion is reduced', () => {
  const step = followPath([0, 0], [[10, 0], [10, 10]], 15, 'down');
  assert.deepEqual(step.at, [10, 5]);
  assert.equal(step.path.length, 1);
  assert.equal(step.facing, 'down');
  assert.deepEqual(walkFrame('left', 0, false), { column: 0, row: 2, mirror: true });
  assert.equal(walkFrame('up', 130, false).column, 1);
  assert.equal(walkFrame('up', 260, false).column, 2);
  assert.equal(walkFrame('down', 260, true).column, 1);
  assert.deepEqual(tileOf(10 * 16 + 8, 7 * 16 + 11), [10, 7]);
});
