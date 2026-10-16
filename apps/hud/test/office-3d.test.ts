// The office in 3D (D-230): from the map to the boxes of the world, the walk of
// the keys turned by the camera with the same collisions as the 2D view, which
// side of a sprite the camera sees, what is in sight, the room the user is in,
// the choice of the view remembered by the browser, and three.js kept out of
// everything but the module the page loads on demand. No WebGL here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { isWall, isWalkable, parseMapText, tileAt, TILE, tileCenter, type OfficeMap, type Point } from '../src/lib/office/map.ts';
import { canStand, moveFree, tileOf } from '../src/lib/office/path.ts';
import { OFFICE_SKINS, type OfficeSkin } from '../src/lib/office/skins.ts';
import {
  areaAt,
  buildWorld,
  DOOR_HEIGHT,
  EYE_HEIGHT,
  facingOfYaw,
  inSight,
  loadViewMode,
  openSide,
  pickedTile,
  saveViewMode,
  SPRITE_HEIGHT,
  standPoint,
  toMap,
  toWorld,
  viewFacing,
  walkVector,
  WALL_HEIGHT,
  yawTowards,
  type Block,
  type WalkKeys,
} from '../src/lib/office/world3d.ts';

const SRC = join(import.meta.dirname, '../src');
function mapOf(skin: OfficeSkin): OfficeMap {
  const result = parseMapText(readFileSync(join(SRC, `office/maps/${skin === 'base' ? 'base' : skin}.json`), 'utf8'));
  assert.ok(result.ok, `${skin}: ${result.ok ? '' : result.reason}`);
  return result.map;
}
const BASE = mapOf('base');

function covers(block: Block, c: number, r: number): boolean {
  return block.x - block.w / 2 <= c + 0.5 && block.x + block.w / 2 >= c + 0.5 && block.z - block.d / 2 <= r + 0.5 && block.z + block.d / 2 >= r + 0.5;
}

function tilesOf(map: OfficeMap, test: (kind: ReturnType<typeof tileAt>) => boolean): Point[] {
  const found: Point[] = [];
  for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) if (test(tileAt(map, c, r))) found.push([c, r]);
  return found;
}

const NONE: WalkKeys = { forward: false, back: false, left: false, right: false };

test('every wall tile is under a raised wall, every floor and door tile is not', () => {
  for (const skin of OFFICE_SKINS) {
    const map = mapOf(skin);
    const world = buildWorld(map, skin);
    const walls = world.blocks.filter((block) => block.color === 'wall-face' && block.y === 0 && block.h === WALL_HEIGHT);
    for (const [c, r] of tilesOf(map, isWall)) assert.ok(walls.some((block) => covers(block, c, r)), `${skin}: wall ${String(c)},${String(r)}`);
    for (const [c, r] of tilesOf(map, (kind) => kind === 'floor' || kind === 'door')) {
      assert.ok(!walls.some((block) => covers(block, c, r)), `${skin}: a wall over the floor at ${String(c)},${String(r)}`);
    }
    // Joined in runs along a row: far fewer boxes than wall tiles.
    assert.ok(walls.length < tilesOf(map, isWall).length / 2, `${skin}: walls not joined`);
  }
});

test('a door is a gap in the wall under a lintel, above the eyes of the user', () => {
  const world = buildWorld(BASE, 'base');
  const doors = tilesOf(BASE, (kind) => kind === 'door');
  assert.ok(doors.length > 0);
  const heights: number[] = [EYE_HEIGHT, DOOR_HEIGHT, WALL_HEIGHT];
  assert.deepEqual([...heights].sort((a, b) => a - b), heights);
  for (const [c, r] of doors) {
    const over = world.blocks.filter((block) => covers(block, c, r) && block.w <= 1.02 && block.d <= 1.02);
    assert.equal(over.length, 1, `door ${String(c)},${String(r)}`);
    const [lintel] = over;
    assert.ok(lintel !== undefined && lintel.y === DOOR_HEIGHT && lintel.y + lintel.h === WALL_HEIGHT);
    assert.ok(isWalkable(BASE, c, r));
  }
  // A plain floor tile has no box over it at all.
  const floor = tilesOf(BASE, (kind) => kind === 'floor').find(([c, r]) => !world.blocks.some((block) => covers(block, c, r)));
  assert.ok(floor !== undefined);
});

