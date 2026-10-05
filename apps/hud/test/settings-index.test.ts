import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeSection, TOP_SLACK } from '../src/lib/settings-index.ts';

const at = (...tops: number[]) => tops.map((top, index) => ({ id: `s${String(index)}`, top }));
const view = (tops: number[], extra: { pinned?: string } = {}) => ({ headings: at(...tops), zoneTop: 100, zoneBottom: 900, ...extra });

test('the lit entry is the last section whose heading reached the top of the zone', () => {
  assert.equal(activeSection(view([120, 600, 1400])), 's0');
  // Brought into view by a click: it stops 16 px under the top (scroll-mt-4), still the top one.
  assert.equal(activeSection(view([-500, 116, 700])), 's1');
  // A long section scrolled past its heading keeps the top until the next heading arrives.
  assert.equal(activeSection(view([-900, -300, 100 + TOP_SLACK + 1])), 's1');
  assert.equal(activeSection(view([-900, -300, 100 + TOP_SLACK])), 's2');
});

test('before the first heading the first section is lit; nothing without sections', () => {
  assert.equal(activeSection(view([400, 900])), 's0');
  assert.equal(activeSection(view([])), undefined);
});

test('a section is not lit just because its heading is the nearest below the top', () => {
  // s1's heading is in view and s0's is above, yet s0 still fills the top of the zone.
  assert.equal(activeSection(view([-50, 200])), 's0');
});

test('the clicked entry stays lit while its section is in view, even when it cannot reach the top', () => {
  // At the bottom of the page the last short sections stop lower down.
  assert.equal(activeSection(view([-800, 300, 600], { pinned: 's2' })), 's2');
  // Out of view: the position decides again.
  assert.equal(activeSection(view([-800, -400, -100], { pinned: 's0' })), 's2');
  assert.equal(activeSection(view([-800, 300, 950], { pinned: 's2' })), 's0');
  assert.equal(activeSection(view([120, 600], { pinned: 'missing' })), 's0');
});
