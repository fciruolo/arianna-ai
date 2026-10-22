import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentAt, compactScale, compactView, rosterOrder, TOUCH_PAD } from '../src/lib/office/phone.ts';
import type { Pose } from '../src/lib/sprites.ts';

const WORLD_W = 36 * 16;
const WORLD_H = 21 * 16;

test('on the phone the plan keeps whole pixels: scale 1 and a sideways scroll when it does not fit', () => {
  assert.equal(compactScale(358, WORLD_W), 1);
  assert.equal(compactScale(1200, WORLD_W), 2);
  assert.equal(compactScale(10_000, WORLD_W), 4);
});

test('the phone scale never goes below 1, not even with a width not yet measured', () => {
  assert.equal(compactScale(0, WORLD_W), 1);
  assert.equal(compactScale(Number.NaN, WORLD_W), 1);
  assert.equal(compactScale(358, 0), 1);
});

test('the phone window is as wide as the page and as tall as the whole map', () => {
  assert.deepEqual(compactView(358, WORLD_W, WORLD_H, 1), { viewW: 358, viewH: WORLD_H });
  assert.deepEqual(compactView(700, WORLD_W, WORLD_H, 1), { viewW: WORLD_W, viewH: WORLD_H });
});

test('the phone window never gets a negative or fractional width', () => {
  assert.deepEqual(compactView(-5, WORLD_W, WORLD_H, 1), { viewW: 0, viewH: WORLD_H });
  assert.equal(compactView(358.7, WORLD_W, WORLD_H, 1).viewW, 358);
});

const AGENTS = [
  { id: 'arianna', x: 100, y: 100 },
  { id: 'coder', x: 112, y: 100 },
];

test('without pad a click hits the exact box of the figure, the first one as before', () => {
  assert.equal(agentAt(AGENTS, 100, 90), 'arianna');
  assert.equal(agentAt(AGENTS, 106, 90), 'arianna');
  assert.equal(agentAt(AGENTS, 119, 75), 'coder');
});

test('without pad a click just outside the box hits nobody', () => {
  assert.equal(agentAt(AGENTS, 91, 90), null);
  assert.equal(agentAt(AGENTS, 100, 101), null);
  assert.equal(agentAt(AGENTS, 100, 69), null);
});

test('a tap gets a wider box and goes to the closest agent', () => {
  assert.equal(agentAt(AGENTS, 91, 90, TOUCH_PAD), 'arianna');
  assert.equal(agentAt(AGENTS, 100, 105, TOUCH_PAD), 'arianna');
  assert.equal(agentAt(AGENTS, 109, 85, TOUCH_PAD), 'coder');
});

test('a tap far from every agent hits nobody', () => {
  assert.equal(agentAt(AGENTS, 60, 90, TOUCH_PAD), null);
  assert.equal(agentAt([], 100, 90, TOUCH_PAD), null);
});

test('the phone list puts first who waits, then who works, then who is free, then who pauses', () => {
  const agents: { id: string; pose: Pose }[] = [
    { id: 'a', pose: 'idle' },
    { id: 'b', pose: 'paused' },
    { id: 'c', pose: 'working' },
    { id: 'd', pose: 'waiting' },
    { id: 'e', pose: 'reading' },
  ];
  assert.deepEqual(rosterOrder(agents).map((agent) => agent.id), ['d', 'c', 'e', 'a', 'b']);
  assert.equal(agents[0]?.id, 'a', 'the input is not reordered');
});

test('the phone list keeps the page order within the same group', () => {
  const agents: { id: string; pose: Pose }[] = [
    { id: 'x', pose: 'idle' },
    { id: 'y', pose: 'idle' },
    { id: 'z', pose: 'idle' },
  ];
  assert.deepEqual(rosterOrder(agents).map((agent) => agent.id), ['x', 'y', 'z']);
  assert.deepEqual(rosterOrder([]), []);
});