test('the furniture stands inside its own tile, below the walls; the floor covers every tile but the walls', () => {
  for (const skin of OFFICE_SKINS) {
    const map = mapOf(skin);
    const world = buildWorld(map, skin);
    const furniture = tilesOf(map, (kind) => kind !== undefined && !isWall(kind) && kind !== 'floor' && kind !== 'door');
    for (const [c, r] of furniture) {
      const own = world.blocks.filter((block) => Math.floor(block.x) === c && Math.floor(block.z) === r && block.w <= 1 && block.d <= 1 && block.y < DOOR_HEIGHT);
      assert.ok(own.length > 0, `${skin}: nothing drawn at ${String(c)},${String(r)} (${String(tileAt(map, c, r))})`);
      for (const block of own) {
        assert.ok(block.x - block.w / 2 >= c - 1e-9 && block.x + block.w / 2 <= c + 1 + 1e-9, `${skin}: ${String(c)},${String(r)} out of its tile`);
        assert.ok(block.y + block.h <= WALL_HEIGHT);
      }
    }
    assert.equal(world.floors.length, tilesOf(map, (kind) => kind !== undefined && !isWall(kind)).length);
  }
});

test('the places of the themes: checked floor and no handrail for Base, a handrail only in the Sacro Cuore', () => {
  const base = buildWorld(BASE, 'base');
  assert.ok(base.floors.some((tile) => tile.alt) && base.floors.some((tile) => !tile.alt));
  const rails = (world: ReturnType<typeof buildWorld>): Block[] => world.blocks.filter((block) => block.color === 'wall-line' && block.y > 0.2);
  assert.equal(rails(base).length, 0);
  const corsia = buildWorld(mapOf('corsia'), 'corsia');
  assert.ok(rails(corsia).length > 0);
  assert.ok(corsia.floors.every((tile) => !tile.alt));
  assert.equal(rails(buildWorld(mapOf('ufficio'), 'ufficio')).length, 0);
  // The power plant of Springfield (D-237): no handrail, the yellow hazard stripe low on its walls, the barrels with their rod.
  const plant = buildWorld(mapOf('springfield'), 'springfield');
  assert.equal(rails(plant).length, 0);
  const stripe = (block: Block): boolean => block.color === 'warn' && block.w > 1 && block.y > 0.2 && block.y < 0.6;
  assert.ok(plant.blocks.some(stripe));
  assert.ok(plant.blocks.some((block) => block.color === 'ok' && block.w < 0.2));
  for (const skin of ['base', 'corsia', 'ufficio'] as const) assert.ok(!buildWorld(mapOf(skin), skin).blocks.some(stripe), skin);
  // Fox River (D-240): one-colour concrete, no handrail, bars in front of every window, nowhere else.
  const prisonMap = mapOf('fox-river');
  const prison = buildWorld(prisonMap, 'fox-river');
  assert.equal(rails(prison).length, 0);
  assert.ok(prison.floors.every((tile) => !tile.alt));
  const bars = prison.blocks.filter((block) => block.color === 'outline' && block.y >= 0.5);
  const windows = tilesOf(prisonMap, (kind) => kind === 'window').filter(([c, r]) => openSide(prisonMap, c, r) !== null);
  assert.equal(bars.length, windows.length * 4);
  for (const block of bars) assert.ok(windows.some(([c, r]) => Math.abs(block.x - (c + 0.5)) < 0.7 && Math.abs(block.z - (r + 0.5)) < 0.7), `a bar at ${String(block.x)},${String(block.z)}`);
  assert.equal(buildWorld(BASE, 'base').blocks.filter((block) => block.color === 'outline' && block.y >= 0.5).length, 0);
  // The lockers of Fox River in the colour of the counter (D-240, the dead line gone in D-242), the cabinets of Base in that of the desks.
  const tall = (world: ReturnType<typeof buildWorld>, map: OfficeMap): Block[] => world.blocks.filter((block) => block.h === 1.05 && tilesOf(map, (kind) => kind === 'cabinet').some(([c, r]) => covers(block, c, r)));
  assert.ok(tall(prison, prisonMap).length > 0 && tall(prison, prisonMap).every((block) => block.color === 'counter'));
  assert.ok(tall(buildWorld(BASE, 'base'), BASE).every((block) => block.color === 'desk'));
  // The Planet Express (D-242): one-colour floor, no handrail, the ship in the green of the theme over its three tiles, a tall glass tube for each coffee tile.
  const expressMap = mapOf('planet-express');
  const express = buildWorld(expressMap, 'planet-express');
  assert.equal(rails(express).length, 0);
  assert.ok(express.floors.every((tile) => !tile.alt));
  const hull = express.blocks.filter((block) => block.color === 'ok' && block.y >= 0.2 && block.y < 0.3);
  assert.deepEqual([...new Set(hull.map((block) => `${String(Math.floor(block.x))},${String(Math.floor(block.z))}`))].sort(), ['27,9', '28,9', '29,9']);
  const tubes = express.blocks.filter((block) => block.color === 'window-light' && block.h > 1);
  assert.equal(tubes.length, tilesOf(expressMap, (kind) => kind === 'coffee').length);
  assert.equal(buildWorld(BASE, 'base').blocks.filter((block) => block.color === 'window-light' && block.h > 1).length, 0);
});

