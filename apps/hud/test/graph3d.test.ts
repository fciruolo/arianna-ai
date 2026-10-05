import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_PARAMS } from '../src/lib/graph.ts';
import {
  blendCamera,
  boundingSphere,
  copyCamera,
  buildOctree,
  createSimulation3,
  depthOrder,
  driftWeight,
  driftYaw,
  DRIFT_IDLE_MS,
  emptyProjection,
  fitCamera,
  fitDistance,
  flyTarget,
  fogAlpha,
  hitTest3,
  isSettled3,
  makeProjector,
  MAX_DISTANCE,
  MAX_NODE_PX,
  MAX_PITCH,
  MIN_DISTANCE,
  NEAR,
  NEAR_FADE,
  nearFade,
  orbitBy,
  project,
  projectNodes,
  projectSegment,
  readViewMode,
  repulsion3On,
  step3,
  toCamera,
  updateProjector,
  wrapAngle,
  zoomCamera,
  type Camera,
  type SimNode3,
} from '../src/lib/graph3d.ts';

const camera = (over: Partial<Camera> = {}): Camera => ({ target: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, distance: 500, ...over });
const close = (a: number, b: number, eps = 1e-9): void => {
  assert.ok(Math.abs(a - b) <= eps, `${String(a)} ≉ ${String(b)}`);
};

test('projection: the target lands on the centre, nearer points look bigger', () => {
  const p = makeProjector(camera(), 800, 600);
  const centre = project(p, 0, 0, 0);
  close(centre.x, 400);
  close(centre.y, 300);
  close(centre.depth, 500);
  const near = project(p, 0, 0, 100);
  const far = project(p, 0, 0, -100);
  assert.ok(near.scale > centre.scale && centre.scale > far.scale);
  // Right in the world is right on the screen, down is down.
  assert.ok(project(p, 50, 0, 0).x > 400);
  assert.ok(project(p, 0, 50, 0).y > 300);
});

test('projection: the panel shift moves the centre; a point behind the camera has no size', () => {
  const p = makeProjector(camera(), 800, 600, -400);
  close(project(p, 0, 0, 0).x, 200);
  const behind = project(p, 0, 0, 600);
  assert.equal(behind.scale, 0);
  assert.ok(behind.depth < 0);
});

test('rotation: yaw of a quarter turn brings the x axis onto the depth axis, lengths unchanged', () => {
  const p = makeProjector(camera({ yaw: Math.PI / 2 }), 800, 600);
  const c = toCamera(p, 100, 0, 0);
  close(c.x, 0, 1e-9);
  close(Math.abs(c.z), 100, 1e-9);
  const q = makeProjector(camera({ yaw: 0.7, pitch: -0.4 }), 800, 600);
  const turned = toCamera(q, 30, -40, 120);
  close(Math.hypot(turned.x, turned.y, turned.z), Math.hypot(30, -40, 120), 1e-9);
  // No rotation: the camera axes are the world's.
  const still = toCamera(makeProjector(camera(), 800, 600), 3, 4, 5);
  assert.deepEqual(still, { x: 3, y: 4, z: 5 });
});

test('rotation: negative pitch looks from above (the top of the graph comes nearer)', () => {
  const p = makeProjector(camera({ pitch: -0.5 }), 800, 600);
  assert.ok(project(p, 0, -100, 0).depth < 500);
  const q = makeProjector(camera({ pitch: 0.5 }), 800, 600);
  assert.ok(project(q, 0, -100, 0).depth > 500);
});

test('projectNodes agrees with project and marks nodes behind the camera', () => {
  const nodes = [
    { x: 10, y: 20, z: 30, r: 5 },
    { x: 0, y: 0, z: 900, r: 5 },
  ];
  const p = makeProjector(camera({ yaw: 0.3, pitch: -0.2 }), 640, 480);
  const out = emptyProjection(2);
  projectNodes(p, nodes, out);
  const one = project(p, 10, 20, 30);
  close(out.x[0] ?? NaN, one.x);
  close(out.y[0] ?? NaN, one.y);
  close(out.r[0] ?? NaN, 5 * one.scale);
  assert.equal(out.r[1], 0);
});

test('depth order: farthest first; equal depths keep a valid permutation', () => {
  const depth = new Float64Array([300, 900, 100, 500]);
  assert.deepEqual([...depthOrder(depth, 4)], [1, 3, 0, 2]);
  const reused = new Uint32Array(4);
  assert.equal(depthOrder(depth, 4, reused), reused);
  const flat = depthOrder(new Float64Array([1, 1, 1]), 3);
  assert.deepEqual([...flat].sort(), [0, 1, 2]);
  // A buffer of the wrong length is not reused.
  assert.notEqual(depthOrder(depth, 4, new Uint32Array(3)).length, 3);
});

