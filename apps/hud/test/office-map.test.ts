import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  archivePoint,
  archiveTiles,
  decisionsPoint,
  DESK_TALK_REACH,
  DESK_WALK_REACH,
  MAX_BYTES,
  MAX_FURNITURE,
  parseMap,
  parseMapText,
  reachable,
  seatFace,
  seatPoint,
  TALK_REACH,
  tileAt,
  tilesNear,
  WALK_REACH,
  type OfficeMap,
} from '../src/lib/office/map.ts';

const TEXT = readFileSync(join(import.meta.dirname, '../src/office/maps/base.json'), 'utf8');
const BASE = JSON.parse(TEXT) as Record<string, unknown> & { rows: string[]; anchors: Record<string, unknown>; legend: Record<string, string> };

/** A copy of the base map with a change. */
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

test('the base map is valid, with id "base", five island slots and the anchors', () => {
  const map = valid(JSON.parse(TEXT));
  assert.equal(parseMapText(TEXT).ok, true);
  assert.equal(map.id, 'base');
  assert.equal(map.anchors.islands.length, 5);
  assert.equal(tileAt(map, 0, 0), 'wall');
  assert.equal(tileAt(map, 3, 4), 'desk');
  assert.equal(tileAt(map, 99, 0), undefined);
});

test('every seat of the base map is reached from the entrance', () => {
  const map = valid(BASE);
  const from = reachable(map, map.anchors.entrance);
  const seats = [map.anchors.private.seat, ...map.anchors.islands.map((item) => item.seat), ...map.anchors.pause.seats, map.anchors.archive.seat];
  for (const [c, r] of seats) assert.ok(from.has(r * map.width + c), `${String(c)},${String(r)}`);
});

test('a seat is drawn behind its desk, on the sofa, or in its tile; and faces its furniture', () => {
  const map = valid(BASE);
  assert.deepEqual(seatPoint(map, [3, 3]), [3 * 16 + 8, 4 * 16 + 2]);
  assert.deepEqual(seatPoint(map, [2, 15]), [2 * 16 + 8, 14 * 16 + 14]);
  assert.deepEqual(seatPoint(map, [10, 7]), [10 * 16 + 8, 7 * 16 + 11]);
  assert.equal(seatFace(map, [3, 3]), 'down');
  assert.equal(seatFace(map, [16, 15]), 'up');
});

test('the validator refuses unknown keys, a wrong format and a free id', () => {
  refused(variant((copy) => { copy.title = 'Ufficio'; }), /chiave sconosciuta «title»/);
  refused(variant((copy) => { copy.anchors.extra = [1, 1]; }), /chiave sconosciuta «extra»/);
  refused(variant((copy) => { copy.format = 2; }), /formato/);
  refused(variant((copy) => { copy.id = 'Il mio ufficio'; }), /«id»/);
  refused(variant((copy) => { delete copy.anchors.archive; }), /manca «archive»/);
});

test('the validator refuses sizes beyond the limits and rows of the wrong width', () => {
  refused(variant((copy) => { copy.size = [41, 18]; }), /dimensioni/);
  refused(variant((copy) => { copy.size = [22, 31]; }), /dimensioni/);
  refused(variant((copy) => { copy.size = [3, 18]; }), /dimensioni.*da 4×4/);
  refused(variant((copy) => { copy.size = [22, 3]; }), /dimensioni/);
  refused(variant((copy) => { copy.rows = copy.rows.slice(1); }), /18 righe/);
  refused(variant((copy) => { copy.rows[3] = '#..#'; }), /22 caratteri/);
});

test('the validator refuses a character outside the legend and an unknown tile', () => {
  refused(variant((copy) => { setTile(copy, 5, 5, 'Z'); }), /«Z».*non è in «legend»/);
  refused(variant((copy) => { copy.legend.P = 'fountain'; }), /tessera sconosciuta/);
  refused(variant((copy) => { copy.legend.PP = 'plant'; }), /un solo carattere/);
});

