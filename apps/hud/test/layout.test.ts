import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gridColumns, loadLayout, panelIsColumn, saveLayout } from '../src/lib/layout.ts';

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

test('a collapsed bar takes no column: the page takes the whole width', () => {
  assert.equal(gridColumns({ sidebar: false, panel: false }), 'md:grid-cols-[264px_minmax(0,1fr)] 3xl:grid-cols-[264px_minmax(0,1fr)_300px]');
  assert.equal(gridColumns({ sidebar: true, panel: false }), 'md:grid-cols-[minmax(0,1fr)] 3xl:grid-cols-[minmax(0,1fr)_300px]');
  assert.equal(gridColumns({ sidebar: false, panel: true }), 'md:grid-cols-[264px_minmax(0,1fr)] 3xl:grid-cols-[264px_minmax(0,1fr)]');
  assert.equal(gridColumns({ sidebar: true, panel: true }), 'md:grid-cols-[minmax(0,1fr)] 3xl:grid-cols-[minmax(0,1fr)]');
});

test('the right bar is a column only on a wide screen: on a laptop it starts closed (D-150)', () => {
  assert.equal(panelIsColumn(1920), true);
  assert.equal(panelIsColumn(1600), true);
  assert.equal(panelIsColumn(1512), false);
  assert.equal(panelIsColumn(1440), false);
  assert.equal(panelIsColumn(1280), false);
});
