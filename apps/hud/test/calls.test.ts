import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callBlocker, calleeOf, callErrorText, clock, conversationCallee, draftCallee, receiptAnchors, receiptText, RING_TEXT, type CallInfo } from '../src/lib/calls.ts';
import { keyBytes, onThisMac } from '../src/lib/push.ts';

const call = (fields: Partial<CallInfo>): CallInfo => ({
  id: 'x',
  conversationId: 'c',
  direction: 'in',
  reason: null,
  taskId: null,
  status: 'ended',
  scheduledAt: null,
  createdAt: '2026-10-04T10:00:00Z',
  answeredAt: '2026-10-04T10:00:02Z',
  endedAt: '2026-10-04T10:03:09Z',
  endReason: 'hangup',
  delegations: 0,
  ...fields,
});

test('clock: minutes and seconds, hours past an hour', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(187.9), '3:07');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(clock(-5), '0:00');
});

test('receiptText: who called, how long, how it ended', () => {
  assert.equal(receiptText(call({})), 'Hai chiamato Arianna · 3:07');
  assert.equal(receiptText(call({ endReason: 'time-limit', delegations: 2 })), 'Hai chiamato Arianna · 3:07 · finita per il limite di tempo · 2 lavori passati ad Arianna');
  assert.equal(receiptText(call({ direction: 'out', reason: 'waiting', status: 'missed', answeredAt: null })), 'Arianna ti ha cercato: chiamata persa');
  assert.equal(receiptText(call({ status: 'active', endedAt: null, endReason: null })), 'Hai chiamato Arianna: in corso');
  assert.match(receiptText(call({ direction: 'out', reason: 'scheduled', status: 'skipped', endReason: 'quiet-hours' })), /fascia di silenzio/);
  assert.match(receiptText(call({ direction: 'out', reason: 'scheduled', status: 'skipped', endReason: 'agent-off' })), /l’agente non poteva rispondere/);
});

test('receiptAnchors: after the last message before the end; before everything when there is none', () => {
  const messages = [{ ts: '2026-10-04T09:00:00Z' }, { ts: '2026-10-04T10:01:00Z' }, { ts: '2026-10-04T11:00:00Z' }];
  const anchors = receiptAnchors(messages, [call({ id: 'a' }), call({ id: 'b', createdAt: '2026-10-04T08:00:00Z', endedAt: '2026-10-04T08:01:00Z' })]);
  assert.deepEqual(anchors.get(1)?.map(({ id }) => id), ['a']);
  assert.deepEqual(anchors.get(-1)?.map(({ id }) => id), ['b']);
});

test('callBlocker and callErrorText: the reasons in Italian', () => {
  assert.equal(callBlocker('up', false, false), undefined);
  assert.match(callBlocker('up', true, false) ?? '', /Ripristina/);
  assert.match(callBlocker('up', false, true) ?? '', /già una chiamata/);
  assert.match(callBlocker('off', false, false) ?? '', /\[voice\]/);
  assert.match(callBlocker('not-installed', false, false) ?? '', /provino/);
  assert.match(callErrorText('not-ready: assign and download: stt'), /Mancano dei modelli/);
  assert.equal(callErrorText('boom'), 'La chiamata non è partita.');
});

test('the incoming call says why it rings', () => {
  assert.match(RING_TEXT.waiting, /aspetta/);
});

test('push: the VAPID key in base64url becomes the 65 bytes the browser wants', () => {
  const point = Buffer.alloc(65, 7);
  point[0] = 4;
  assert.deepEqual([...keyBytes(point.toString('base64url'))], [...point]);
});

test('the page is on the Mac of the core only through the loopback address (D-128)', () => {
  assert.equal(onThisMac('127.0.0.1'), true);
  assert.equal(onThisMac('localhost'), true);
  assert.equal(onThisMac('arianna.tail1234.ts.net'), false);
  assert.equal(onThisMac('192.168.1.20'), false);
});

type Callable = Parameters<typeof conversationCallee>[0] & object;
const chat = (fields: Partial<Callable>): Callable => ({ mode: 'private', agent: null, origin: 'user', incognito: false, ...fields });

test('the phone (D-158): private chats with Arianna and direct chats with an agent, whatever the mode', () => {
  assert.equal(conversationCallee(chat({}))?.name, 'Arianna');
  assert.equal(conversationCallee(chat({}))?.agent, null);
  // A direct chat answers with its agent, private or work.
  assert.equal(conversationCallee(chat({ agent: 'traduttore' }))?.name, 'Traduttore');
  assert.equal(conversationCallee(chat({ mode: 'work', agent: 'coder' }))?.the, 'il Coder');
  assert.equal(conversationCallee(chat({ mode: 'work', agent: 'coder' }))?.agent, 'coder');
  // An older core without the incognito field: still a private chat.
  assert.equal(conversationCallee({ mode: 'private', agent: null, origin: 'user' })?.name, 'Arianna');
});

test('no phone (D-158): incognito, system chats, work chats with Arianna, no conversation', () => {
  assert.equal(conversationCallee(chat({ incognito: true })), undefined);
  assert.equal(conversationCallee(chat({ incognito: true, agent: 'traduttore' })), undefined);
  assert.equal(conversationCallee(chat({ origin: 'system' })), undefined);
  assert.equal(conversationCallee(chat({ mode: 'work' })), undefined);
  assert.equal(conversationCallee(undefined), undefined);
});

test('the phone on the empty page of a new conversation (D-158)', () => {
  assert.equal(draftCallee({ mode: 'private' })?.name, 'Arianna');
  assert.equal(draftCallee({ mode: 'work', agent: 'coder' })?.from, 'dal Coder');
  assert.equal(draftCallee({ mode: 'private', agent: 'traduttore' })?.from, 'da Traduttore');
  assert.equal(draftCallee({ mode: 'work' }), undefined);
  assert.equal(draftCallee({ mode: 'private', incognito: true }), undefined);
  assert.equal(draftCallee({ mode: 'work', agent: 'coder', incognito: true }), undefined);
  assert.equal(draftCallee(null), undefined);
});

test('who answers is said by name (D-158)', () => {
  assert.deepEqual(calleeOf(null), { agent: null, name: 'Arianna', the: 'Arianna', subject: 'Arianna', from: 'da Arianna' });
  assert.equal(calleeOf('arianna').agent, null);
  assert.equal(calleeOf('coder').subject, 'Il Coder');
  assert.equal(receiptText(call({}), calleeOf('coder')), 'Hai chiamato il Coder · 3:07');
  assert.equal(receiptText(call({ direction: 'out', status: 'missed', answeredAt: null }), calleeOf('traduttore')), 'Traduttore ti ha cercato: chiamata persa');
  assert.match(callErrorText('invalid: not a private or direct conversation'), /Qui non si può chiamare/);
  assert.match(callErrorText('agent-off: no local model can answer for oroscopo now'), /L’agente non può rispondere adesso/);
  assert.doesNotMatch(callErrorText('busy'), /Qui non si può chiamare/);
});