test('the validator refuses a file over the limit and text that is not JSON', () => {
  const big = TEXT.replace('"format": 1,', `"format": 1, "pad": "${'x'.repeat(MAX_BYTES)}",`);
  const result = parseMapText(big);
  assert.equal(result.ok, false);
  assert.match('reason' in result ? result.reason : '', /KB/);
  const broken = parseMapText('{');
  assert.equal(broken.ok, false);
});

test('the validator refuses too few or too many islands', () => {
  refused(variant((copy) => { copy.anchors.islands = (copy.anchors.islands as unknown[]).slice(0, 1); }), /da 2 a 12 isole/);
  refused(variant((copy) => {
    const one = (copy.anchors.islands as unknown[])[0];
    copy.anchors.islands = Array.from({ length: 13 }, () => one);
  }), /da 2 a 12 isole/);
});

test('the validator refuses a seat on furniture, far from its desk, shared, or not reachable', () => {
  // On the desk itself.
  refused(variant((copy) => { (copy.anchors.private as Record<string, unknown>).seat = [3, 4]; }), /«private» deve essere su una tessera calpestabile/);
  // On the floor but not next to its desk.
  refused(variant((copy) => { (copy.anchors.private as Record<string, unknown>).seat = [3, 6]; }), /non è accanto/);
  // The same seat twice.
  refused(variant((copy) => { ((copy.anchors.islands as Record<string, unknown>[])[0] ?? {}).seat = [3, 3]; ((copy.anchors.islands as Record<string, unknown>[])[0] ?? {}).desk = [2, 4, 3]; }), /già di un altro/);
  // Walled in: plants around the archive seat.
  refused(variant((copy) => { setTile(copy, 15, 15, 'P'); setTile(copy, 17, 15, 'P'); setTile(copy, 16, 16, 'P'); }), /«archive» non si raggiunge/);
});

test('the validator refuses a desk not on desk tiles, a Decisioni desk out of reach, an entrance on a wall', () => {
  refused(variant((copy) => { (copy.anchors.private as Record<string, unknown>).desk = [2, 5, 3]; }), /private\.desk/);
  refused(variant((copy) => { (copy.anchors.decisions as Record<string, unknown>).desk = [9, 14, 4]; }), /decisions\.desk/);
  refused(variant((copy) => {
    for (const c of [8, 13]) setTile(copy, c, 15, 'P');
    for (let c = 9; c <= 12; c++) { setTile(copy, c, 14, 'P'); setTile(copy, c, 16, 'P'); }
  }), /Decisioni non si raggiunge/);
  refused(variant((copy) => { copy.anchors.entrance = [0, 0]; }), /ingresso/);
  refused(variant((copy) => { copy.anchors.entrance = [50, 3]; }), /ingresso/);
});

test('the validator refuses a room outside the map and too much furniture', () => {
  refused(variant((copy) => { (copy.anchors.pause as Record<string, unknown>).room = [1, 14, 30, 16]; }), /esce dalla mappa/);
  refused(variant((copy) => {
    copy.size = [40, 30];
    copy.rows = Array.from({ length: 30 }, (_, r) => (r === 0 || r === 29 ? '#'.repeat(40) : `#${'P'.repeat(38)}#`));
  }), /troppi arredi/);
});

test('the validator refuses pause seats none or beyond six, and a pause seat away from sofa and coffee', () => {
  refused(variant((copy) => { (copy.anchors.pause as Record<string, unknown>).seats = []; }), /«pause\.seats» deve avere da 1 a 6 posti/);
  refused(variant((copy) => {
    (copy.anchors.pause as Record<string, unknown>).seats = [[1, 15], [2, 15], [3, 15], [1, 16], [2, 16], [3, 16], [4, 15]];
  }), /«pause\.seats» deve avere da 1 a 6 posti/);
  refused(variant((copy) => { (copy.anchors.pause as Record<string, unknown>).seats = [[4, 16]]; }), /«pause\.seats\[0\]» non è accanto/);
});

