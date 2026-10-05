// The files of a delegated run kept for the chat (D-082): what the database would refuse is left out.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_STORED_FILES, storableFiles } from '../src/orchestrator/delegate.ts';

test('relative paths with a known kind are kept as they are', () => {
  assert.deepEqual(
    storableFiles([
      { path: 'README.md', change: 'modified' },
      { path: 'src/new.ts', change: 'added' },
      { path: 'docs/b.md', change: 'renamed', from: 'docs/a.md' },
      { path: 'old.txt', change: 'deleted' },
      { path: '..hidden/x', change: 'added' },
    ]),
    [
      { path: 'README.md', change: 'modified' },
      { path: 'src/new.ts', change: 'added' },
      { path: 'docs/b.md', change: 'renamed', from: 'docs/a.md' },
      { path: 'old.txt', change: 'deleted' },
      { path: '..hidden/x', change: 'added' },
    ],
  );
});

test('absolute paths, parent segments, control characters and odd entries are left out', () => {
  const parent = ['..', 'x'].join('/');
  assert.deepEqual(
    storableFiles([
      { path: '/etc/hosts', change: 'modified' },
      { path: parent, change: 'added' },
      { path: ['a', '..', 'b'].join('/'), change: 'added' },
      { path: 'a\nb', change: 'added' },
      { path: '', change: 'added' },
      { path: 'a.txt', change: 'renamed' },
      { path: 'b.txt', change: 'added', from: 'c.txt' },
      { path: 'c.txt', change: 'renamed', from: parent },
      { path: 'ok.txt', change: 'added' },
    ]),
    [{ path: 'ok.txt', change: 'added' }],
  );
});

test('at most MAX_STORED_FILES are kept', () => {
  const many = Array.from({ length: MAX_STORED_FILES + 20 }, (_, index) => ({ path: `f${String(index)}.txt`, change: 'added' as const }));
  assert.equal(storableFiles(many).length, MAX_STORED_FILES);
});
