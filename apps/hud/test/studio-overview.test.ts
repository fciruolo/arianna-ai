// The Studio without a project (D-194): the cards of the projects. Every name
// here is invented.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Mockup } from '../src/lib/studio.ts';
import { allotThumbs, overviewOf, overviewText, THUMB_PAGE, THUMBS_MAX, THUMBS_PAGE_MAX, thumbScale } from '../src/lib/studio-overview.ts';

function mockup(name: string, modified: string): Mockup {
  return { path: `mockups/${name}`, name, group: name.replace(/(-\d+)?\.html$/, ''), variant: null, bytes: 100, modified, sha256: 'x' };
}

test('overviewOf keeps the newest three, newest first', () => {
  const files = [
    mockup('a.html', '2026-10-01T10:00:00Z'),
    mockup('landing-4.html', '2026-10-12T10:00:00Z'),
    mockup('b.html', '2026-10-05T10:00:00Z'),
    mockup('c.html', '2026-10-08T10:00:00Z'),
  ];
  const overview = overviewOf(files);
  assert.equal(overview.count, 4);
  assert.equal(overview.latest?.name, 'landing-4.html');
  assert.deepEqual(overview.thumbs.map((file) => file.name), ['landing-4.html', 'c.html', 'b.html']);
  assert.equal(overview.thumbs.length, THUMBS_MAX);
});

test('overviewOf without mockups has no latest and no thumbs', () => {
  assert.deepEqual(overviewOf([]), { count: 0, latest: undefined, thumbs: [] });
});

test('overviewOf orders equal times by name and puts a bad date last', () => {
  const overview = overviewOf([mockup('z.html', 'nonsense'), mockup('b.html', '2026-10-01T10:00:00Z'), mockup('a.html', '2026-10-01T10:00:00Z')]);
  assert.deepEqual(overview.thumbs.map((file) => file.name), ['a.html', 'b.html', 'z.html']);
});

test('overviewText says how many and the latest', () => {
  const many = overviewOf([mockup('landing-4.html', '2026-10-12T10:00:00Z'), mockup('a.html', '2026-10-01T10:00:00Z')]);
  assert.equal(overviewText(many), '2 mockup · ultimo landing-4, 12 ott');
  const one = overviewOf([mockup('home.html', '2026-10-10T10:00:00Z')]);
  assert.equal(overviewText(one), '1 mockup · home, 10 ott');
});

test('overviewText without mockups invites to ask one, and skips a bad date', () => {
  assert.equal(overviewText(overviewOf([])), 'Nessun mockup: chiedine uno al Designer');
  assert.equal(overviewText(overviewOf([mockup('home.html', 'nonsense')])), '1 mockup · home');
});

test('thumbScale fits the page in the box, never above 1', () => {
  assert.equal(thumbScale(THUMB_PAGE.width / 4), 0.25);
  assert.equal(thumbScale(THUMB_PAGE.width * 2), 1);
  assert.equal(thumbScale(0), 0);
  assert.equal(thumbScale(Number.NaN), 0);
});

test('allotThumbs shares the frames of the page in the order of the cards', () => {
  assert.deepEqual(allotThumbs([3, 3, 3], 7), [3, 3, 1]);
  assert.deepEqual(allotThumbs([0, 2, 3], 4), [0, 2, 2]);
  assert.deepEqual(allotThumbs([3, 3], 0), [0, 0]);
  assert.equal(allotThumbs(Array.from({ length: 12 }, () => 3)).reduce((sum, count) => sum + count, 0), THUMBS_PAGE_MAX);
});