test('the validator refuses an archive seat away from a cabinet, and desks of width 0 or beyond 8', () => {
  refused(variant((copy) => { (copy.anchors.archive as Record<string, unknown>).seat = [19, 16]; }), /«archive» non è accanto/);
  refused(variant((copy) => { (copy.anchors.private as Record<string, unknown>).desk = [2, 4, 0]; }), /private\.desk.*da 1 a 8/);
  refused(variant((copy) => { (copy.anchors.private as Record<string, unknown>).desk = [2, 4, 9]; }), /private\.desk.*da 1 a 8/);
});

test('the validator refuses size, rows and legend of the wrong type', () => {
  refused(variant((copy) => { copy.size = '22x18'; }), /«size» deve essere una lista di 2 numeri interi/);
  refused(variant((copy) => { copy.size = [22.5, 18]; }), /«size»/);
  refused(variant((copy) => { copy.rows = 'abc' as unknown as string[]; }), /«rows» deve avere 18 righe/);
  refused(variant((copy) => { copy.rows[2] = 7 as unknown as string; }), /la riga 2/);
  refused(variant((copy) => { copy.legend = ['#'] as unknown as Record<string, string>; }), /«legend» non è un oggetto/);
  refused(variant((copy) => { copy.legend = 'wall' as unknown as Record<string, string>; }), /«legend» non è un oggetto/);
});

test('the validator accepts only what the engine draws: seat above its desk, archive seat below a cabinet', () => {
  // Beside the desk, not above it.
  refused(variant((copy) => { (copy.anchors.private as Record<string, unknown>).seat = [1, 4]; }), /«private» deve stare subito sopra la sua scrivania/);
  // Below the desk.
  refused(variant((copy) => { ((copy.anchors.islands as Record<string, unknown>[])[1] ?? {}).seat = [17, 5]; }), /«islands\[1\]» deve stare subito sopra/);
  // Beside the cabinet, not below it.
  refused(variant((copy) => { (copy.anchors.archive as Record<string, unknown>).seat = [15, 14]; }), /«archive» deve stare subito sotto un armadio/);
  // Below the second cabinet tile: accepted.
  const map = valid(variant((copy) => { (copy.anchors.archive as Record<string, unknown>).seat = [17, 15]; }));
  assert.deepEqual(map.anchors.archive.seat, [17, 15]);
});

test('the archive cabinet is every cabinet tile joined to the one above its seat', () => {
  const map = valid(BASE);
  assert.deepEqual(archiveTiles(map).map(([c, r]) => `${String(c)},${String(r)}`).sort(), ['16,14', '17,14']);
});

/**
 * A map at every limit: 40×30 tiles, 12 islands, 6 pause seats and exactly
 * MAX_FURNITURE furniture tiles; `extra` plants beyond that.
 */
