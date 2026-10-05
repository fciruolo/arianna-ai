import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stepsAnchors } from '../src/lib/activity-log.ts';
import { activityText, relativeTimeText, stepsButtonText } from '../src/lib/italian.ts';
import type { Message, Task, TaskStatus } from '../src/lib/types.ts';

function message(id: string, extra: Partial<Message> = {}): Message {
  return { id, conversationId: 'c1', ts: '', role: 'user', channel: 'web', label: 'L2', body: `m${id}`, taskId: null, agent: null, model: null, ...extra };
}

function task(id: string, status: TaskStatus): Task {
  return { id, conversationId: 'c1', title: id, status, effectiveLabel: 'L2', waitingReason: null, waitingApprovalId: null };
}

test('the steps button goes under the last answer of a settled task', () => {
  const messages = [
    message('1', { taskId: 't1' }),
    message('2', { role: 'assistant', taskId: 't1', agent: 'coder' }),
    message('3', { role: 'assistant', taskId: 't1' }),
  ];
  const anchors = stepsAnchors(messages, { t1: task('t1', 'done') }, { t1: 4 });
  assert.deepEqual([...anchors], [['3', { taskId: 't1', count: 4 }]]);
});

test('a system line about a task (D-109) never takes the steps button', () => {
  const messages = [
    message('1', { taskId: 't1' }),
    message('2', { role: 'assistant', taskId: 't1' }),
    message('3', { role: 'system', taskId: 't1', label: 'L0' }),
  ];
  const anchors = stepsAnchors(messages, { t1: task('t1', 'done') }, { t1: 3 });
  assert.deepEqual([...anchors], [['2', { taskId: 't1', count: 3 }]]);
});

test('a failed task without an answer gets the button under the question', () => {
  const anchors = stepsAnchors([message('1', { taskId: 't1' })], { t1: task('t1', 'failed') }, { t1: 2 });
  assert.deepEqual([...anchors], [['1', { taskId: 't1', count: 2 }]]);
});

test('no button for a task at work, unknown, without lines or without messages here', () => {
  const messages = [message('1', { taskId: 't1' }), message('2', { taskId: 't2' }), message('3', { taskId: 't3' })];
  const tasks = { t1: task('t1', 'running'), t2: task('t2', 'ready'), t3: task('t3', 'done'), t5: task('t5', 'done') };
  assert.equal(stepsAnchors(messages, tasks, { t1: 3, t2: 1, t3: 0, t4: 2, t5: 1 }).size, 0);
  // A waiting task is settled for the chat: its live card is gone.
  assert.equal(stepsAnchors(messages, { t1: task('t1', 'waiting_user') }, { t1: 3 }).get('1')?.count, 3);
});

test('the texts of the steps are Italian, with how long ago', () => {
  assert.equal(stepsButtonText(5, false), 'Mostra i passi (5)');
  assert.equal(stepsButtonText(5, true), 'Nascondi i passi');
  const now = new Date('2026-10-05T12:00:00Z');
  assert.equal(relativeTimeText('2026-10-05T11:59:30Z', now), 'adesso');
  assert.equal(relativeTimeText('2026-10-05T12:00:30Z', now), 'adesso');
  assert.equal(relativeTimeText('2026-10-05T11:57:00Z', now), '3 min fa');
  assert.equal(relativeTimeText('2026-10-05T10:00:00Z', now), '2 h fa');
  assert.equal(relativeTimeText('2026-10-04T10:00:00Z', now), 'ieri');
  assert.equal(relativeTimeText('2026-10-01T10:00:00Z', now), '4 giorni fa');
  assert.equal(relativeTimeText('non una data', now), '');
  // A saved line reads as the live one did.
  assert.equal(activityText({ id: '1', step: 2, kind: 'search', detail: 'fatture', label: 'L2', at: '2026-10-05T11:00:00Z' }), 'Cerco nella knowledge base: «fatture»');
});
