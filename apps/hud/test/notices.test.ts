// Notifications of the web chat (I-1): when the page shows one, with which
// words, and that neither the page nor the service worker ever writes text
// of a conversation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { connectLive, type SocketLike } from '../src/lib/live.ts';
import { NOTICE_BODY, NOTICE_ICON, NOTICE_TITLE, noticeTag, noticeUrl, noticeWhere, pushToast } from '../src/lib/notices.ts';
import { parseServerMessage } from '../src/lib/protocol.ts';
import { notificationsBody, notificationsForm, notificationsProblem } from '../src/lib/settings.ts';
import { resolveSection, sectionDirty } from '../src/lib/settings-index.ts';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const SW = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('a notice frame: a known kind and a conversation id or null, nothing else', () => {
  assert.deepEqual(parseServerMessage(`{"type":"notice","kind":"reply","conversationId":"${ID}"}`), { type: 'notice', kind: 'reply', conversationId: ID });
  assert.deepEqual(parseServerMessage('{"type":"notice","kind":"failure","conversationId":null}'), { type: 'notice', kind: 'failure', conversationId: null });
  assert.deepEqual(parseServerMessage('{"type":"notice","kind":"reply","conversationId":null,"helper":true}'), { type: 'notice', kind: 'reply', conversationId: null, helper: true });
  assert.deepEqual(parseServerMessage('{"type":"notice","kind":"reply","conversationId":null,"helper":"yes"}'), { type: 'notice', kind: 'reply', conversationId: null });
  // Extra fields are dropped: a text never reaches the notification.
  assert.deepEqual(parseServerMessage(`{"type":"notice","kind":"approval","conversationId":"${ID}","text":"la fattura"}`), { type: 'notice', kind: 'approval', conversationId: ID });
  for (const raw of ['{"type":"notice","kind":"call","conversationId":null}', '{"type":"notice","kind":"reply","conversationId":"../x"}', '{"type":"notice","kind":"reply"}', '{"type":"notice"}']) {
    assert.equal(parseServerMessage(raw), undefined, raw);
  }
  // A trial is marked only by true.
  assert.deepEqual(parseServerMessage('{"type":"notice","kind":"reply","conversationId":null,"trial":true}'), { type: 'notice', kind: 'reply', conversationId: null, trial: true });
  assert.deepEqual(parseServerMessage('{"type":"notice","kind":"reply","conversationId":null,"trial":"yes"}'), { type: 'notice', kind: 'reply', conversationId: null });
});

test('noticeWhere: one place only, the system notification when allowed, the toast without it, nothing for the open conversation', () => {
  const view = { hidden: false, openConversation: ID, permission: 'granted' as const };
  assert.deepEqual(noticeWhere(ID, view), { toast: false, system: false }, 'the user is reading it');
  assert.deepEqual(noticeWhere(OTHER, view), { toast: false, system: true }, 'the system notification, not both');
  assert.deepEqual(noticeWhere(null, view), { toast: false, system: true });
  assert.deepEqual(noticeWhere(OTHER, { ...view, permission: 'default' }), { toast: true, system: false }, 'without the permission, the toast');
  assert.deepEqual(noticeWhere(OTHER, { ...view, permission: 'unsupported' }), { toast: true, system: false });
  assert.deepEqual(noticeWhere(ID, { ...view, hidden: true }), { toast: false, system: true }, 'hidden, it is not being read');
  assert.deepEqual(noticeWhere(ID, { ...view, hidden: true, permission: 'denied' }), { toast: false, system: false });
  // A trial has no conversation: the same rule as a real notice, one place only.
  assert.deepEqual(noticeWhere(null, { ...view, openConversation: null }), { toast: false, system: true });
  assert.deepEqual(noticeWhere(null, { ...view, openConversation: null, permission: 'default' }), { toast: true, system: false });
});

test('the fixed words, the link and the tag shared with the service worker', () => {
  assert.deepEqual(NOTICE_TITLE, { reply: 'Arianna ha risposto', approval: 'Arianna aspetta una tua decisione', failure: 'Un lavoro è fallito', reminder: 'Arianna ha un promemoria' });
  assert.equal(noticeUrl(ID), `/c/${ID}`);
  assert.equal(noticeUrl(null), '/');
  assert.equal(noticeTag('reply', ID), `arianna-reply-${ID}`);
  for (const title of Object.values(NOTICE_TITLE)) assert.ok(SW.includes(`'${title}'`), title);
  for (const body of Object.values(NOTICE_BODY)) assert.ok(SW.includes(`'${body}'`), body);
  assert.ok(SW.includes(`'${NOTICE_ICON}'`));
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
  connection.sendVisibility(true, true, null);
  assert.deepEqual(sent, [], 'not ready yet');
  socket?.onmessage?.({ data: '{"type":"ready"}' });
  connection.sendVisibility(false, false, null);
  connection.sendVisibility(true, false, ID);
  assert.deepEqual(sent, [
    '{"type":"visibility","visible":false,"focused":false,"conversation":null}',
    `{"type":"visibility","visible":true,"focused":false,"conversation":"${ID}"}`,
  ]);
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

test('pushToast: on top, the same kind and conversation replaced, at most three', () => {
  const toast = (id: number, kind: 'reply' | 'approval' | 'failure', conversationId: string | null) => ({ id, kind, conversationId, title: null });
  const one = pushToast([], toast(1, 'reply', ID));
  assert.deepEqual(pushToast(one, toast(2, 'reply', ID)).map(({ id }) => id), [2], 'the same notice again replaces it');
  assert.deepEqual(pushToast(one, toast(2, 'approval', ID)).map(({ id }) => id), [1, 2], 'another kind stays');
  assert.deepEqual(pushToast(one, toast(2, 'reply', OTHER)).map(({ id }) => id), [1, 2], 'another conversation stays');
  const three = [toast(1, 'reply', ID), toast(2, 'approval', ID), toast(3, 'failure', null)];
  assert.deepEqual(pushToast(three, toast(4, 'reply', OTHER)).map(({ id }) => id), [2, 3, 4], 'the oldest goes');
});

test('with the helper of the Mac (D-128) the page shows nothing of its own: the helper does', () => {
  const hidden = { hidden: true, openConversation: null, permission: 'granted' as const };
  assert.deepEqual(noticeWhere(ID, hidden, true), { toast: false, system: false });
  assert.deepEqual(noticeWhere(null, hidden, true), { toast: false, system: false }, 'a trial too');
  const shown = { hidden: false, openConversation: null, permission: 'granted' as const };
  assert.deepEqual(noticeWhere(ID, shown, true), { toast: false, system: false }, 'no toast next to the helper notification');
  assert.deepEqual(noticeWhere(ID, { ...shown, permission: 'default' }, true), { toast: false, system: false });
  assert.deepEqual(noticeWhere(ID, hidden, false), { toast: false, system: true });
});