test('hit test: the nearest node wins where two overlap, even if its centre is farther', () => {
  const projected = emptyProjection(2);
  projected.x.set([100, 104]);
  projected.y.set([100, 100]);
  projected.r.set([20, 20]);
  projected.depth.set([800, 200]);
  assert.equal(hitTest3(projected, 2, 100, 100), 1);
  // Only the far one contains the point: it is found.
  assert.equal(hitTest3(projected, 2, 82, 100), 0);
});

test('hit test: nothing under the point, behind the camera or skipped', () => {
  const projected = emptyProjection(2);
  projected.x.set([100, 300]);
  projected.y.set([100, 300]);
  projected.r.set([10, 0]);
  projected.depth.set([400, -5]);
  assert.equal(hitTest3(projected, 2, 200, 200), -1);
  assert.equal(hitTest3(projected, 2, 300, 300), -1);
  assert.equal(hitTest3(projected, 2, 100, 100, 0, (i) => i === 0), -1);
  // The slack of a finger reaches a little farther.
  assert.equal(hitTest3(projected, 2, 115, 100), -1);
  assert.equal(hitTest3(projected, 2, 115, 100, 8), 0);
});

test('fog: full in front, faded at the back, never below the minimum', () => {
  assert.equal(fogAlpha(100, 100, 300), 1);
  close(fogAlpha(300, 100, 300, 0.2), 0.2);
  close(fogAlpha(200, 100, 300, 0.2), 0.6);
  close(fogAlpha(5000, 100, 300, 0.2), 0.2);
  assert.equal(fogAlpha(50, 100, 300), 1);
  assert.equal(fogAlpha(200, 300, 100), 1);
});

test('camera: orbit turns and clamps the tilt, zoom stays within limits', () => {
  const turned = orbitBy(camera(), 100, 0);
  assert.ok(turned.yaw < 0);
  assert.equal(turned.pitch, 0);
  assert.equal(orbitBy(camera(), 0, -100_000).pitch, MAX_PITCH);
  assert.equal(orbitBy(camera(), 0, 100_000).pitch, -MAX_PITCH);
  assert.equal(zoomCamera(camera(), 2).distance, 250);
  assert.equal(zoomCamera(camera(), 1e9).distance, MIN_DISTANCE);
  assert.equal(zoomCamera(camera(), 1e-9).distance, MAX_DISTANCE);
  assert.equal(zoomCamera(camera(), 0).distance, 500);
});

test('camera: wrapAngle and the flight take the short way round', () => {
  close(wrapAngle(Math.PI * 3), -Math.PI);
  close(wrapAngle(-0.5), -0.5);
  const from = camera({ yaw: Math.PI - 0.1 });
  const to = camera({ yaw: -Math.PI + 0.1, distance: 100, target: { x: 10, y: 0, z: 0 } });
  const mid = blendCamera(from, to, 0.5);
  assert.ok(Math.abs(mid.yaw) > Math.PI - 0.2, 'the yaw goes through ±π, not through 0');
  const end = blendCamera(from, to, 1);
  close(end.distance, 100, 1e-9);
  close(end.target.x, 10);
  const start = blendCamera(from, to, 0);
  close(start.distance, 500, 1e-9);
});

test('camera: fit shows the whole sphere, the flight goes close to a node', () => {
  const nodes = [
    { x: -100, y: 0, z: 0, r: 5 },
    { x: 100, y: 0, z: 0, r: 5 },
  ];
  const sphere = boundingSphere(nodes);
  assert.deepEqual(sphere.center, { x: 0, y: 0, z: 0 });
  close(sphere.radius, 105);
  const fitted = fitCamera(camera(), nodes, 800, 600);
  const p = makeProjector(fitted, 800, 600);
  for (const node of nodes) {
    const at = project(p, node.x, node.y, node.z);
    assert.ok(at.x > 0 && at.x < 800);
  }
  // A narrow screen needs more distance than a wide one.
  assert.ok(fitDistance(105, 300, 600) > fitDistance(105, 1200, 600));
  assert.equal(boundingSphere([]).radius, 40);
  const flown = flyTarget(camera({ yaw: 1 }), { x: 5, y: 6, z: 7, r: 4 });
  assert.deepEqual(flown.target, { x: 5, y: 6, z: 7 });
  assert.equal(flown.yaw, 1);
  assert.ok(flown.distance < 500);
});

