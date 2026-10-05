import assert from 'node:assert/strict';
import { test } from 'node:test';

import { personaFits, personaLabel } from '../src/index.ts';

test('personaLabel: L1 only when declared exactly', () => {
  assert.equal(personaLabel('L1'), 'L1');
});

test('personaLabel: default-deny, anything else is L2', () => {
  for (const declared of [undefined, null, '', 'l1', 'L0', 'L2', 'L3', 1, {}, ['L1']]) {
    assert.equal(personaLabel(declared), 'L2', JSON.stringify(declared));
  }
});

test('personaFits: the text enters when its label does not exceed the clearance', () => {
  assert.equal(personaFits('L1', 'L1'), true);
  assert.equal(personaFits('L1', 'L2'), true);
  assert.equal(personaFits(undefined, 'L2'), true);
  assert.equal(personaFits('L2', 'L2'), true);
});

test('personaFits: the text is dropped above the clearance, always with L0 or no valid clearance', () => {
  // L2 by default: not in a work (L1) or cloud step.
  assert.equal(personaFits(undefined, 'L1'), false);
  assert.equal(personaFits('L2', 'L1'), false);
  // An L0 agent never reads the user's text, declared or not.
  assert.equal(personaFits('L1', 'L0'), false);
  assert.equal(personaFits(undefined, 'L0'), false);
  // A declaration of L0 is not a declaration: it stays L2.
  assert.equal(personaFits('L0', 'L0'), false);
  assert.equal(personaFits('L0', 'L1'), false);
  for (const clearance of [undefined, null, '', 'l2', 'L9', 2]) assert.equal(personaFits('L1', clearance), false, String(clearance));
});
