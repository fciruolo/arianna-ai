import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canSendTo, labelOrDefault, LABELS, maxLabel } from '../src/index.ts';

test('labels are listed from least to most restricted', () => {
  assert.deepEqual(LABELS, ['L0', 'L1', 'L2', 'L3']);
});

test('default-deny: unlabeled data is L2, labeled data keeps its label', () => {
  assert.equal(labelOrDefault(undefined), 'L2');
  assert.equal(labelOrDefault('L0'), 'L0');
  assert.equal(labelOrDefault('L3'), 'L3');
});

test('maxLabel returns the most restricted label', () => {
  assert.equal(maxLabel('L0', 'L2', 'L1'), 'L2');
  assert.equal(maxLabel('L1', 'L1'), 'L1');
  assert.equal(maxLabel('L3', 'L0'), 'L3');
  assert.equal(maxLabel(), 'L0');
});

test('cloud executors receive L0 and L1, never L2 or L3', () => {
  assert.equal(canSendTo('cloud', 'L0'), true);
  assert.equal(canSendTo('cloud', 'L1'), true);
  assert.equal(canSendTo('cloud', 'L2'), false);
  assert.equal(canSendTo('cloud', 'L3'), false);
});

test('local models receive up to L2, never L3', () => {
  assert.equal(canSendTo('local', 'L0'), true);
  assert.equal(canSendTo('local', 'L2'), true);
  assert.equal(canSendTo('local', 'L3'), false);
});
