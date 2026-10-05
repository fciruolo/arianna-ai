import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffLines, MAX_CELLS, splitLines } from '../src/line-diff.ts';

const lines = (count: number, prefix = 'line'): string => Array.from({ length: count }, (_value, index) => `${prefix} ${String(index + 1)}\n`).join('');

test('splitLines: a final newline makes no empty line; CRLF is a line end', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b']);
  assert.deepEqual(splitLines('\n'), ['']);
});

test('the same text has no hunk', () => {
  assert.deepEqual(diffLines('a\nb\n', 'a\nb\n'), { added: 0, removed: 0, hunks: [] });
  assert.deepEqual(diffLines('', ''), { added: 0, removed: 0, hunks: [] });
});

test('a changed line in the middle: removed then added, three lines of context', () => {
  const before = lines(10);
  const after = before.replace('line 5\n', 'line five\n');
  const diff = diffLines(before, after);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks.length, 1);
  const [hunk] = diff.hunks;
  assert.deepEqual([hunk?.oldStart, hunk?.oldLines, hunk?.newStart, hunk?.newLines], [2, 7, 2, 7]);
  assert.deepEqual(
    hunk?.lines.map((line) => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`),
    [' line 2', ' line 3', ' line 4', '-line 5', '+line five', ' line 6', ' line 7', ' line 8'],
  );
});

test('a new file is all added, a deleted one all removed, with unified starts', () => {
  const added = diffLines('', 'a\nb\n');
  assert.deepEqual([added.added, added.removed], [2, 0]);
  assert.deepEqual([added.hunks[0]?.oldStart, added.hunks[0]?.oldLines, added.hunks[0]?.newStart, added.hunks[0]?.newLines], [0, 0, 1, 2]);
  const removed = diffLines('a\nb\n', '');
  assert.deepEqual([removed.added, removed.removed], [0, 2]);
  assert.deepEqual([removed.hunks[0]?.oldStart, removed.hunks[0]?.oldLines, removed.hunks[0]?.newStart, removed.hunks[0]?.newLines], [1, 2, 0, 0]);
});

test('changes far apart make two hunks, close ones share one', () => {
  const before = lines(30);
  const far = before.replace('line 3\n', 'line three\n').replace('line 25\n', 'line twenty-five\n');
  assert.equal(diffLines(before, far).hunks.length, 2);
  const close = before.replace('line 3\n', 'line three\n').replace('line 9\n', 'line nine\n');
  const diff = diffLines(before, close);
  assert.equal(diff.hunks.length, 1);
  assert.deepEqual([diff.added, diff.removed], [2, 2]);
});

test('an insertion keeps the lines around it as context, not as changes', () => {
  const diff = diffLines('a\nb\nc\nd\n', 'a\nb\nnew\nc\nd\n');
  assert.deepEqual([diff.added, diff.removed], [1, 0]);
  const [hunk] = diff.hunks;
  assert.ok(hunk !== undefined);
  assert.deepEqual(
    hunk.lines.map((line) => line.kind),
    ['context', 'context', 'added', 'context', 'context'],
  );
  assert.deepEqual([hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines], [1, 4, 1, 5]);
});

test('scattered changes align on the common lines', () => {
  const diff = diffLines('a\nx\nb\ny\nc\n', 'a\nb\nz\nc\n');
  assert.deepEqual([diff.added, diff.removed], [1, 2]);
});

test('beyond the LCS table: all removed then all added, still counted right', () => {
  const side = Math.ceil(Math.sqrt(MAX_CELLS)) + 1;
  const diff = diffLines(lines(side, 'old'), lines(side, 'new'));
  assert.deepEqual([diff.added, diff.removed], [side, side]);
  assert.equal(diff.hunks.length, 1);
});

test('two changes share a hunk with up to twice the context between them, not more', () => {
  const before = lines(30);
  // 6 common lines between line 5 and line 12: one hunk; 7 between line 5 and line 13: two.
  const six = before.replace('line 5\n', 'five\n').replace('line 12\n', 'twelve\n');
  assert.equal(diffLines(before, six).hunks.length, 1);
  const seven = before.replace('line 5\n', 'five\n').replace('line 13\n', 'thirteen\n');
  assert.equal(diffLines(before, seven).hunks.length, 2);
});

test('without context a hunk holds only the changed lines', () => {
  const diff = diffLines(lines(10), lines(10).replace('line 4\n', 'four\n'), { context: 0 });
  assert.deepEqual(
    diff.hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines, hunk.lines.length]),
    [[4, 1, 4, 1, 2]],
  );
});

test('a smaller table budget falls back to all removed then all added', () => {
  const before = 'a\nx\nb\n';
  const after = 'a\ny\nb\nz\n';
  assert.deepEqual([diffLines(before, after).removed, diffLines(before, after).added], [1, 2]);
  const coarse = diffLines('x\ny\n', 'y\nx\n', { maxCells: 0 });
  assert.deepEqual([coarse.removed, coarse.added], [2, 2]);
  assert.deepEqual([diffLines('x\ny\n', 'y\nx\n').removed, diffLines('x\ny\n', 'y\nx\n').added], [1, 1]);
});
