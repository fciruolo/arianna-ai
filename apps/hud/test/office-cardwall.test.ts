import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  archivePoint,
  boardPoint,
  boardTiles,
  decisionsPoint,
  DESK_TALK_REACH,
  isWall,
  MAX_BOARD,
  parseMap,
  reachable,
  seatPoint,
  TALK_REACH,
  TILE,
  tileAt,
  tileCenter,
  tilesNear,
  WALK_REACH,
  type OfficeMap,
} from '../src/lib/office/map.ts';
import { COLOR_TOKENS, drawOffice, THEME_TOKENS, type Colors } from '../src/lib/office/draw.ts';
import type { OfficeSnapshot } from '../src/lib/office/snapshot.ts';
import { boardTag, closestTarget, hintText, hitsBoard, type Target } from '../src/lib/office/view.ts';

/** The cardwall in the office (I-13 tappa C4, D-165). */

const TEXT = readFileSync(join(import.meta.dirname, '../src/office/maps/base.json'), 'utf8');
const BASE = JSON.parse(TEXT) as Record<string, unknown> & { rows: string[]; legend: Record<string, string> };

function variant(change: (copy: typeof BASE) => void): unknown {
  const copy = structuredClone(BASE);
  change(copy);
  return copy;
}

function setTile(copy: typeof BASE, c: number, r: number, letter: string): void {
  const row = copy.rows[r] ?? '';
  copy.rows[r] = row.slice(0, c) + letter + row.slice(c + 1);
}

function valid(raw: unknown): OfficeMap {
  const result = parseMap(raw);
  if (!result.ok) throw new Error(result.reason);
  return result.map;
}

function refused(raw: unknown, reason: RegExp): void {
  const result = parseMap(raw);
  assert.equal(result.ok, false);
  assert.match('reason' in result ? result.reason : '', reason);
}

const MAP = valid(BASE);

/** The targets the canvas offers, with the agents at their seats (Arianna at Privata, the Coder at the first island). */
function targets(map: OfficeMap): Target[] {
  const list: Target[] = [
    { id: 'arianna', point: seatPoint(map, map.anchors.private.seat), reach: TALK_REACH },
    ...map.anchors.islands.map((island, slot): Target => ({ id: `agent-${String(slot)}`, point: seatPoint(map, island.seat), reach: TALK_REACH })),
    { id: 'decisions', point: decisionsPoint(map), reach: DESK_TALK_REACH },
    { id: 'archive', point: archivePoint(map), reach: TALK_REACH },
  ];
  const board = boardPoint(map);
  if (board !== null) list.push({ id: 'cardwall', point: board, reach: TALK_REACH });
  return list;
}

test('the base map hangs a cardwall two tiles wide on the top wall, beside the shelf, above the floor', () => {
  assert.deepEqual(boardTiles(MAP), [[7, 1], [8, 1]]);
  for (const [c, r] of boardTiles(MAP)) {
    assert.equal(tileAt(MAP, c, r), 'board');
    assert.ok(isWall('board'));
    assert.equal(tileAt(MAP, c, r + 1), 'floor');
  }
  assert.equal(tileAt(MAP, 6, 1), 'shelf');
  assert.deepEqual(boardPoint(MAP), [8 * TILE, 2 * TILE]);
});

test('the user walks to a floor tile in reach of the cardwall, reached from the entrance', () => {
  const point = boardPoint(MAP);
  assert.ok(point !== null);
  const from = reachable(MAP, MAP.anchors.entrance);
  const near = tilesNear(MAP, point[0], point[1], WALK_REACH);
  assert.ok(near.length > 0);
  for (const [c, r] of near) assert.ok(from.has(r * MAP.width + c), `${String(c)},${String(r)}`);
});

test('standing where the walk to the cardwall ends, the closest thing in reach is the cardwall', () => {
  const point = boardPoint(MAP);
  assert.ok(point !== null);
  for (const tile of tilesNear(MAP, point[0], point[1], WALK_REACH)) assert.equal(closestTarget(tileCenter(tile), targets(MAP)), 'cardwall', String(tile));
});

test('far from the cardwall it is not in reach: by the entrance nothing is, by Arianna\'s desk she is', () => {
  assert.equal(closestTarget(tileCenter(MAP.anchors.entrance), targets(MAP)), null);
  assert.equal(closestTarget(tileCenter([3, 5]), targets(MAP)), 'arianna');
  assert.equal(closestTarget(tileCenter([8, 3]), targets(MAP)), null);
});

test('closestTarget: the closest within its reach, the reach exclusive, the first on a tie', () => {
  const list: Target[] = [
    { id: 'a', point: [0, 0], reach: 10 },
    { id: 'b', point: [8, 0], reach: 10 },
    { id: 'c', point: [-4, 0], reach: 10 },
  ];
  assert.equal(closestTarget([5, 0], list), 'b');
  assert.equal(closestTarget([2, 0], list), 'a');
  assert.equal(closestTarget([-2, 0], list), 'a');
  assert.equal(closestTarget([30, 0], list), null);
  assert.equal(closestTarget([18, 0], list), null);
  assert.equal(closestTarget([17.9, 0], list), 'b');
  assert.equal(closestTarget([0, 0], []), null);
});

