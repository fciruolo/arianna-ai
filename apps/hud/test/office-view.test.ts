import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { archiveTiles, parseMapText, seatPoint, TILE, tileAt, type OfficeMap } from '../src/lib/office/map.ts';
import { seated } from '../src/lib/office/motion.ts';
import type { OfficeSnapshot } from '../src/lib/office/snapshot.ts';
import { archiveCount, areaTags, hitsArchive, isShortcut, keepDrawing, nameTagTop, snapshotKey } from '../src/lib/office/view.ts';

function base(): OfficeMap {
  const result = parseMapText(readFileSync(join(import.meta.dirname, '../src/office/maps/base.json'), 'utf8'));
  if (!result.ok) throw new Error(result.reason);
  return result.map;
}
const MAP = base();

const SNAPSHOT: OfficeSnapshot = {
  agents: [{ id: 'coder', name: 'Coder', pose: 'idle', place: { kind: 'pause', seat: 0 }, locality: null }],
  islands: [{ slot: 0, project: 'demo', label: 'L1' }],
  archived: ['altro'],
  unnamed: 2,
  decisions: { total: 0, hidden: 0 },
};

test('the loop draws every frame without reduced motion; with it, only while something moves', () => {
  const still = { keys: 0, userPath: 0, agentsWalking: false };
  assert.equal(keepDrawing(false, still), true);
  assert.equal(keepDrawing(true, still), false);
  assert.equal(keepDrawing(true, { ...still, keys: 1 }), true);
  assert.equal(keepDrawing(true, { ...still, userPath: 3 }), true);
  assert.equal(keepDrawing(true, { ...still, agentsWalking: true }), true);
});

test('a key with Cmd, Ctrl or Alt is a shortcut, never a step', () => {
  const plain = { metaKey: false, ctrlKey: false, altKey: false };
  assert.equal(isShortcut(plain), false);
  assert.equal(isShortcut({ ...plain, metaKey: true }), true);
  assert.equal(isShortcut({ ...plain, ctrlKey: true }), true);
  assert.equal(isShortcut({ ...plain, altKey: true }), true);
});

test('an agent\'s name goes on the floor in front of its desk, or under its feet; never on furniture', () => {
  const arianna = seated(MAP, { kind: 'private' });
  const top = nameTagTop(MAP, arianna);
  // Below the desk (row 4), on the floor of row 5.
  assert.equal(Math.floor(top / TILE), MAP.anchors.private.desk[1] + 1);
  assert.equal(tileAt(MAP, MAP.anchors.private.seat[0], Math.floor(top / TILE)), 'floor');
  // On the sofa: under the feet, on the floor of the seat.
  const coder = seated(MAP, { kind: 'pause', seat: 0 });
  const below = nameTagTop(MAP, coder);
  assert.equal(below, coder.y + 2);
  assert.equal(tileAt(MAP, coder.seat[0], Math.floor(below / TILE)), 'floor');
  // Walking: under the feet, wherever the seat is.
  assert.equal(nameTagTop(MAP, { ...arianna, walking: true }), arianna.y + 2);
  assert.ok(nameTagTop(MAP, arianna) > seatPoint(MAP, arianna.seat)[1]);
});

test('area names sit in the bottom-left corner of each area, on the floor; the archive counts every project behind it', () => {
  const tags = areaTags(MAP, SNAPSHOT);
  const rooms = [MAP.anchors.private.room, ...MAP.anchors.islands.map((item) => item.room), MAP.anchors.pause.room, MAP.anchors.decisions.room, MAP.anchors.archive.room];
  assert.equal(tags.length, rooms.length);
  tags.forEach((tag, index) => {
    const room = rooms[index] ?? [0, 0, 0, 0];
    assert.equal(tag.x, room[0] * TILE + 3);
    assert.equal(tag.y, (room[3] + 1) * TILE - 1);
    // The bottom-left tile of every area of the base map is floor: no furniture under the name.
    assert.equal(tileAt(MAP, room[0], room[3]), 'floor', tag.text);
  });
  assert.deepEqual(tags.map((tag) => tag.text), ['Privata', 'demo', 'libera', 'libera', 'libera', 'libera', 'Pausa', 'Decisioni', 'Archivio · 3']);
  assert.deepEqual(tags.map((tag) => tag.label), ['L2', 'L1', null, null, null, null, null, null, null]);
  assert.equal(tags[2]?.muted, true);
  assert.equal(archiveCount(SNAPSHOT), 3);
  assert.equal(areaTags(MAP, { ...SNAPSHOT, archived: [], unnamed: 0 }).at(-1)?.text, 'Archivio');
});

test('a click on any tile of the archive cabinet, or the part drawn above it, hits the archive', () => {
  const tiles = archiveTiles(MAP);
  for (const [c, r] of tiles) {
    assert.equal(hitsArchive(tiles, c * TILE + 8, r * TILE + 8), true);
    assert.equal(hitsArchive(tiles, c * TILE + 8, r * TILE - 5), true);
  }
  // Both tiles of the cabinet two wide.
  assert.equal(hitsArchive(tiles, 17 * TILE + 2, 14 * TILE + 2), true);
  // Beside it, below it, high above it: no.
  assert.equal(hitsArchive(tiles, 15 * TILE + 8, 14 * TILE + 8), false);
  assert.equal(hitsArchive(tiles, 18 * TILE + 1, 14 * TILE + 8), false);
  assert.equal(hitsArchive(tiles, 16 * TILE + 8, 15 * TILE + 8), false);
  assert.equal(hitsArchive(tiles, 16 * TILE + 8, 13 * TILE + 2), false);
  assert.equal(hitsArchive([], 16 * TILE + 8, 14 * TILE + 8), false);
});

test('the same photograph made again has the same key; a change of pose or place does not', () => {
  const again = structuredClone(SNAPSHOT);
  assert.equal(snapshotKey(again), snapshotKey(SNAPSHOT));
  const posed = structuredClone(SNAPSHOT);
  if (posed.agents[0] !== undefined) posed.agents[0].pose = 'working';
  assert.notEqual(snapshotKey(posed), snapshotKey(SNAPSHOT));
  const moved = structuredClone(SNAPSHOT);
  if (moved.agents[0] !== undefined) moved.agents[0].place = { kind: 'archive' };
  assert.notEqual(snapshotKey(moved), snapshotKey(SNAPSHOT));
});
