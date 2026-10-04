import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gridColumns, loadLayout, saveLayout } from '../src/lib/layout.ts';

test('collapsed bars are remembered when storage works', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  assert.deepEqual(loadLayout(storage), { sidebar: false, panel: false });
  saveLayout(storage, { sidebar: true, panel: false });
  assert.deepEqual(loadLayout(storage), { sidebar: true, panel: false });
});

test('a broken storage or an unexpected value means both bars open, never an error', () => {
  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(loadLayout(broken), { sidebar: false, panel: false });
  assert.doesNotThrow(() => {
    saveLayout(broken, { sidebar: true, panel: true });
  });
  assert.deepEqual(loadLayout(undefined), { sidebar: false, panel: false });
  for (const raw of ['not json', 'null', '"yes"', '{"sidebar":"true","panel":1}']) {
    assert.deepEqual(loadLayout({ getItem: () => raw, setItem: () => undefined }), { sidebar: false, panel: false });
  }
});

test('the grid drops the column of each collapsed bar', () => {
  assert.equal(gridColumns({ sidebar: false, panel: false }), 'md:grid-cols-[56px_248px_minmax(0,1fr)] xl:grid-cols-[56px_248px_minmax(0,1fr)_300px]');
  assert.equal(gridColumns({ sidebar: true, panel: false }), 'md:grid-cols-[56px_minmax(0,1fr)] xl:grid-cols-[56px_minmax(0,1fr)_300px]');
  assert.equal(gridColumns({ sidebar: false, panel: true }), 'md:grid-cols-[56px_248px_minmax(0,1fr)] xl:grid-cols-[56px_248px_minmax(0,1fr)]');
  assert.equal(gridColumns({ sidebar: true, panel: true }), 'md:grid-cols-[56px_minmax(0,1fr)] xl:grid-cols-[56px_minmax(0,1fr)]');
});