test('drift: nothing while the user is active, then it grows to full speed', () => {
  assert.equal(driftWeight(0), 0);
  assert.equal(driftWeight(DRIFT_IDLE_MS), 0);
  assert.equal(driftWeight(DRIFT_IDLE_MS + 60_000), 1);
  assert.equal(driftYaw(0.5, 16, 0), 0.5);
  assert.ok(driftYaw(0.5, 16, 1) > 0.5);
  // A long pause counts as one frame.
  assert.equal(driftYaw(0, 10_000, 1), driftYaw(0, 100, 1));
});

test('view mode: only "3d" chooses 3D', () => {
  assert.equal(readViewMode('3d'), '3d');
  assert.equal(readViewMode('2d'), '2d');
  assert.equal(readViewMode(null), '2d');
  assert.equal(readViewMode('3D'), '2d');
});

function ring(count: number): { nodes: { id: string; degree: number }[]; edges: { source: string; target: string }[] } {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${String(i)}`, degree: 2 }));
  const edges = nodes.map((node, i) => ({ source: node.id, target: `n${String((i + 1) % count)}` }));
  return { nodes, edges };
}

test('3D simulation: settles, stays finite, uses the third axis and keeps linked nodes closer', () => {
  const { nodes, edges } = ring(40);
  edges.push({ source: 'n0', target: 'missing' });
  const sim = createSimulation3(nodes, edges);
  assert.equal(sim.links.length, 40, 'the edge to a missing node is dropped');
  for (let i = 0; i < 400 && !isSettled3(sim); i += 1) step3(sim);
  assert.ok(isSettled3(sim));
  for (const node of sim.nodes) assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z));
  const spread = (axis: 'x' | 'y' | 'z') => Math.max(...sim.nodes.map((n) => n[axis])) - Math.min(...sim.nodes.map((n) => n[axis]));
  assert.ok(spread('z') > 20, 'not flat');
  const dist = (a: SimNode3 | undefined, b: SimNode3 | undefined) => (a === undefined || b === undefined ? NaN : Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
  const linked = sim.links.reduce((sum, link) => sum + dist(sim.nodes[link.source], sim.nodes[link.target]), 0) / sim.links.length;
  let all = 0;
  let pairs = 0;
  for (let i = 0; i < sim.nodes.length; i += 1)
    for (let j = i + 1; j < sim.nodes.length; j += 1) {
      all += dist(sim.nodes[i], sim.nodes[j]);
      pairs += 1;
    }
  assert.ok(linked < all / pairs);
});

test('3D simulation: nodes on the same point come apart without NaN; the start is the same at every load', () => {
  const sim = createSimulation3(
    [
      { id: 'a', degree: 0 },
      { id: 'b', degree: 0 },
    ],
    [],
    new Map([
      ['a', { x: 0, y: 0, z: 0 }],
      ['b', { x: 0, y: 0, z: 0 }],
    ]),
  );
  for (let i = 0; i < 50; i += 1) step3(sim);
  const [a, b] = sim.nodes;
  assert.ok(a !== undefined && b !== undefined);
  assert.ok(Number.isFinite(a.x) && Number.isFinite(b.z));
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 0);
  assert.equal(sim.alpha < 1, true);
  const { nodes, edges } = ring(10);
  assert.deepEqual(createSimulation3(nodes, edges).nodes, createSimulation3(nodes, edges).nodes);
});

test('octree repulsion approximates the exact one; without a tree it is exact', () => {
  const { nodes, edges } = ring(120);
  const sim = createSimulation3(nodes, edges);
  for (let i = 0; i < 30; i += 1) step3(sim);
  const tree = buildOctree(sim.nodes);
  assert.ok(tree !== undefined);
  const exact = repulsion3On(7, sim.nodes, undefined, DEFAULT_PARAMS.charge, 1, DEFAULT_PARAMS.theta);
  const fine = repulsion3On(7, sim.nodes, tree, DEFAULT_PARAMS.charge, 1, 0.01);
  close(fine.x, exact.x, 1e-6);
  close(fine.z, exact.z, 1e-6);
  const rough = repulsion3On(7, sim.nodes, tree, DEFAULT_PARAMS.charge, 1, DEFAULT_PARAMS.theta);
  const size = Math.hypot(exact.x, exact.y, exact.z);
  assert.ok(Math.hypot(rough.x - exact.x, rough.y - exact.y, rough.z - exact.z) < size * 0.25);
  assert.equal(buildOctree([]), undefined);
  assert.deepEqual(repulsion3On(99, sim.nodes.slice(0, 3), undefined, -70, 1, 0.9), { x: 0, y: 0, z: 0 });
});

test('3D simulation above the Barnes-Hut threshold stays finite and spreads out', () => {
  const { nodes, edges } = ring(520);
  const sim = createSimulation3(nodes, edges);
  for (let i = 0; i < 20; i += 1) step3(sim);
  assert.ok(sim.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z)));
});

test('a node grazing the camera: radius capped, faded out, never hit', () => {
  const p = makeProjector(camera(), 800, 600);
  const out = emptyProjection(2);
  // 30 units in front of the camera (depth 30, between NEAR and NEAR_FADE), and one far away.
  projectNodes(p, [
    { x: 0, y: 0, z: 470, r: 18 },
    { x: 0, y: 0, z: 0, r: 4 },
  ], out);
  assert.equal(out.r[0], MAX_NODE_PX);
  assert.ok((out.depth[0] ?? 0) > NEAR && (out.depth[0] ?? 0) < NEAR_FADE);
  assert.equal(hitTest3(out, 2, 400, 300), 1, 'the far node behind it gets the click');
  assert.equal(nearFade(out.depth[0] ?? 0) < 1, true);
  // Far enough, the cap does not touch a normal node and it is hit.
  assert.ok((out.r[1] ?? 0) < MAX_NODE_PX);
  assert.equal(nearFade(NEAR), 0);
  assert.equal(nearFade(NEAR_FADE), 1);
  assert.equal(nearFade(NEAR_FADE + 500), 1);
});

test('segments are cut at the near plane; all behind, nothing', () => {
  const p = makeProjector(camera(), 800, 600);
  const seg = { x0: 0, y0: 0, x1: 0, y1: 0 };
  // From the target to a point behind the camera: the far end is cut, not flipped.
  assert.equal(projectSegment(p, 0, 0, 0, 100, 0, 1000, seg), true);
  close(seg.x0, 400);
  assert.ok(seg.x1 > 400, 'the cut end stays on the side it heads to');
  assert.ok(Number.isFinite(seg.x1) && Number.isFinite(seg.y1));
  assert.equal(projectSegment(p, 0, 0, 600, 10, 0, 700, seg), false);
  // All in front: the same as projecting the ends.
  assert.equal(projectSegment(p, -50, 0, 0, 50, 0, 0, seg), true);
  close(seg.x0, project(p, -50, 0, 0).x);
  close(seg.x1, project(p, 50, 0, 0).x);
});

test('projector and camera updates in place give the same result as fresh ones', () => {
  const a = camera({ yaw: 0.4, pitch: -0.3 });
  const reused = makeProjector(camera(), 10, 10);
  assert.deepEqual(updateProjector(reused, a, 800, 600, -100), makeProjector(a, 800, 600, -100));
  const from = camera({ yaw: 0.2 });
  const to = camera({ yaw: 1, distance: 200, target: { x: 30, y: 0, z: 0 } });
  const fresh = blendCamera(from, to, 0.4);
  // Into `from` itself: everything is read before anything is written.
  const same = copyCamera(from);
  assert.equal(blendCamera(same, to, 0.4, same), same);
  assert.deepEqual(same, fresh);
  const copy = copyCamera(from);
  copy.target.x = 99;
  assert.equal(from.target.x, 0, 'a copy shares nothing');
});

test('drift: halfway through the ramp it is at half speed', () => {
  close(driftWeight(DRIFT_IDLE_MS + 1_000), 0.5);
  const full = driftYaw(0, 50, 1);
  close(driftYaw(0, 50, 0.5), full / 2);
});

test('octree: bodies stacked on one point beyond the depth limit still count and push', () => {
  const nodes: SimNode3[] = [
    ...Array.from({ length: 3 }, () => ({ x: 5, y: 5, z: 5, vx: 0, vy: 0, vz: 0, r: 4 })),
    { x: 80, y: -20, z: 40, vx: 0, vy: 0, vz: 0, r: 4 },
  ];
  const tree = buildOctree(nodes);
  assert.equal(tree?.mass, 4);
  for (const i of [0, 3]) {
    const exact = repulsion3On(i, nodes, undefined, -70, 1, 0.9);
    const walked = repulsion3On(i, nodes, tree, -70, 1, 1e-6);
    close(walked.x, exact.x, 1e-9);
    close(walked.y, exact.y, 1e-9);
    close(walked.z, exact.z, 1e-9);
  }
});

test('3D simulation: a stored position that is not a number is not kept', () => {
  const sim = createSimulation3(
    [
      { id: 'a', degree: 0 },
      { id: 'b', degree: 0 },
    ],
    [],
    new Map([
      ['a', { x: Number.NaN, y: 0, z: 0 }],
      ['b', { x: 7, y: 8, z: 9 }],
    ]),
  );
  assert.ok(sim.nodes.every((node) => Number.isFinite(node.x)));
  assert.deepEqual([sim.nodes[1]?.x, sim.nodes[1]?.y, sim.nodes[1]?.z], [7, 8, 9]);
  for (let i = 0; i < 20; i += 1) step3(sim);
  assert.ok(sim.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z)));
});
