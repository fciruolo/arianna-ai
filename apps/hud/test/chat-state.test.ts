import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activityLines, applyActivity, applyDelta, applyEdit, emptyChat, liveEditRows, liveEdits, mergeMessages, restoreActivity, settleReply, taskIds } from '../src/lib/chat-state.ts';
import { activityText } from '../src/lib/italian.ts';
import type { Activity, Delta, EditPiece, Message, SavedActivity } from '../src/lib/types.ts';

const CONVERSATION = 'c1';

function message(id: string, extra: Partial<Message> = {}): Message {
  return { id, conversationId: CONVERSATION, ts: '', role: 'user', channel: 'web', label: 'L2', body: `m${id}`, taskId: null, agent: null, model: null, ...extra };
}

function delta(seq: number, text: string, extra: Partial<Delta> = {}): Delta {
  return { replyId: 'r1', conversationId: CONVERSATION, taskId: 't1', seq, text, ...extra };
}

test('messages merge without duplicates, in numeric id order', () => {
  let state = mergeMessages(emptyChat(CONVERSATION), [message('10'), message('9')]);
  state = mergeMessages(state, [message('10', { body: 'updated' }), message('11')]);
  assert.deepEqual(state.messages.map((item) => item.id), ['9', '10', '11']);
  assert.equal(state.messages[1]?.body, 'updated');
});

test('messages of another conversation are ignored', () => {
  const state = mergeMessages(emptyChat(CONVERSATION), [message('1', { conversationId: 'other' })]);
  assert.deepEqual(state.messages, []);
});

test('fragments build the answer in order, even when they arrive out of order', () => {
  let state = applyDelta(emptyChat(CONVERSATION), delta(0, 'Ciao'));
  state = applyDelta(state, delta(2, ' mondo'));
  assert.equal(state.streaming[0]?.text, 'Ciao');
  state = applyDelta(state, delta(1, ','));
  assert.equal(state.streaming[0]?.text, 'Ciao, mondo');
  // A repeated fragment changes nothing.
  assert.equal(applyDelta(state, delta(1, ',')), state);
});

test('fragments of another conversation are ignored', () => {
  const state = emptyChat(CONVERSATION);
  assert.equal(applyDelta(state, delta(0, 'x', { conversationId: 'other' })), state);
});

test('the stored message replaces the answer being written', () => {
  const state = applyDelta(emptyChat(CONVERSATION), delta(0, 'Ciao'));
  assert.deepEqual(settleReply(state, 'r1').streaming, []);
  assert.equal(settleReply(state, 'unknown'), state);
});

test('task ids come from the messages, once each', () => {
  const state = mergeMessages(emptyChat(CONVERSATION), [
    message('1', { taskId: 't1' }),
    message('2', { role: 'assistant', taskId: 't1' }),
    message('3', { taskId: 't2' }),
    message('4'),
  ]);
  assert.deepEqual(taskIds(state), ['t1', 't2']);
});

test('activity lines: per task of this conversation, the latest "thinking" only, no repeats', () => {
  const line = (step: number, kind: Activity['kind'], detail = '', conversationId = 'c1'): Activity => ({ conversationId, taskId: 't1', step, kind, detail });
  let state = emptyChat('c1');
  state = applyActivity(state, line(1, 'thinking'));
  state = applyActivity(state, line(1, 'search', 'caldaia'));
  state = applyActivity(state, line(1, 'search', 'caldaia'));
  state = applyActivity(state, line(2, 'thinking'));
  assert.deepEqual(
    state.activity.t1?.map((item) => [item.step, item.kind]),
    [
      [1, 'search'],
      [2, 'thinking'],
    ],
  );
  state = applyActivity(state, line(2, 'read', 'kb/private/casa/caldaia.md'));
  assert.deepEqual(
    state.activity.t1?.map((item) => item.kind),
    ['search', 'read'],
  );
  assert.equal(applyActivity(state, line(3, 'thinking', '', 'other')), state, 'another conversation');
});

