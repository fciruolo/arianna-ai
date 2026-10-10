// The cardwall (I-13 tappe C1-C2, D-152): the column of a card and the moves the user makes by hand.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CARD_COLUMNS, columnOf, commitmentColumn, userMovesInto } from '../src/cardwall.ts';
import { TASK_STATUSES } from '../src/task-status.ts';

test('a card is in the column of its status; waiting_user is "waiting"', () => {
  assert.equal(columnOf('inbox', false), 'inbox');
  assert.equal(columnOf('ready', false), 'ready');
  assert.equal(columnOf('running', false), 'running');
  assert.equal(columnOf('waiting_user', false), 'waiting');
  assert.equal(columnOf('to_verify', false), 'to_verify');
  assert.equal(columnOf('done', false), 'done');
  assert.equal(columnOf('failed', false), 'failed');
  for (const status of TASK_STATUSES) assert.ok(CARD_COLUMNS.includes(columnOf(status, false)));
});

test('a card that waits for another one is in "waiting" until it can start; at work or closed it stays where it is', () => {
  assert.equal(columnOf('inbox', true), 'waiting');
  assert.equal(columnOf('ready', true), 'waiting');
  assert.equal(columnOf('running', true), 'running');
  assert.equal(columnOf('to_verify', true), 'to_verify');
  assert.equal(columnOf('done', true), 'done');
});

test('a commitment is to do while open, closed in any other status', () => {
  assert.equal(commitmentColumn('open'), 'ready');
  for (const status of ['done', 'not_done', 'postponed', 'cancelled'] as const) assert.equal(commitmentColumn(status), 'done');
});

test('by hand: never a card at work, never into the inbox, to_verify or running', () => {
  for (const to of TASK_STATUSES) assert.ok(!userMovesInto(to).includes('running'), to);
  assert.deepEqual(userMovesInto('inbox'), []);
  assert.deepEqual(userMovesInto('running'), []);
  assert.deepEqual(userMovesInto('to_verify'), []);
});

test('by hand: done from every open status; back to do from waiting, to verify or failed', () => {
  assert.deepEqual(userMovesInto('done'), ['inbox', 'ready', 'waiting_user', 'to_verify']);
  assert.ok(userMovesInto('ready').includes('failed'));
  // An agent's work waiting to be verified is closed or failed, never redone by hand.
  assert.ok(!userMovesInto('ready').includes('to_verify'));
  assert.ok(!userMovesInto('ready').includes('done'));
  assert.ok(!userMovesInto('failed').includes('done'));
  assert.ok(!userMovesInto('waiting_user').includes('to_verify'));
});
