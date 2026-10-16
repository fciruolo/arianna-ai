// The office with rooms (D-229): format 2 of the map (walls, doors, stroll
// points), the rules of its validator, who gets a room, idle agents strolling
// and the window on the map that follows the user.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { doorAcross, inRoom, parseMap, parseMapText, reachable, ringTiles, tileAt, type OfficeMap } from '../src/lib/office/map.ts';
import { seatOf, strollSpot } from '../src/lib/office/motion.ts';
import { ACTIVE_DAYS, roomClaims } from '../src/lib/office/rooms.ts';
import { OFFICE_SKINS } from '../src/lib/office/skins.ts';
import { assignIslands, idlePlace, officeSnapshot, placeKey, WANDER_MS, type OfficeInput } from '../src/lib/office/snapshot.ts';
import { cameraOffset, officeScale } from '../src/lib/office/view.ts';
import type { Conversation } from '../src/lib/types.ts';

const MAPS = join(import.meta.dirname, '../src/office/maps');
const TEXT = readFileSync(join(MAPS, 'base.json'), 'utf8');
type Raw = Record<string, unknown> & { rows: string[]; anchors: Record<string, unknown>; legend: Record<string, string> };
const BASE = JSON.parse(TEXT) as Raw;
const OPEN = JSON.parse(readFileSync(join(import.meta.dirname, 'support/office-open-plan.json'), 'utf8')) as Raw;

function variant(change: (copy: Raw) => void, from: Raw = BASE): unknown {
  const copy = structuredClone(from);
  change(copy);
  return copy;
}

function setTile(copy: Raw, c: number, r: number, letter: string): void {
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
  assert.equal(result.ok, false, 'refused');
  assert.match('reason' in result ? result.reason : '', reason);
}

const island = (copy: Raw, index: number): Record<string, unknown> => (copy.anchors.islands as Record<string, unknown>[])[index] ?? {};

test('the three offices have rooms: format 2, Privata and six project rooms closed by walls, each with a door reached from the entrance', () => {
  for (const skin of OFFICE_SKINS) {
    const text = readFileSync(join(MAPS, `${skin}.json`), 'utf8');
    const result = parseMapText(text);
    assert.ok(result.ok, skin);
    const map = result.map;
    assert.equal(map.format, 2, skin);
    assert.equal(map.anchors.islands.length, 6, skin);
    assert.ok(map.anchors.strolls.length >= 4, skin);
    const from = reachable(map, map.anchors.entrance);
    for (const item of [map.anchors.private, ...map.anchors.islands]) {
      const ring = ringTiles(item.room);
      assert.ok(ring.every(([c, r]) => tileAt(map, c, r) !== 'floor'), `${skin}: closed`);
      assert.ok(ring.some(([c, r]) => tileAt(map, c, r) === 'door' && from.has(r * map.width + c)), `${skin}: a door`);
      assert.ok(inRoom(item.room, ...item.seat), `${skin}: seat inside`);
    }
    // The doors stand in walls, the entrance on the floor of the lobby.
    map.tiles.forEach((kind, index) => {
      if (kind === 'door') assert.notEqual(doorAcross(map, index % map.width, Math.floor(index / map.width)), null);
    });
    assert.equal(tileAt(map, ...map.anchors.entrance), 'floor');
  }
});

test('format 2: a door only in format 2; strolls only in format 2 and required there', () => {
  refused(variant((copy) => { copy.legend.O = 'door'; }, OPEN), /«door» serve il formato 2/);
  refused(variant((copy) => { copy.anchors.strolls = [[10, 7]]; }, OPEN), /chiave sconosciuta «strolls»/);
  refused(variant((copy) => { delete copy.anchors.strolls; }), /manca «strolls»/);
  refused(variant((copy) => { copy.anchors.strolls = []; }), /«strolls» deve avere da 1 a 12 punti/);
  refused(variant((copy) => { copy.anchors.strolls = Array.from({ length: 13 }, (_, index) => [index + 1, 10]); }), /«strolls» deve avere da 1 a 12 punti/);
  valid(variant((copy) => { copy.anchors.strolls = Array.from({ length: 12 }, (_, index) => [index + 2, 10]); }));
});