test('after a reload the saved lines of a task at work come back, the live ones after them once', () => {
  const saved = (step: number, kind: SavedActivity['kind'], detail: string): SavedActivity => ({ id: String(step), step, kind, detail, label: 'L2', at: '2026-10-05T10:00:00Z' });
  const live = (step: number, kind: Activity['kind'], detail = ''): Activity => ({ conversationId: 'c1', taskId: 't1', step, kind, detail });
  let state = applyActivity(emptyChat('c1'), live(2, 'read', 'kb/a.md'));
  state = applyActivity(state, live(3, 'thinking'));
  state = restoreActivity(state, 't1', [saved(1, 'search', 'caldaia'), saved(2, 'read', 'kb/a.md')]);
  assert.deepEqual(
    state.activity.t1?.map((item) => [item.step, item.kind, item.detail]),
    [
      [1, 'search', 'caldaia'],
      [2, 'read', 'kb/a.md'],
      [3, 'thinking', ''],
    ],
  );
  assert.deepEqual([...new Set(state.activity.t1.map((item) => item.conversationId))], ['c1']);
  // Again with the same lines: the same result.
  assert.deepEqual(restoreActivity(state, 't1', [saved(1, 'search', 'caldaia'), saved(2, 'read', 'kb/a.md')]), state);
  // A live "thinking" of a step the saved lines went past is dropped.
  const stale = restoreActivity(applyActivity(emptyChat('c1'), live(1, 'thinking')), 't1', [saved(2, 'read', 'kb/b.md')]);
  assert.deepEqual(stale.activity.t1?.map((item) => item.kind), ['read']);
  // At most 30 lines: the oldest go.
  const many = restoreActivity(emptyChat('c1'), 't1', Array.from({ length: 35 }, (_, index) => saved(index + 1, 'search', `q${String(index)}`)));
  assert.equal(many.activity.t1?.length, 30);
  assert.deepEqual(many.activity.t1.slice(0, 1).map((item) => item.detail), ['q5']);
  // Nothing saved and nothing live: unchanged.
  const empty = emptyChat('c1');
  assert.equal(restoreActivity(empty, 't1', []), empty);
});

test('the card of a task: its lines while queued or running, a waiting line before any, nothing once stopped', () => {
  const state = restoreActivity(emptyChat('c1'), 't1', [{ id: '1', step: 1, kind: 'search', detail: 'caldaia', label: 'L2', at: '2026-10-05T10:00:00Z' }]);
  assert.deepEqual(activityLines(state, 't1', 'running').map((line) => line.kind), ['search']);
  assert.deepEqual(activityLines(state, 't1', 'done'), []);
  assert.deepEqual(activityLines(state, 't1', 'failed'), []);
  const waiting = activityLines(emptyChat('c1'), 't1', 'running');
  assert.deepEqual(waiting.map((line) => [line.step, line.kind]), [[0, 'thinking']]);
  assert.deepEqual(waiting.map(activityText), ['Sto lavorando…']);
  assert.deepEqual(activityLines(emptyChat('c1'), 't1', 'ready').map(activityText), ['In coda…']);
  assert.deepEqual(activityLines(emptyChat('c1'), 't1', undefined), [], 'task not loaded yet: nothing invented');
});

function piece(seq: number, total: number, text: string, extra: Partial<EditPiece> = {}): EditPiece {
  return { editId: 'e1', conversationId: CONVERSATION, taskId: 't1', step: 2, path: 'src/a.ts', tool: 'Edit', label: 'L1', added: 1, removed: 1, seq, total, text, ...extra };
}

test('the rows of a live change: removed, added, context and gaps (D-117)', () => {
  assert.deepEqual(liveEditRows(' a\n-b\n+c\n@\n+'), [
    { kind: 'context', text: 'a' },
    { kind: 'removed', text: 'b' },
    { kind: 'added', text: 'c' },
    { kind: 'gap', text: '' },
    { kind: 'added', text: '' },
  ]);
  assert.deepEqual(liveEditRows(''), []);
});

test('a live change shows once all its pieces arrived, in any order, only while its task works', () => {
  let state = applyEdit(emptyChat(CONVERSATION), piece(1, 2, 'c'));
  assert.deepEqual(liveEdits(state, 't1', 'running'), []);
  state = applyEdit(state, piece(0, 2, '-b\n+'));
  const [edit] = liveEdits(state, 't1', 'running');
  assert.deepEqual(edit?.rows, [
    { kind: 'removed', text: 'b' },
    { kind: 'added', text: 'c' },
  ]);
  assert.equal(edit.path, 'src/a.ts');
  // A repeated piece changes nothing; a stopped task shows no live change.
  assert.equal(applyEdit(state, piece(0, 2, '-b\n+')), state);
  assert.deepEqual(liveEdits(state, 't1', 'done'), []);
  assert.deepEqual(liveEdits(state, 't1', 'failed'), []);
});

test('a live change of another conversation, or with too many pieces, is dropped; an error shows no rows', () => {
  const empty = emptyChat(CONVERSATION);
  assert.equal(applyEdit(empty, piece(0, 1, '+x', { conversationId: 'other' })), empty);
  assert.equal(applyEdit(empty, piece(0, 1000, '+x')), empty);
  const refused = applyEdit(empty, piece(0, 1, '', { error: 'refused' }));
  assert.deepEqual(liveEdits(refused, 't1', 'running').map((edit) => [edit.error, edit.rows]), [['refused', []]]);
});

test('at most ten live changes per task are kept, the latest', () => {
  let state = emptyChat(CONVERSATION);
  for (let index = 0; index < 12; index += 1) state = applyEdit(state, piece(0, 1, '+x', { editId: `e${String(index)}` }));
  assert.deepEqual(
    liveEdits(state, 't1', 'running').map((edit) => edit.editId),
    ['e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11'],
  );
});
