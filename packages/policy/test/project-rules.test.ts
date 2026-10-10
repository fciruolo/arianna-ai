import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROJECT_RULES_LABEL, projectRulesFit } from '../src/index.ts';

test('the rules of a project are L1 by the user declaration (D-174)', () => {
  assert.equal(PROJECT_RULES_LABEL, 'L1');
});

test('projectRulesFit: L1 enters work delegations (L1) and private ones (L2 and above)', () => {
  assert.equal(projectRulesFit('L1'), true);
  assert.equal(projectRulesFit('L2'), true);
  assert.equal(projectRulesFit('L3'), true);
});

test('projectRulesFit: never an L0 task, nor a clearance that is not a label', () => {
  assert.equal(projectRulesFit('L0'), false);
  for (const clearance of [undefined, null, '', 'l1', 'L9', 1, {}, ['L1']]) assert.equal(projectRulesFit(clearance), false, JSON.stringify(clearance));
});
