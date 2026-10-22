import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_ZOOM, toWorld, type View } from '../src/lib/graph.ts';
import { centerInBand, hitRadius, listRows, neighbourRows, pinchView, readPhoneView } from '../src/lib/knowledge-phone.ts';

function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${String(actual)} ≠ ${String(expected)}`);
}

test('pinchView keeps the world point under the middle of the fingers', () => {
  const start: View = { x: 10, y: -20, k: 1.5 };
  const startMid = { x: 100, y: 200 };
  const world = toWorld(start, startMid.x, startMid.y);
  const mid = { x: 140, y: 170 };
  const view = pinchView(start, startMid, 100, mid, 200);
  close(view.k, 3);
  const after = toWorld(view, mid.x, mid.y);
  close(after.x, world.x);
  close(after.y, world.y);
});

test('pinchView with fingers still and the same distance leaves the view as it was', () => {
  const start: View = { x: 5, y: 7, k: 2 };
  assert.deepEqual(pinchView(start, { x: 50, y: 60 }, 80, { x: 50, y: 60 }, 80), start);
});

test('pinchView clamps the zoom and ignores a zero distance', () => {
  const start: View = { x: 0, y: 0, k: 1 };
  close(pinchView(start, { x: 0, y: 0 }, 10, { x: 0, y: 0 }, 10_000).k, MAX_ZOOM);
  assert.equal(pinchView(start, { x: 0, y: 0 }, 0, { x: 0, y: 0 }, 50).k, 1);
});

test('hitRadius is wider for a finger than for a mouse', () => {
  assert.equal(hitRadius(true), 22);
  assert.equal(hitRadius(false), 4);
});

test('centerInBand brings the point to the middle of the band', () => {
  const view = centerInBand(390, 200, 400, 10, -5, 2);
  assert.deepEqual(view, { k: 2, x: 195 - 20, y: 300 + 10 });
  // A band given upside down is the same band.
  assert.deepEqual(centerInBand(390, 400, 200, 10, -5, 2), view);
});

test('readPhoneView remembers the list, the graph otherwise', () => {
  assert.equal(readPhoneView('list'), 'list');
  assert.equal(readPhoneView('graph'), 'graph');
  assert.equal(readPhoneView(null), 'graph');
  assert.equal(readPhoneView('3d'), 'graph');
});

const nodes = [
  { title: 'zucca', kind: null, degree: 1 },
  { title: '#casa', kind: 'tag', degree: 9 },
  { title: 'Àncora', kind: null, degree: 1 },
  { title: 'Rete', kind: 'wiki', degree: 5 },
  { title: 'barca', kind: null, degree: 1 },
];

test('listRows keeps the matching nodes, pages first, most linked first, then by title', () => {
  const { rows, more } = listRows(nodes, [true, true, true, true, true], 10);
  assert.deepEqual(
    rows.map((row) => row.index),
    [3, 2, 4, 0, 1],
  );
  assert.equal(more, 0);
});

test('listRows drops the nodes that do not match and counts what the limit leaves out', () => {
  const { rows, more } = listRows(nodes, [true, true, false, true, true], 2);
  assert.deepEqual(
    rows.map((row) => row.node.title),
    ['Rete', 'barca'],
  );
  assert.equal(more, 2);
  assert.deepEqual(listRows(nodes, [], 10), { rows: [], more: 0 });
});

test('neighbourRows orders the neighbours and drops indices outside the graph', () => {
  const rows = neighbourRows(nodes, [1, 0, 7, 3, 0, -1]);
  assert.deepEqual(
    rows.map((row) => row.index),
    [3, 0, 1],
  );
  assert.deepEqual(neighbourRows(nodes, []), []);
});
