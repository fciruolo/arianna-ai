// Notifications of the web chat (I-1): when the page shows one, with which
// words, and that neither the page nor the service worker ever writes text
// of a conversation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { connectLive, type SocketLike } from '../src/lib/live.ts';
import { NOTICE_BODY, NOTICE_TITLE, noticeTag, noticeUrl, shouldShow } from '../src/lib/notices.ts';
import { parseServerMessage } from '../src/lib/protocol.ts';
import { notificationsBody, notificationsForm, notificationsProblem } from '../src/lib/settings.ts';
import { resolveSection, sectionDirty } from '../src/lib/settings-index.ts';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const SW = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('a notice frame: a known kind and a conversation id or null, nothing else', () => {
  assert.deepEqual(parseServerMessage(`{"type":"notice","kind":"reply","conversationId":"${ID}"}`), { type: 'notice', kind: 'reply', conversationId: ID });
  assert.deepEqual(parseServerMessage('{"type":"notice","kind":"failure","conversationId":null}'), { type: 'notice', kind: 'failure', conversationId: null });
  // Extra fields are dropped: a text never reaches the notification.
  assert.deepEqual(parseServerMessage(`{"type":"notice","kind":"approval","conversationId":"${ID}","text":"la fattura"}`), { type: 'notice', kind: 'approval', conversationId: ID });
  for (const raw of ['{"type":"notice","kind":"call","conversationId":null}', '{"type":"notice","kind":"reply","conversationId":"../x"}', '{"type":"notice","kind":"reply"}', '{"type":"notice"}']) {
    assert.equal(parseServerMessage(raw), undefined, raw);
  }
});

test('shouldShow: only with permission; hidden page always, visible page only for another conversation', () => {
  const view = { hidden: false, openConversation: ID, permission: 'granted' as const };
  assert.equal(shouldShow(ID, view), false, 'the user is reading it');
  assert.equal(shouldShow(OTHER, view), true);
  assert.equal(shouldShow(null, view), true);
  assert.equal(shouldShow(ID, { ...view, hidden: true }), true);
  assert.equal(shouldShow(OTHER, { ...view, permission: 'default' }), false);
  assert.equal(shouldShow(OTHER, { ...view, hidden: true, permission: 'denied' }), false);
  assert.equal(shouldShow(OTHER, { ...view, permission: 'unsupported' }), false);
});

test('the fixed words, the link and the tag shared with the service worker', () => {
  assert.deepEqual(NOTICE_TITLE, { reply: 'Arianna ha risposto', approval: 'Arianna aspetta una tua decisione', failure: 'Un lavoro è fallito' });
  assert.equal(noticeUrl(ID), `/c/${ID}`);
  assert.equal(noticeUrl(null), '/');
  assert.equal(noticeTag('reply', ID), `arianna-reply-${ID}`);
  for (const title of Object.values(NOTICE_TITLE)) assert.ok(SW.includes(`'${title}'`), title);
  assert.ok(SW.includes(`'${NOTICE_BODY}'`));
  assert.ok(SW.includes('`arianna-${notice.kind}-${notice.conversationId ?? \'home\'}`'));
});

test('the service worker never reads a push payload, and asks the core only for kind and conversation', () => {
  assert.doesNotMatch(SW, /event\.data/);
  assert.match(SW, /fetch\('\/api\/notifications\/latest'/);
  assert.doesNotMatch(SW, /title:\s*notice\./);
  assert.doesNotMatch(SW, /body:\s*notice\./);
});

test('the page tells the core whether it is in view, only once the socket is ready', () => {
  const sent: string[] = [];
  let socket: SocketLike | undefined;
  const connection = connectLive({
    url: 'ws://core/api/ws',
    onMessage: () => undefined,
    onState: () => undefined,
    createSocket: () => {
      socket = { onmessage: null, onclose: null, onerror: null, close: () => undefined, send: (data) => sent.push(data) };
      return socket;
    },
    setTimer: () => undefined,
    clearTimer: () => undefined,
    random: () => 0,
  });
  connection.sendVisibility(true);
  assert.deepEqual(sent, [], 'not ready yet');
  socket?.onmessage?.({ data: '{"type":"ready"}' });
  connection.sendVisibility(false);
  connection.sendVisibility(true);
  assert.deepEqual(sent, ['{"type":"visibility","visible":false}', '{"type":"visibility","visible":true}']);
  connection.close();
});

test('the Notifiche card: quiet hours as two times, back to "HH:MM-HH:MM" or null', () => {
  const form = notificationsForm({ replies: true, approvals: false, failures: true, quiet: '22:30-06:45' });
  assert.deepEqual(form, { replies: true, approvals: false, failures: true, quiet: true, quietFrom: '22:30', quietTo: '06:45' });
  assert.deepEqual(notificationsBody(form), { replies: true, approvals: false, failures: true, quiet: '22:30-06:45' });
  const none = notificationsForm({ replies: true, approvals: true, failures: true, quiet: null });
  assert.equal(none.quiet, false);
  assert.equal(notificationsBody(none).quiet, null);
  assert.equal(notificationsBody({ ...none, quiet: true }).quiet, '22:00-07:00', 'turned on: a proposal across midnight');
  assert.equal(notificationsProblem(none), undefined);
  assert.equal(notificationsProblem(form), undefined);
  assert.match(notificationsProblem({ ...form, quietTo: '22:30' }) ?? '', /ore diverse/);
  assert.match(notificationsProblem({ ...form, quietFrom: '' }) ?? '', /due ore/);
  assert.equal(notificationsProblem({ ...form, quiet: false, quietFrom: '' }), undefined);
});

test('the Notifiche section has its address and its unsaved edits', () => {
  assert.equal(resolveSection('notifiche').item.id, 'notifications');
  assert.equal(sectionDirty('notifications', (section) => section === 'notifications'), true);
  assert.equal(sectionDirty('notifications', (section) => section === 'voice'), false);
});
