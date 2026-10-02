import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyDelta, emptyChat, mergeMessages, settleReply, taskIds } from '../src/lib/chat-state.ts';
import type { Delta, Message } from '../src/lib/types.ts';

const CONVERSATION = 'c1';

function message(id: string, extra: Partial<Message> = {}): Message {
  return { id, conversationId: CONVERSATION, ts: '', role: 'user', channel: 'web', label: 'L2', body: `m${id}`, taskId: null, ...extra };
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