function limitMap(extra = 0): Record<string, unknown> {
  const width = 40;
  const height = 30;
  const grid = Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c): string => (r === 0 || c === 0 || r === height - 1 || c === width - 1 ? '#' : '.')));
  const put = (c: number, r: number, letter: string): void => {
    const row = grid[r];
    if (row !== undefined) row[c] = letter;
  };
  const islands: unknown[] = [];
  for (const row of [4, 10, 16]) {
    for (const c0 of [2, 11, 20, 29]) {
      for (let i = 0; i < 3; i++) put(c0 + i, row, 'D');
      islands.push({ room: [c0 - 1, row - 2, c0 + 4, row + 1], desk: [c0, row, 3], seat: [c0 + 1, row - 1] });
    }
  }
  for (let i = 0; i < 3; i++) put(2 + i, 22, 'D');
  for (let i = 0; i < 4; i++) put(11 + i, 22, 'C');
  for (let c = 2; c <= 7; c++) put(c, 25, 'S');
  put(30, 25, 'A');
  // Plants along the edges, never closing a passage, up to the limit.
  const spots: [number, number][] = [];
  for (let c = 1; c <= 38; c++) spots.push([c, 1], [c, 28]);
  for (let r = 2; r <= 27; r++) spots.push([38, r], [37, r]);
  for (let c = 1; c <= 30; c++) spots.push([c, 2]);
  const furniture = (): number => grid.flat().filter((letter) => !['#', '.'].includes(letter)).length;
  for (const [c, r] of spots) {
    if (furniture() >= MAX_FURNITURE + extra) break;
    put(c, r, 'P');
  }
  return {
    format: 1,
    id: 'limiti',
    size: [width, height],
    rows: grid.map((row) => row.join('')),
    legend: { '#': 'wall', '.': 'floor', D: 'desk', C: 'counter', S: 'sofa', A: 'cabinet', P: 'plant' },
    anchors: {
      entrance: [35, 27],
      private: { room: [1, 20, 6, 23], desk: [2, 22, 3], seat: [3, 21] },
      islands,
      decisions: { room: [10, 21, 15, 23], desk: [11, 22, 4] },
      pause: { room: [1, 24, 8, 27], seats: [[2, 26], [3, 26], [4, 26], [5, 26], [6, 26], [7, 26]] },
      archive: { room: [29, 24, 31, 27], seat: [30, 26] },
    },
  };
}

test('the validator accepts a map at every limit: 40×30, 12 islands, 6 pause seats, exactly 200 furniture tiles', () => {
  const raw = limitMap();
  const map = valid(raw);
  assert.equal(map.width, 40);
  assert.equal(map.height, 30);
  assert.equal(map.anchors.islands.length, 12);
  assert.equal(map.anchors.pause.seats.length, 6);
  assert.equal(map.tiles.filter((kind) => kind !== 'floor' && kind !== 'wall').length, MAX_FURNITURE);
  assert.equal(parseMapText(JSON.stringify(raw)).ok, true);
  // One more furniture tile is too many.
  refused(limitMap(1), /troppi arredi \(201/);
});

test('the validator refuses what the engine cannot walk to: a counter free only at its ends, a seat closed at its sides', () => {
  // The Decisioni counter (columns 9–12, row 15) with plants on the floor in front of and behind its middle:
  // free floor is left only at its ends, beyond the reach of the bell in the middle.
  refused(variant((copy) => {
    for (const c of [10, 11]) { setTile(copy, c, 14, 'P'); setTile(copy, c, 16, 'P'); }
  }), /la scrivania Decisioni non si raggiunge/);
  // Arianna's seat (3, 3) with plants at its sides: the seat tile is under her, the one above too far.
  refused(variant((copy) => { setTile(copy, 2, 3, 'P'); setTile(copy, 4, 3, 'P'); }), /l'agente della Privata non si raggiunge/);
  refused(variant((copy) => { setTile(copy, 9, 3, 'P'); setTile(copy, 11, 3, 'P'); }), /l'agente di «islands\[0\]» non si raggiunge/);
  // One side open is enough.
  valid(variant((copy) => { setTile(copy, 2, 3, 'P'); }));
});

test('every point the engine walks to in the base map has a tile within its reach', () => {
  const map = valid(BASE);
  const from = reachable(map, map.anchors.entrance);
  const reached = (point: readonly [number, number], reach: number): boolean => tilesNear(map, point[0], point[1], reach).some(([c, r]) => from.has(r * map.width + c));
  assert.ok(reached(decisionsPoint(map), DESK_WALK_REACH));
  assert.ok(reached(archivePoint(map), WALK_REACH));
  for (const island of [map.anchors.private, ...map.anchors.islands]) assert.ok(reached(seatPoint(map, island.seat), WALK_REACH));
  // The user talks a little farther than it walks.
  assert.deepEqual([WALK_REACH, TALK_REACH, DESK_WALK_REACH, DESK_TALK_REACH], [22, 26, 26, 30]);
});
