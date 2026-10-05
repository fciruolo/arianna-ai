import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PERSONA_LABEL, personaFits } from '../src/index.ts';

test('the persona text is L1 by the user declaration (D-107)', () => {
  assert.equal(PERSONA_LABEL, 'L1');
});

test('personaFits: L1 enters work and cloud steps (L1) and private ones (L2 and above)', () => {
  assert.equal(personaFits('L1'), true);
  assert.equal(personaFits('L2'), true);
  assert.equal(personaFits('L3'), true);
});

test('personaFits: never an L0 agent or task, nor a clearance that is not a label', () => {
  assert.equal(personaFits('L0'), false);
  for (const clearance of [undefined, null, '', 'l1', 'L9', 1, {}, ['L1']]) assert.equal(personaFits(clearance), false, JSON.stringify(clearance));
});
