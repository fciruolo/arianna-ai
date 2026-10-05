import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blendView,
  buildQuadtree,
  createSimulation,
  DEFAULT_PARAMS,
  fitView,
  folderSlots,
  isSettled,
  matchesFilter,
  MAX_ZOOM,
  MIN_ZOOM,
  neighbours,
  nodeAt,
  radiusFor,
  repulsionOn,
  resolveWikilink,
  splitWikilinks,
  step,
  toScreen,
  toWorld,
  wheelFactor,
  withAlpha,
  zoomAt,
  type SimNode,
} from '../src/lib/graph.ts';

const node = (x: number, y: number, r = 5): SimNode => ({ x, y, vx: 0, vy: 0, r, fixed: false });
const distance = (a: SimNode | undefined, b: SimNode | undefined) => Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));

test('the start is the same at every load, and kept positions stay', () => {
  const nodes = [{ id: 'a', degree: 1 }, { id: 'b', degree: 1 }, { id: 'c', degree: 0 }];
  const edges = [{ source: 'a', target: 'b' }, { source: 'a', target: 'manca' }];
  const one = createSimulation(nodes, edges);
  const two = createSimulation(nodes, edges);
  assert.deepEqual(one.nodes, two.nodes);
  assert.equal(one.links.length, 1);
  const kept = createSimulation(nodes, edges, new Map([['c', { x: 100, y: -50 }]]));
  assert.deepEqual({ x: kept.nodes[2]?.x, y: kept.nodes[2]?.y }, { x: 100, y: -50 });
  assert.ok(kept.alpha < one.alpha);
});

test('one step pushes unlinked nodes apart and pulls far linked nodes together', () => {
  const apart = createSimulation([{ id: 'a', degree: 0 }, { id: 'b', degree: 0 }], []);
  apart.nodes[0] = node(-5, 0);
  apart.nodes[1] = node(5, 0);
  step(apart);
  assert.ok(distance(apart.nodes[0], apart.nodes[1]) > 10);
  const linked = createSimulation([{ id: 'a', degree: 1 }, { id: 'b', degree: 1 }], [{ source: 'a', target: 'b' }]);
  linked.nodes[0] = { ...node(-400, 0), r: linked.nodes[0]?.r ?? 5 };
  linked.nodes[1] = { ...node(400, 0), r: linked.nodes[1]?.r ?? 5 };
  step(linked);
  assert.ok(distance(linked.nodes[0], linked.nodes[1]) < 800);
});

test('a held node does not move, and the simulation cools until it settles', () => {
  const ids = Array.from({ length: 30 }, (_, i) => ({ id: String(i), degree: 2 }));
  const edges = ids.map((_, i) => ({ source: String(i), target: String((i + 1) % 30) }));
  const sim = createSimulation(ids, edges);
  const held = sim.nodes[3];
  assert.ok(held !== undefined);
  held.fixed = true;
  const { x, y } = held;
  let steps = 0;
  while (!isSettled(sim) && steps < 1000) {
    step(sim);
    steps += 1;
  }
  assert.ok(isSettled(sim));
  assert.ok(steps > 200 && steps < 400, String(steps));
  assert.equal(held.x, x);
  assert.equal(held.y, y);
  for (const n of sim.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
});

test('Barnes-Hut stays close to the exact repulsion, and the quadtree holds every body once', () => {
  const nodes: SimNode[] = [];
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 600; i += 1) nodes.push(node(random() * 1000 - 500, random() * 1000 - 500));
  nodes.push(node(nodes[0]?.x ?? 0, nodes[0]?.y ?? 0));
  const tree = buildQuadtree(nodes);
  assert.equal(tree?.mass, nodes.length);
  for (const i of [0, 10, 300, 600]) {
    const exact = repulsionOn(i, nodes, undefined, -70, 1, 0.9);
    const approx = repulsionOn(i, nodes, tree, -70, 1, 0.9);
    const size = Math.hypot(exact.vx, exact.vy);
    assert.ok(Math.hypot(exact.vx - approx.vx, exact.vy - approx.vy) <= Math.max(0.15 * size, 0.05), String(i));
  }
});