test('a screen on the desk of every room with a desk, keyed by its seat; the bell over the Decisioni desk', () => {
  const world = buildWorld(BASE, 'base');
  const seats = [BASE.anchors.private, ...BASE.anchors.islands].map((island) => `${String(island.seat[0])},${String(island.seat[1])}`);
  assert.deepEqual(world.monitors.map((monitor) => monitor.key).sort(), [...seats].sort());
  for (const monitor of world.monitors) assert.equal(tileAt(BASE, Math.floor(monitor.x), Math.floor(monitor.z)), 'desk');
  const desk = BASE.anchors.decisions.desk;
  assert.ok(world.bell.x > desk[0] && world.bell.x < desk[0] + desk[2] && Math.floor(world.bell.z) === desk[1]);
});

test('openSide: the side of a wall that looks onto the floor, south first; none for a wall closed all round', () => {
  // The cardwall hangs on the wall over the corridor: its open side is south.
  const board = tilesOf(BASE, (kind) => kind === 'board')[0];
  assert.ok(board !== undefined);
  assert.deepEqual(openSide(BASE, board[0], board[1]), { dc: 0, dr: 1 });
  assert.equal(openSide(BASE, 0, 0), null);
});

test('walkVector: forward, back and sideways turned by where the camera looks', () => {
  const forward = { ...NONE, forward: true };
  const close = (a: Point, b: Point): void => {
    assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9, `${String(a)} vs ${String(b)}`);
  };
  close(walkVector(forward, 0), [0, -1]);
  close(walkVector(forward, Math.PI / 2), [-1, 0]);
  close(walkVector(forward, Math.PI), [0, 1]);
  close(walkVector({ ...NONE, back: true }, 0), [0, 1]);
  close(walkVector({ ...NONE, right: true }, 0), [1, 0]);
  close(walkVector({ ...NONE, left: true }, Math.PI / 2), [0, 1]);
  assert.deepEqual(walkVector(NONE, 1), [0, 0]);
  assert.deepEqual(walkVector({ forward: true, back: true, left: true, right: true }, 1), [0, 0]);
  assert.equal(facingOfYaw(0), 'up');
  assert.equal(facingOfYaw(Math.PI / 2), 'left');
  assert.equal(facingOfYaw(-Math.PI / 2), 'right');
  assert.equal(facingOfYaw(Math.PI), 'down');
  const at = { x: 3, z: 3 };
  assert.ok(Math.abs(yawTowards(at, { x: 3, z: 1 })) < 1e-9);
  close(walkVector(forward, yawTowards(at, { x: 6, z: 3 })), [1, 0]);
});

test('the same collisions as the plan: walking forward in 3D never leaves the floor and stops at a wall', () => {
  // From the entrance looking north the Decisioni desk is in the way: the walk stops in front of it.
  let at: Point = tileCenter(BASE.anchors.entrance);
  const step = walkVector({ ...NONE, forward: true }, 0);
  for (let index = 0; index < 400; index++) {
    const next = moveFree(BASE, at, step[0], step[1], 1, []);
    assert.ok(canStand(BASE, next[0], next[1], at, []), `left the floor at ${String(next)}`);
    at = next;
  }
  assert.ok(tileOf(at[0], at[1])[1] > BASE.anchors.decisions.desk[1], 'walked through the desk');
  // Through a door: from the corridor in front of Privata's door, north into the room.
  const door = tilesOf(BASE, (kind) => kind === 'door').find(([c, r]) => r === 8 && c < 7);
  assert.ok(door !== undefined);
  at = tileCenter([door[0], door[1] + 2]);
  for (let index = 0; index < 60; index++) at = moveFree(BASE, at, step[0], step[1], 1, []);
  assert.ok(tileOf(at[0], at[1])[1] < door[1], 'did not pass the door');
  // Sideways into the wall on the left of the corridor's west end: blocked.
  at = tileCenter([1, 10]);
  const left = walkVector({ ...NONE, left: true }, 0);
  for (let index = 0; index < 60; index++) at = moveFree(BASE, at, left[0], left[1], 1, []);
  assert.equal(tileOf(at[0], at[1])[0], 1);
});

