import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canSendTo, isAtMost, isLabel, labelOrDefault, LABELS, maxLabel, type Label } from '../src/index.ts';

// Values that reach the policy from files or JSON despite the types.
const notALabel = (value: unknown): Label => value as Label;

test('labels are listed from least to most restricted', () => {
  assert.deepEqual(LABELS, ['L0', 'L1', 'L2', 'L3']);
});

test('isLabel accepts the four labels and nothing else', () => {
  assert.equal(isLabel('L0'), true);
  assert.equal(isLabel('L3'), true);
  assert.equal(isLabel('l2'), false);
  assert.equal(isLabel('L9'), false);
  assert.equal(isLabel(null), false);
});

test('default-deny: data without a valid label is L2, labeled data keeps its label', () => {
  assert.equal(labelOrDefault(undefined), 'L2');
  assert.equal(labelOrDefault(null), 'L2');
  assert.equal(labelOrDefault(''), 'L2');
  assert.equal(labelOrDefault('l0'), 'L2');
  assert.equal(labelOrDefault('L0'), 'L0');
  assert.equal(labelOrDefault('L3'), 'L3');
});

test('maxLabel returns the most restricted label', () => {
  assert.equal(maxLabel('L0', 'L2', 'L1'), 'L2');
  assert.equal(maxLabel('L1', 'L1'), 'L1');
  assert.equal(maxLabel('L3', 'L0'), 'L3');
  assert.equal(maxLabel(), 'L0');
});

test('isAtMost compares a label with a ceiling', () => {
  assert.equal(isAtMost('L1', 'L1'), true);
  assert.equal(isAtMost('L0', 'L2'), true);
  assert.equal(isAtMost('L2', 'L1'), false);
  assert.equal(isAtMost('L3', 'L2'), false);
  assert.throws(() => isAtMost(notALabel('L1 '), 'L3'), TypeError);
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

test('a value that is not a label stops the decision instead of ranking as harmless', () => {
  assert.throws(() => canSendTo('cloud', notALabel('L9')), TypeError);
  assert.throws(() => canSendTo('cloud', notALabel('l2')), TypeError);
  assert.throws(() => canSendTo('local', notALabel(null)), TypeError);
  assert.throws(() => maxLabel(notALabel('l3'), 'L1'), TypeError);
});