test('a click on the cardwall hits any of its tiles, never the floor under it or the shelf beside it', () => {
  const tiles = boardTiles(MAP);
  assert.equal(hitsBoard(tiles, 7 * TILE + 1, TILE + 5), true);
  assert.equal(hitsBoard(tiles, 9 * TILE - 1, 2 * TILE - 1), true);
  assert.equal(hitsBoard(tiles, 8 * TILE, 2 * TILE), false);
  assert.equal(hitsBoard(tiles, 6 * TILE + 8, TILE + 8), false);
  assert.equal(hitsBoard(tiles, 9 * TILE, TILE + 8), false);
  assert.equal(hitsBoard([], 7 * TILE + 1, TILE + 5), false);
});

test('the cardwall\'s name sits on the wall above it; none without a cardwall', () => {
  assert.deepEqual(boardTag(MAP), { x: 7 * TILE + 1, y: TILE, text: 'Cardwall', label: null, muted: false });
  const bare = valid(variant((copy) => { setTile(copy, 7, 1, '#'); setTile(copy, 8, 1, '#'); }));
  assert.equal(boardTag(bare), null);
});

test('the hint near the cardwall says what E opens; the others keep their words', () => {
  const snapshot: Pick<OfficeSnapshot, 'agents' | 'decisions' | 'archived' | 'unnamed'> = {
    agents: [{ id: 'coder', name: 'Coder', pose: 'idle', place: { kind: 'pause', seat: 0 }, locality: null }],
    decisions: { total: 2, hidden: 0 },
    archived: ['altro'],
    unnamed: 1,
  };
  assert.equal(hintText('cardwall', snapshot), 'Apri il cardwall');
  assert.equal(hintText('decisions', snapshot), 'Decisioni in attesa (2)');
  assert.equal(hintText('decisions', { ...snapshot, decisions: { total: 0, hidden: 0 } }), 'Nessuna decisione in attesa');
  assert.equal(hintText('archive', snapshot), 'Archivio (2)');
  assert.equal(hintText('coder', snapshot), 'Parla con Coder');
  assert.equal(hintText('who-knows', snapshot), 'Parla con Agente');
});

test('a map without a cardwall is valid: the cardwall is optional', () => {
  const bare = valid(variant((copy) => { setTile(copy, 7, 1, '#'); setTile(copy, 8, 1, '#'); delete copy.legend.T; }));
  assert.deepEqual(boardTiles(bare), []);
  assert.equal(boardPoint(bare), null);
  assert.equal(closestTarget(tileCenter([8, 2]), targets(bare)), null);
});

test('the validator accepts a cardwall of one tile and one of MAX_BOARD tiles', () => {
  const one = valid(variant((copy) => { setTile(copy, 8, 1, '#'); }));
  assert.deepEqual(boardTiles(one), [[7, 1]]);
  const widest = valid(variant((copy) => { setTile(copy, 9, 1, 'T'); setTile(copy, 10, 1, 'T'); }));
  assert.equal(boardTiles(widest).length, MAX_BOARD);
});

test('the validator refuses a cardwall too wide, in pieces, over a wall, or out of reach', () => {
  refused(variant((copy) => { for (let c = 9; c <= 11; c++) setTile(copy, c, 1, 'T'); }), /al massimo 4 tessere/);
  refused(variant((copy) => { setTile(copy, 11, 1, 'T'); }), /una sola fila/);
  refused(variant((copy) => { setTile(copy, 5, 7, 'T'); }), /una sola fila/);
  refused(variant((copy) => { setTile(copy, 7, 1, '#'); setTile(copy, 8, 1, '#'); setTile(copy, 3, 0, 'T'); }), /sotto il cardwall serve la stanza/);
  refused(variant((copy) => { setTile(copy, 7, 2, 'P'); setTile(copy, 8, 2, 'P'); }), /il cardwall non si raggiunge/);
});

test('the cardwall is drawn over the whole run of its tiles, after the wall faces, and underlined only in reach', () => {
  const colors = Object.fromEntries([...COLOR_TOKENS, ...THEME_TOKENS].map((name) => [name, name])) as Colors;
  const draw = (boardNear: boolean): { style: string; x: number; y: number; w: number; h: number }[] => {
    const calls: { style: string; x: number; y: number; w: number; h: number }[] = [];
    const context = {
      fillStyle: '',
      globalAlpha: 1,
      fillRect(x: number, y: number, w: number, h: number) { calls.push({ style: this.fillStyle, x, y, w, h }); },
      save() {}, restore() {}, translate() {}, scale() {}, drawImage() {},
    };
    drawOffice(context as unknown as CanvasRenderingContext2D, { map: MAP, colors, now: 0, reduceMotion: true, islandRugs: MAP.anchors.islands.map(() => null), screens: new Set(), figures: [], decisionsWaiting: false, boardNear });
    return calls;
  };
  const calls = draw(false);
  const paper = calls.findIndex((call) => call.style === 'paper' && call.x === 7 * TILE + 2 && call.y === TILE + 2 && call.w === 2 * TILE - 4);
  assert.ok(paper >= 0);
  const lastFace = calls.findLastIndex((call) => call.style === 'wall-face' && call.y === TILE && call.x >= 7 * TILE && call.x <= 8 * TILE);
  assert.ok(lastFace >= 0 && lastFace < paper);
  const underline = (list: typeof calls): boolean => list.some((call) => call.style === 'accent' && call.y === 2 * TILE && call.x === 7 * TILE + 2);
  assert.equal(underline(calls), false);
  assert.equal(underline(draw(true)), true);
});