test('viewFacing: the front when the character looks at the camera, the back when away, else its side', () => {
  const at = { x: 0, z: 0 };
  assert.equal(viewFacing('down', at, { x: 0, z: 5 }), 'down');
  assert.equal(viewFacing('down', at, { x: 0, z: -5 }), 'up');
  // Looking south, seen from the east: it looks to the left of the screen.
  assert.equal(viewFacing('down', at, { x: 5, z: 0 }), 'left');
  assert.equal(viewFacing('down', at, { x: -5, z: 0 }), 'right');
  // Looking east, seen from the south: to the right of the screen.
  assert.equal(viewFacing('right', at, { x: 0, z: 5 }), 'right');
  assert.equal(viewFacing('up', at, at), 'down');
});

test('inSight: never through a wall, always through an open door', () => {
  const door = tilesOf(BASE, (kind) => kind === 'door').find(([c, r]) => r === 8 && c < 7);
  assert.ok(door !== undefined);
  const corridor = { x: door[0] + 0.5, z: door[1] + 2.5 };
  assert.equal(inSight(BASE, corridor, { x: door[0] + 0.5, z: door[1] - 2.5 }), true);
  // The same distance one column away is behind the wall of the room.
  const wallColumn = door[0] + 3;
  assert.ok(isWall(tileAt(BASE, wallColumn, door[1])));
  assert.equal(inSight(BASE, { x: wallColumn + 0.5, z: door[1] + 2.5 }, { x: wallColumn + 0.5, z: door[1] - 2.5 }), false);
});

test('areaAt: the room the user is in, with its project and label as in the tags of the plan; null in the corridor', () => {
  const snapshot = { islands: [{ slot: 0, project: 'demo', label: 'L1' as const }, { slot: 1, project: 'arianna', label: 'L1' as const }], archived: ['vecchio'], unnamed: 1 };
  assert.deepEqual(areaAt(BASE, snapshot, BASE.anchors.private.seat), { text: 'Privata', label: 'L2' });
  assert.deepEqual(areaAt(BASE, snapshot, BASE.anchors.islands[0]?.seat ?? [0, 0]), { text: 'demo', label: 'L1' });
  assert.deepEqual(areaAt(BASE, snapshot, BASE.anchors.islands[1]?.seat ?? [0, 0]), { text: 'GOD', label: 'L1' });
  assert.deepEqual(areaAt(BASE, snapshot, BASE.anchors.islands[2]?.seat ?? [0, 0]), { text: 'Stanza libera', label: null });
  assert.deepEqual(areaAt(BASE, snapshot, BASE.anchors.archive.seat), { text: 'Archivio · 2', label: null });
  assert.deepEqual(areaAt(BASE, snapshot, BASE.anchors.pause.seats[0] ?? [0, 0]), { text: 'Pausa', label: null });
  const desk = BASE.anchors.decisions.desk;
  assert.deepEqual(areaAt(BASE, snapshot, [desk[0], desk[1] + 1]), { text: 'Decisioni', label: null });
  assert.equal(areaAt(BASE, snapshot, [10, 10]), null);
});

test('standPoint: seated in the middle of the seat, already there on the last step; walking where the feet are', () => {
  const seat: Point = [3, 4];
  assert.deepEqual(standPoint({ x: 0, y: 0, walking: false, path: [], seat }), { x: 3.5, z: 4.5 });
  assert.deepEqual(standPoint({ x: 0, y: 0, walking: true, path: [[56, 98]], seat }), { x: 3.5, z: 4.5 });
  const walking = standPoint({ x: 5 * TILE + 8, y: 9 * TILE + 11, walking: true, path: [[1, 1], [2, 2]], seat });
  assert.deepEqual(walking, { x: 5.5, z: 9.5 });
  assert.deepEqual(toMap(walking.x, walking.z), [5.5 * TILE, 9.5 * TILE]);
  assert.deepEqual(toWorld(tileCenter([5, 9])), walking);
  const sizes: number[] = [EYE_HEIGHT, SPRITE_HEIGHT];
  assert.deepEqual([...sizes].sort((a, b) => a - b), sizes);
});