test('format 2: every project room is closed by walls and doors, and has a door', () => {
  // An opening in the wall between Privata and the first room, without a door.
  refused(variant((copy) => { setTile(copy, 7, 4, '.'); }), /la stanza «private» non è chiusa da muri e porte/);
  // A door there instead: closed again, the two rooms joined by a door.
  valid(variant((copy) => { setTile(copy, 7, 3, 'O'); }));
  // The doors of Privata walled up.
  refused(variant((copy) => { setTile(copy, 3, 8, '#'); setTile(copy, 4, 8, '#'); }), /la stanza «private» non ha una porta/);
  // Its doors blocked from the hall by two plants.
  refused(variant((copy) => { setTile(copy, 3, 9, 'P'); setTile(copy, 4, 9, 'P'); }), /nessuna porta della stanza «private» si raggiunge dall'ingresso/);
  // One door of two blocked is enough to stay open.
  valid(variant((copy) => { setTile(copy, 3, 9, 'P'); }));
  // A project room too.
  refused(variant((copy) => { setTile(copy, 31, 13, '#'); setTile(copy, 32, 13, '#'); }), /la stanza «islands\[5\]» non ha una porta/);
});

test('format 2: desk and seat inside their room, rooms apart, the other areas keep their places inside', () => {
  refused(variant((copy) => { (copy.anchors.private as Record<string, unknown>).room = [1, 2, 6, 4]; }), /scrivania e posto di «private» devono stare dentro la sua stanza/);
  refused(variant((copy) => { island(copy, 0).room = [6, 2, 13, 7]; }), /«private» e «islands\[0\]» si sovrappongono/);
  refused(variant((copy) => { (copy.anchors.decisions as Record<string, unknown>).room = [15, 17, 20, 19]; }), /la scrivania Decisioni deve stare dentro la sua stanza/);
  refused(variant((copy) => { (copy.anchors.pause as Record<string, unknown>).room = [8, 17, 13, 19]; }), /i posti della Pausa devono stare dentro la sua stanza/);
  refused(variant((copy) => { (copy.anchors.archive as Record<string, unknown>).room = [22, 17, 27, 19]; }), /il posto dell'Archivio deve stare dentro la sua stanza/);
});

test('format 2: a door stands in a wall; no seat and no entrance on a door', () => {
  refused(variant((copy) => { setTile(copy, 6, 10, 'O'); }), /la porta in 6,10 non sta in un muro/);
  // A door in a short wall inside the archive, under the cabinet: a seat may not stand on it.
  refused(variant((copy) => { setTile(copy, 23, 16, '#'); setTile(copy, 25, 16, '#'); setTile(copy, 24, 16, 'O'); }), /il posto «archive» non può stare su una porta/);
  refused(variant((copy) => { copy.anchors.entrance = [3, 8]; }), /ingresso/);
});

test('format 2: stroll points on the floor, reached, outside the rooms of the projects, off every seat', () => {
  const strolls = (points: unknown): unknown => variant((copy) => { copy.anchors.strolls = points; });
  refused(strolls([[1, 9]]), /«strolls\[0\]» deve essere sul pavimento/);
  refused(variant((copy) => {
    copy.anchors.strolls = [[4, 10]];
    for (const [c, r] of [[3, 10], [5, 10], [4, 9], [4, 11]] as const) setTile(copy, c, r, 'P');
  }), /«strolls\[0\]» non si raggiunge/);
  refused(strolls([[3, 6]]), /«strolls\[0\]» non può stare in una stanza di progetto né in Privata/);
  refused(strolls([[30, 18]]), /«strolls\[0\]» non può stare in una stanza di progetto/);
  refused(strolls([[17, 19]]), /«strolls\[0\]» è già un posto/);
  refused(strolls([[4, 10], [4, 10]]), /«strolls\[1\]» è già un posto/);
  // In the pause room and in the lobby: allowed.
  valid(strolls([[12, 18], [18, 18]]));
});

test('idle agents stroll among the points by the clock, one turn in three at their pause spot; still with reduced motion', () => {
  const turn = 3 * 1000;
  const now = turn * WANDER_MS;
  assert.deepEqual(idlePlace(0, { now, strolls: 6 }), { kind: 'pause', seat: 0 });
  assert.deepEqual(idlePlace(1, { now, strolls: 6 }), { kind: 'stroll', spot: (turn + 1) % 6 });
  assert.deepEqual(idlePlace(0, { now: now + WANDER_MS, strolls: 6 }), { kind: 'stroll', spot: (turn + 1) % 6 });
  // Two agents never share a point in the same turn.
  const spots = [1, 2, 4, 5].map((index) => idlePlace(index, { now, strolls: 6 })).filter((place) => place.kind === 'stroll');
  assert.equal(new Set(spots.map((place) => placeKey(place))).size, spots.length);
  // Reduced motion, or a map without points: the pause.
  assert.deepEqual(idlePlace(1, { now, strolls: 6, still: true }), { kind: 'pause', seat: 1 });
  assert.deepEqual(idlePlace(1, { now, strolls: 0 }), { kind: 'pause', seat: 1 });
  assert.deepEqual(idlePlace(1, { now }), { kind: 'pause', seat: 1 });
});

test('the snapshot sends idle agents strolling, and only idle ones: waiting or paused they stay at the pause', () => {
  const base: OfficeInput = {
    agents: [{ id: 'coder', state: 'idle', run: null }, { id: 'arianna', state: 'idle', run: null }],
    projects: [],
    slots: 6,
    activity: [],
    coderConversations: [],
    pending: { total: 0, hidden: 0, coder: 0 },
    quota: {},
    now: (3 * 1000 + 1) * WANDER_MS,
    strolls: 6,
  };
  const coder = (input: OfficeInput) => officeSnapshot(input).agents.find((agent) => agent.id === 'coder')?.place;
  assert.equal(coder(base)?.kind, 'stroll');
  assert.deepEqual(coder({ ...base, pending: { total: 1, hidden: 0, coder: 1 } }), { kind: 'pause', seat: 0 });
  assert.deepEqual(coder({ ...base, quota: { coder: base.now + 60_000 } }), { kind: 'pause', seat: 0 });
  assert.deepEqual(coder({ ...base, still: true }), { kind: 'pause', seat: 0 });
});

test('a stroll point is a point of the map in turn; a map of format 1 strolls in its pause corner', () => {
  const map = valid(BASE);
  assert.deepEqual(strollSpot(map, 0), map.anchors.strolls[0]);
  assert.deepEqual(strollSpot(map, map.anchors.strolls.length + 1), map.anchors.strolls[1]);
  assert.deepEqual(seatOf(map, { kind: 'stroll', spot: 2 }), map.anchors.strolls[2]);
  const open = valid(OPEN);
  assert.deepEqual(open.anchors.strolls, []);
  assert.deepEqual(seatOf(open, { kind: 'stroll', spot: 0 }), seatOf(open, { kind: 'pause', seat: 0 }));
});

const NOW = Date.parse('2026-10-16T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const PROJECTS = ['alfa', 'beta', 'gamma', 'delta', 'demo'].map((name) => ({ name, path: `repos/${name}`, label: 'L1' }));

function conversation(workspace: string | null, change: Partial<Conversation> = {}): Conversation {
  return {
    mode: 'work',
    workspace,
    archivedAt: null,
    pinnedAt: null,
    lastMessageAt: new Date(NOW - DAY).toISOString(),
    createdAt: new Date(NOW - 30 * DAY).toISOString(),
    effectiveLabel: 'L1',
    ...change,
  } as Conversation;
}

test('a room goes to the projects pinned by the user, then to those active in the last 7 days, the others to the archive', () => {
  const claims = roomClaims(
    PROJECTS,
    [
      conversation('gamma', { pinnedAt: new Date(NOW - 40 * DAY).toISOString(), lastMessageAt: new Date(NOW - 40 * DAY).toISOString() }),
      conversation('beta'),
      conversation('alfa', { lastMessageAt: new Date(NOW - (ACTIVE_DAYS + 1) * DAY).toISOString() }),
      conversation('delta', { lastMessageAt: null, createdAt: new Date(NOW - 2 * DAY).toISOString() }),
    ],
    [],
    NOW,
  );
  assert.deepEqual([...claims.entries()].sort(), [['beta', 'active'], ['delta', 'active'], ['gamma', 'pinned']]);
  const { islands, archived } = assignIslands(PROJECTS, 6, claims);
  // Pinned first, then the active ones in the order of arianna.toml; the free rooms stay free.
  assert.deepEqual(islands.map((item) => item.project), ['gamma', 'beta', 'delta']);
  assert.deepEqual(archived, ['alfa', 'demo']);
  // Fewer rooms than claims: the pinned keep theirs, the rest wait behind the archive.
  assert.deepEqual(assignIslands(PROJECTS, 2, claims).islands.map((item) => item.project), ['gamma', 'beta']);
  // The snapshot uses them.
  const snapshot = officeSnapshot({
    agents: [], projects: PROJECTS, slots: 6, claims, activity: [], coderConversations: [], pending: { total: 0, hidden: 0, coder: 0 }, quota: {}, now: NOW,
  });
  assert.deepEqual(snapshot.islands.map((item) => item.project), ['gamma', 'beta', 'delta']);
});

test('what does not claim a room: archived, private, above L2, unknown projects; a running delegation claims one', () => {
  const claims = roomClaims(
    PROJECTS,
    [
      conversation('alfa', { archivedAt: new Date(NOW).toISOString(), pinnedAt: null }),
      conversation('beta', { mode: 'private' }),
      conversation('gamma', { effectiveLabel: 'L3', pinnedAt: new Date(NOW).toISOString() }),
      conversation('sconosciuto', { pinnedAt: new Date(NOW).toISOString() }),
      conversation('constructor'),
      conversation(null),
      // A part of a container claims the room of its project (D-145).
      conversation('demo:admin', { pinnedAt: new Date(NOW).toISOString() }),
    ],
    [{ repo: 'repos/delta' }, { repo: null }, { repo: 'altrove' }],
    NOW,
  );
  assert.deepEqual([...claims.entries()].sort(), [['delta', 'active'], ['demo', 'pinned']]);
  // Pinned wins over active, whatever the order.
  const both = roomClaims(PROJECTS, [conversation('alfa'), conversation('alfa', { pinnedAt: new Date(NOW).toISOString() }), conversation('alfa')], [{ repo: 'alfa' }], NOW);
  assert.deepEqual([...both.entries()], [['alfa', 'pinned']]);
});

test('the window on the map follows the user and stops at the edges; the scale shows about 22 tiles', () => {
  assert.equal(cameraOffset(800, 600, 300), 0, 'the map fits: no offset');
  assert.equal(cameraOffset(800, 1728, 100), 0, 'near the left edge');
  assert.equal(cameraOffset(800, 1728, 900), 500, 'centred on the user');
  assert.equal(cameraOffset(800, 1728, 1700), 928, 'near the right edge');
  assert.equal(officeScale(1100, 36), 3);
  assert.equal(officeScale(600, 36), 2, 'never below 2');
  assert.equal(officeScale(3000, 36), 4, 'never above 4');
  // A small map of format 1 (22 tiles) as before: as big as it fits.
  assert.equal(officeScale(1100, 22), 3);
});
