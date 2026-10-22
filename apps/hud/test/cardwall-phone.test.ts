// The cardwall on the phone (D-293): which column is shown, and the one beside it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { neighbourColumn, phoneColumn } from '../src/lib/cardwall-phone.ts';

const columns = [{ id: 'todo' }, { id: 'running' }, { id: 'done' }];
const counts: Record<string, number> = { todo: 0, running: 2, done: 5 };
const count = (id: string): number => counts[id] ?? 0;

test('phoneColumn keeps the column the user chose while it is on the wall', () => {
  assert.equal(phoneColumn(columns, 'done', count), 'done');
  assert.equal(phoneColumn(columns, 'todo', count), 'todo');
});

test('phoneColumn falls back to the first column with cards when the choice is hidden or missing', () => {
  assert.equal(phoneColumn(columns, null, count), 'running');
  assert.equal(phoneColumn(columns, 'waiting', count), 'running');
});

test('phoneColumn takes the first column when none has cards, null without columns', () => {
  assert.equal(phoneColumn(columns, null, () => 0), 'todo');
  assert.equal(phoneColumn([], 'todo', count), null);
});

test('neighbourColumn steps to the column beside, null at the ends or for an unknown one', () => {
  assert.equal(neighbourColumn(columns, 'running', 1), 'done');
  assert.equal(neighbourColumn(columns, 'running', -1), 'todo');
  assert.equal(neighbourColumn(columns, 'done', 1), null);
  assert.equal(neighbourColumn(columns, 'todo', -1), null);
  assert.equal(neighbourColumn(columns, 'waiting', 1), null);
  assert.equal(neighbourColumn(columns, null, 1), null);
});