test('the view of the office: the plan by default, 3D only when this browser chose it, never an error', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  assert.equal(loadViewMode(storage), '2d');
  assert.equal(loadViewMode(undefined), '2d');
  saveViewMode(storage, '3d');
  assert.equal(loadViewMode(storage), '3d');
  saveViewMode(storage, '2d');
  assert.equal(loadViewMode(storage), '2d');
  store.set('arianna.office.view', 'vr');
  assert.equal(loadViewMode(storage), '2d');
  const refusing = {
    getItem: (): string => {
      throw new Error('blocked');
    },
    setItem: (): void => {
      throw new Error('blocked');
    },
  };
  assert.equal(loadViewMode(refusing), '2d');
  assert.doesNotThrow(() => {
    saveViewMode(refusing, '3d');
  });
});

test('three.js only in the module the office loads on demand, and nothing of its examples', () => {
  const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');
  const scene = read('lib/office/scene3d.ts');
  assert.match(scene, /from 'three';/);
  assert.doesNotMatch(scene, /three\/(examples|addons)/);
  for (const path of ['lib/office/world3d.ts', 'components/OfficeCanvas.vue', 'components/OfficePage.vue', 'App.vue', 'main.ts']) {
    assert.doesNotMatch(read(path), /from 'three'/, path);
  }
  const canvas = read('components/OfficeCanvas.vue');
  // Types only, erased; the module itself arrives with a dynamic import.
  assert.match(canvas, /import type \{ OfficeScene, SpriteState \} from '\.\.\/lib\/office\/scene3d\.ts';/);
  assert.match(canvas, /await import\('\.\.\/lib\/office\/scene3d\.ts'\)/);
  assert.doesNotMatch(canvas.replace(/import type [^;]+;/g, ''), /^import [^;]*scene3d/m);
});

test('the cardwall wears its notes on the side of the floor, within its tiles; a wall closed all round wears none', () => {
  const world = buildWorld(BASE, 'base');
  const board = tilesOf(BASE, (kind) => kind === 'board');
  const COLORS = new Set(['accent', 'warn', 'info', 'ok', 'danger']);
  const notes = world.blocks.filter((block) => COLORS.has(block.color));
  assert.ok(notes.length >= board.length * 2);
  const row = board[0]?.[1] ?? 0;
  const first = board[0]?.[0] ?? 0;
  const last = board.at(-1)?.[0] ?? 0;
  const sheets = world.blocks.filter((block) => block.color === 'paper' && Math.floor(block.x) >= first && Math.floor(block.x) <= last);
  const front = Math.max(...sheets.map((block) => block.z + block.d / 2));
  for (const block of notes) {
    assert.ok(block.x - block.w / 2 >= first - 1e-9 && block.x + block.w / 2 <= last + 1 + 1e-9, 'a note outside the cardwall');
    // South of the wall, on the floor's side, in front of the sheet.
    assert.ok(block.z - block.d / 2 >= front - 0.011 && block.z + block.d / 2 <= row + 1 + 0.1, 'a note behind the sheet or off the wall');
  }
  // No panel at all on the outer corner of the map, a wall with no floor around it.
  assert.ok(!world.blocks.some((block) => block.x < 1 && block.z < 1 && block.color !== 'wall-face' && block.color !== 'wall-top' && block.color !== 'wall-line'));
});

test('a click in 3D lands on the plan where the 2D rules find the thing: inside the cardwall, on the floor in front of it', () => {
  const board = tilesOf(BASE, (kind) => kind === 'board')[0];
  assert.ok(board !== undefined);
  const [c, r] = board;
  const south = { x: 0, z: 1 };
  // The front of a note, 0.09 out of the wall over the floor: the click goes back into the wall tile.
  const onNote = pickedTile({ x: c + 0.3, y: 0.9, z: r + 1.09 }, south);
  assert.equal(Math.floor(onNote.z), r);
  assert.equal(tileAt(BASE, Math.floor(onNote.x), Math.floor(onNote.z)), 'board');
  // The floor in front of it stays the floor.
  const onFloor = pickedTile({ x: c + 0.3, y: 0, z: r + 1.2 }, { x: 0, z: 0 });
  assert.equal(tileAt(BASE, Math.floor(onFloor.x), Math.floor(onFloor.z)), 'floor');
  // The top of a desk: straight down, the desk itself.
  const desk = BASE.anchors.decisions.desk;
  const onTop = pickedTile({ x: desk[0] + 0.5, y: 0.62, z: desk[1] + 0.5 }, { x: 0, z: 0 });
  assert.equal(tileAt(BASE, Math.floor(onTop.x), Math.floor(onTop.z)), 'counter');
  assert.deepEqual(pickedTile({ x: 1, y: 0.5, z: 2 }, null), { x: 1, z: 2 });
});