test('the zoom keeps the point under the cursor still, within limits, and screen and world convert both ways', () => {
  const view = { x: 120, y: -40, k: 1.5 };
  const world = toWorld(view, 300, 200);
  const back = toScreen(view, world.x, world.y);
  assert.ok(Math.abs(back.x - 300) < 1e-9 && Math.abs(back.y - 200) < 1e-9);
  const zoomed = zoomAt(view, 300, 200, 2);
  assert.equal(zoomed.k, 3);
  const still = toScreen(zoomed, world.x, world.y);
  assert.ok(Math.abs(still.x - 300) < 1e-9 && Math.abs(still.y - 200) < 1e-9);
  assert.equal(zoomAt(view, 0, 0, 1000).k, MAX_ZOOM);
  assert.equal(zoomAt(view, 0, 0, 0.0001).k, MIN_ZOOM);
  assert.ok(wheelFactor(100) < 1 && wheelFactor(-100) > 1);
  assert.equal(wheelFactor(0), 1);
  assert.ok(Math.abs(wheelFactor(1, 1) - wheelFactor(16)) < 1e-12);
});

test('fitting shows every node, and a glide ends on its target', () => {
  const nodes = [node(-100, -50), node(300, 80)];
  const view = fitView(nodes, 800, 600, 40);
  for (const n of nodes) {
    const at = toScreen(view, n.x, n.y);
    assert.ok(at.x >= 40 && at.x <= 760 && at.y >= 40 && at.y <= 560);
  }
  assert.deepEqual(blendView({ x: 0, y: 0, k: 1 }, { x: 10, y: 20, k: 2 }, 1), { x: 10, y: 20, k: 2 });
  assert.deepEqual(blendView({ x: 0, y: 0, k: 1 }, { x: 10, y: 20, k: 2 }, 0), { x: 0, y: 0, k: 1 });
});

test('the hit test takes the closest node within its radius and the slack', () => {
  const nodes = [node(0, 0, 5), node(8, 0, 5), node(100, 100, 3)];
  assert.equal(nodeAt(nodes, 1, 0), 0);
  assert.equal(nodeAt(nodes, 6, 0), 1);
  assert.equal(nodeAt(nodes, 100, 106), -1);
  assert.equal(nodeAt(nodes, 100, 106, 4), 2);
  assert.equal(nodeAt([], 0, 0), -1);
});

test('neighbours, radius and folder colours', () => {
  const sets = neighbours(3, [{ source: 0, target: 1 }, { source: 1, target: 2 }]);
  assert.deepEqual([...(sets[1] ?? [])].sort(), [0, 2]);
  assert.ok(radiusFor(0) < radiusFor(9) && radiusFor(10_000) <= 18);
  const slots = folderSlots(['inbox', 'work', 'zeta', 'alfa', '#', 'public']);
  assert.equal(slots.get('inbox'), 0);
  assert.equal(slots.get('work'), 2);
  assert.equal(slots.get('alfa'), 4);
  assert.equal(slots.get('zeta'), 5);
  assert.equal(slots.has('#'), false);
  assert.equal(withAlpha('#4fd1c1', 0.5), 'rgba(79, 209, 193, 0.5)');
  assert.equal(withAlpha('#abc', 1), 'rgba(170, 187, 204, 1)');
  assert.equal(withAlpha('#4fd1c133', 0.2), 'rgba(79, 209, 193, 0.2)');
  assert.equal(withAlpha('rgb(1, 2, 3)', 0.2), 'rgb(1, 2, 3)');
});

test('the filter matches title, tags and path, without accents or case', () => {
  const page = { id: 'inbox/caffè.md', title: 'Macchina del Caffè', tags: ['casa'] };
  assert.ok(matchesFilter(page, 'caffe'));
  assert.ok(matchesFilter(page, '#casa macchina'));
  assert.ok(matchesFilter(page, 'inbox'));
  assert.ok(matchesFilter(page, '  '));
  assert.ok(!matchesFilter(page, 'pane'));
});

test('wikilinks of the text: split for clicking, resolved as the core does', () => {
  assert.deepEqual(splitWikilinks('Vedi [[inbox/a|la nota]] e ![[b#x]].'), [
    { kind: 'text', text: 'Vedi ' },
    { kind: 'wikilink', target: 'inbox/a', text: 'la nota' },
    { kind: 'text', text: ' e ' },
    { kind: 'wikilink', target: 'b#x', text: 'b#x' },
    { kind: 'text', text: '.' },
  ]);
  assert.deepEqual(splitWikilinks('niente'), [{ kind: 'text', text: 'niente' }]);
  const ids = ['inbox/a.md', 'public/ricetta.md', 'w/x/d.md', 'w/y/d.md'];
  assert.equal(resolveWikilink('inbox/a', ids), 'inbox/a.md');
  assert.equal(resolveWikilink('kb/inbox/a.md|alias', ids), 'inbox/a.md');
  assert.equal(resolveWikilink('ricetta#passi', ids), 'public/ricetta.md');
  assert.equal(resolveWikilink('d', ids), undefined);
  assert.equal(resolveWikilink('manca', ids), undefined);
  assert.equal(DEFAULT_PARAMS.alphaMin < 0.01, true);
});
