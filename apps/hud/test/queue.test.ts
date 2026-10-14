import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isWorking, queueHint, stoppedTasks, STOPPED_TEXT } from '../src/lib/queue.ts';

test('an answer is at work while a task is ready or running; waiting, done or failed ones are not (D-218)', () => {
  assert.equal(isWorking({ a: { status: 'running' } }), true);
  assert.equal(isWorking({ a: { status: 'done' }, b: { status: 'ready' } }), true);
  assert.equal(isWorking({ a: { status: 'waiting_user' }, b: { status: 'failed' }, c: { status: 'done' } }), false);
  assert.equal(isWorking({}), false);
});

test('a task is stopped by the user only with the line of the core under it, and only until it is retried', () => {
  const at = '2026-10-15T01:00:00.000Z';
  const later = '2026-10-15T01:05:00.000Z';
  const ids = stoppedTasks(
    [
      { role: 'system', body: STOPPED_TEXT, taskId: 't1', ts: at },
      // The same words written by the user, or a line without its task, do not count.
      { role: 'user', body: STOPPED_TEXT, taskId: 't2', ts: at },
      { role: 'system', body: STOPPED_TEXT, taskId: null, ts: at },
      { role: 'system', body: 'Arianna aggiunge coder', taskId: 't3', ts: at },
      // Retried after the stop and failed again for another reason: a real failure.
      { role: 'system', body: STOPPED_TEXT, taskId: 't4', ts: at },
      // Retried and at work again.
      { role: 'system', body: STOPPED_TEXT, taskId: 't5', ts: at },
    ],
    {
      t1: { status: 'failed', updatedAt: at },
      t2: { status: 'failed', updatedAt: at },
      t3: { status: 'failed', updatedAt: at },
      t4: { status: 'failed', updatedAt: later },
      t5: { status: 'running', updatedAt: later },
    },
  );
  assert.deepEqual([...ids], ['t1']);
});

test('the hint above the queue says why the messages still wait', () => {
  assert.match(queueHint({ paused: true }, true, true), /In pausa/);
  assert.match(queueHint({ paused: false }, true, true), /decis/);
  assert.match(queueHint({ paused: false }, true, false), /uno alla volta/);
  assert.match(queueHint({ paused: false }, false, false), /fra un istante/);
});
