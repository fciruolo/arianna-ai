import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LABELS } from '../src/index.ts';

test('labels are listed from least to most restricted', () => {
  assert.deepEqual(LABELS, ['L0', 'L1', 'L2', 'L3']);
});
