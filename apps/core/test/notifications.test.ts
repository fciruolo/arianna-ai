// Notifications of the web chat (I-1): which events notify, when, where,
// and that nothing but a kind and a conversation id ever leaves.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { DEFAULT_NOTIFICATIONS, type NotificationsConfig } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import { createNoticeBoard, createNotifier, noticeAllowed, noticeOf, type Notice, type NoticeOutcome } from '../src/notifications.ts';
import { visibilityOf } from '../src/server/http.ts';
import { createPusher, generateVapidKeys, PUSH_TEXTS, vapidKey, type PushKind } from '../src/voice/push.ts';

const CONVERSATION = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const TASK = 'aaaaaaaa-2222-4333-8444-555555555555';
const SECRET_TEXT = 'la fattura di Giulia Bianchi';

const reply = { kind: 'message.created', taskId: TASK, payload: { conversationId: CONVERSATION, messageId: '7', role: 'assistant', replyId: 'r1' } };
const approval = { kind: 'approval.requested', taskId: TASK, payload: { approvalId: '3', action: 'budget' } };
const failure = { kind: 'task.failed', taskId: TASK, payload: { origin: 'local', code: 'timeout' } };
const at = (clock: string): Date => {
  const [hours = 0, minutes = 0] = clock.split(':').map(Number);
  return new Date(2026, 9, 5, hours, minutes);
};

function harness(options: { config?: NotificationsConfig; visible?: number; push?: boolean; now?: Date; helpers?: number } = {}) {
  let reading: string[] = [];
  const broadcasts: Notice[] = [];
  const helped: Notice[] = [];
  let helpers = options.helpers ?? 0;
  const pushes: PushKind[] = [];
  const board = createNoticeBoard();
  let config = options.config ?? DEFAULT_NOTIFICATIONS;
  let visible = options.visible ?? 0;
  const notifier = createNotifier({
    settings: () => config,
    conversationOf: (taskId) => Promise.resolve(taskId === TASK ? OTHER : null),
    visiblePages: () => visible,
    // The pages' flag is checked by the tests of the helper; the others read kind and conversation.
    broadcast: ({ helper, ...notice }) => {
      broadcasts.push(helpers > 0 ? { ...notice, helper } as Notice : notice);
    },
    helpers: () => helpers,
    readingPages: (conversationId) => reading.filter((open) => open === conversationId).length,
    toHelpers: (notice) => helped.push(notice),
    push: () =>
      options.push === false
        ? undefined
        : (kind) => {
            pushes.push(kind);
            return Promise.resolve(1);
          },
    board,
    now: () => options.now ?? at('12:00'),
  });
  return {
    notifier,
    broadcasts,
    helped,
    pushes,
    board,
    setReading: (next: string[]) => {
      reading = next;
    },
    setHelpers: (next: number) => {
      helpers = next;
    },
    setConfig: (next: NotificationsConfig) => {
      config = next;
    },
    setVisible: (next: number) => {
      visible = next;
    },
  };
}

test('noticeOf: the final reply of Arianna, an approval, a failed task; nothing else', () => {
  assert.deepEqual(noticeOf(reply), { kind: 'reply', conversationId: CONVERSATION });
  assert.deepEqual(noticeOf(approval), { kind: 'approval', taskId: TASK });
  assert.deepEqual(noticeOf(failure), { kind: 'failure', taskId: TASK });
  // Not a reply: the user's message, a system line, the report of a delegated agent, a line of a call.
  for (const payload of [
    { ...reply.payload, role: 'user' },
    { ...reply.payload, role: 'system' },
    { ...reply.payload, agent: 'coder' },
    { ...reply.payload, callId: 'c1' },
    { role: 'assistant' },
  ]) {
    assert.equal(noticeOf({ ...reply, payload }), undefined, JSON.stringify(payload));
  }
  assert.equal(noticeOf({ ...approval, taskId: null }), undefined);
  // The agent of a direct chat answers in its own conversation (D-111d): a reply, unless it is a line of a call.
  assert.deepEqual(noticeOf({ ...reply, payload: { ...reply.payload, agent: 'coder', direct: true } }), { kind: 'reply', conversationId: CONVERSATION });
  assert.equal(noticeOf({ ...reply, payload: { ...reply.payload, agent: 'coder', direct: true, callId: 'c1' } }), undefined);
  for (const kind of ['task.status', 'approval.decided', 'conversation.created', 'call.started']) assert.equal(noticeOf({ ...failure, kind }), undefined, kind);
});

test('noticeAllowed: kinds off, quiet hours across midnight and within a day', () => {
  const night = { ...DEFAULT_NOTIFICATIONS, quiet: { from: '22:00', to: '07:00' } };
  assert.equal(noticeAllowed('reply', night, at('12:00')), 'yes');
  assert.equal(noticeAllowed('reply', night, at('21:59')), 'yes');
  assert.equal(noticeAllowed('reply', night, at('22:00')), 'quiet', 'the start is quiet');
  assert.equal(noticeAllowed('reply', night, at('23:59')), 'quiet');
  assert.equal(noticeAllowed('approval', night, at('02:00')), 'quiet');
  assert.equal(noticeAllowed('failure', night, at('07:00')), 'yes');
  const lunch = { ...DEFAULT_NOTIFICATIONS, quiet: { from: '13:00', to: '14:30' } };
  assert.equal(noticeAllowed('reply', lunch, at('14:00')), 'quiet');
  assert.equal(noticeAllowed('reply', lunch, at('23:00')), 'yes');
  assert.equal(noticeAllowed('reply', { ...DEFAULT_NOTIFICATIONS, replies: false }, at('12:00')), 'off');
  assert.equal(noticeAllowed('approval', { ...DEFAULT_NOTIFICATIONS, replies: false }, at('12:00')), 'yes');
  assert.equal(noticeAllowed('approval', { ...DEFAULT_NOTIFICATIONS, approvals: false }, at('12:00')), 'off');
  assert.equal(noticeAllowed('failure', { ...DEFAULT_NOTIFICATIONS, failures: false }, at('12:00')), 'off');
});

test('no page in view: the pages are told and the push goes; the board keeps kind and conversation only', async () => {
  const { notifier, broadcasts, pushes, board } = harness();
  assert.equal(await notifier.handle(reply), 'push');
  assert.equal(await notifier.handle(approval), 'push');
  assert.deepEqual(broadcasts, [
    { kind: 'reply', conversationId: CONVERSATION },
    { kind: 'approval', conversationId: OTHER },
  ]);
  assert.deepEqual(pushes, ['reply', 'approval']);
  assert.deepEqual(board.latest(), { kind: 'approval', conversationId: OTHER });
  assert.deepEqual(Object.keys(board.latest() ?? {}).sort(), ['conversationId', 'kind']);
});

test('a page in view: the pages are told, no push (no double notification)', async () => {
  const { notifier, broadcasts, pushes, board, setVisible } = harness({ visible: 1 });
  assert.equal(await notifier.handle(failure), 'pages');
  assert.deepEqual(broadcasts, [{ kind: 'failure', conversationId: OTHER }]);
  assert.deepEqual(pushes, []);
  assert.equal(board.latest(), undefined);
  setVisible(0);
  assert.equal(await notifier.handle(failure), 'push');
  assert.deepEqual(pushes, ['failure']);
});

test('without [voice.push] only the pages are told', async () => {
  const { notifier, broadcasts, pushes } = harness({ push: false });
  assert.equal(await notifier.handle(reply), 'pages');
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(pushes, []);
});

test('a kind turned off or quiet hours: nothing to the pages, nothing pushed; a change applies at once', async () => {
  const { notifier, broadcasts, pushes, setConfig } = harness({ config: { ...DEFAULT_NOTIFICATIONS, replies: false } });
  assert.equal(await notifier.handle(reply), 'off');
  assert.equal(await notifier.handle(failure), 'push');
  setConfig({ ...DEFAULT_NOTIFICATIONS, quiet: { from: '11:00', to: '13:00' } });
  const outcomes: NoticeOutcome[] = [];
  for (const event of [reply, approval, failure]) outcomes.push(await notifier.handle(event));
  assert.deepEqual(outcomes, ['quiet', 'quiet', 'quiet']);
  assert.deepEqual(pushes, ['failure']);
  assert.equal(broadcasts.length, 1);
  assert.equal(await notifier.handle({ kind: 'task.status', taskId: TASK, payload: {} }), 'none');
});

test('the subscriber of the live feed handles events and ignores reply fragments', async () => {
  const { notifier, broadcasts } = harness();
  notifier.subscriber.send({ type: 'delta', replyId: 'r1', conversationId: CONVERSATION, taskId: TASK, seq: 0, text: SECRET_TEXT });
  notifier.subscriber.send({ type: 'event', event: { id: '1', ts: new Date(), runId: null, agent: null, label: 'L0', ...reply } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(broadcasts, [{ kind: 'reply', conversationId: CONVERSATION }]);
  assert.ok(!JSON.stringify(broadcasts).includes(SECRET_TEXT));
});

test('the board forgets a notice after an hour', () => {
  let clock = 0;
  const board = createNoticeBoard({ now: () => clock });
  board.record({ kind: 'reply', conversationId: CONVERSATION });
  clock = 3_600_000;
  assert.deepEqual(board.latest(), { kind: 'reply', conversationId: CONVERSATION });
  clock += 1;
  assert.equal(board.latest(), undefined);
});

test('visibilityOf: the only frame a page may send', () => {
  assert.deepEqual(visibilityOf('{"type":"visibility","visible":true}'), { visible: true, focused: true, conversation: null });
  assert.deepEqual(visibilityOf('{"type":"visibility","visible":false}'), { visible: false, focused: false, conversation: null });
  // D-128: in view but another app in front; never focused while hidden.
  assert.deepEqual(visibilityOf('{"type":"visibility","visible":true,"focused":false}'), { visible: true, focused: false, conversation: null });
  assert.deepEqual(visibilityOf('{"type":"visibility","visible":false,"focused":true}'), { visible: false, focused: false, conversation: null });
  // The conversation open in the page: an id or null, nothing else.
  assert.deepEqual(visibilityOf(`{"type":"visibility","visible":true,"focused":true,"conversation":"${CONVERSATION}"}`), { visible: true, focused: true, conversation: CONVERSATION });
  assert.deepEqual(visibilityOf('{"type":"visibility","visible":true,"focused":true,"conversation":null}'), { visible: true, focused: true, conversation: null });
  for (const frame of [
    '',
    'x',
    '[]',
    'null',
    '{"type":"visibility","visible":"yes"}',
    '{"type":"visibility"}',
    '{"type":"send","visible":true}',
    '{"type":"visibility","visible":true,"text":"x"}',
    '{"type":"visibility","visible":true,"focused":"no"}',
    '{"type":"visibility","visible":true,"focused":true,"x":1}',
    '{"type":"visibility","visible":true,"focused":true,"conversation":"la fattura"}',
    '{"type":"visibility","visible":true,"conversation":7}',
  ]) {
    assert.equal(visibilityOf(frame), undefined, frame);
  }
});

test('Web Push of a notice: the gateway sees only the fixed sentence of its kind; the request has no body, only headers', async () => {
  const keys = generateVapidKeys();
  const gated: { text: string; kind: PushKind }[] = [];
  const posted: Record<string, string>[] = [];
  // Only the SELECT of the subscriptions runs in notify.
  const sql = (() => Promise.resolve([{ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }])) as unknown as Sql;
  const pusher = createPusher({
    sql,
    publicKey: keys.publicKey,
    key: vapidKey(keys.publicKey, keys.privateKey),
    subject: 'mailto:me@example.org',
    gate: (text, kind) => {
      gated.push({ text, kind });
      return Promise.resolve(true);
    },
    post: (_endpoint, headers) => {
      posted.push(headers);
      return Promise.resolve(201);
    },
  });
  assert.equal(await pusher.notify('reply'), 1);
  assert.equal(await pusher.notify('call'), 1);
  assert.deepEqual(gated, [
    { text: 'Arianna ha risposto', kind: 'reply' },
    { text: 'Arianna ti chiama', kind: 'call' },
  ]);
  assert.deepEqual(Object.keys(posted[0] ?? {}).sort(), ['authorization', 'topic', 'ttl', 'urgency']);
  assert.deepEqual([posted[0]?.topic, posted[0]?.ttl, posted[0]?.urgency], ['arianna-reply', '3600', 'normal']);
  assert.deepEqual([posted[1]?.ttl, posted[1]?.urgency, posted[1]?.topic], ['30', 'high', undefined]);
  // The JWT names the push service and the contact, never a conversation.
  const claims = Buffer.from((posted[0]?.authorization ?? '').split('.')[1] ?? '', 'base64url').toString('utf8');
  assert.deepEqual(Object.keys(JSON.parse(claims) as object).sort(), ['aud', 'exp', 'sub']);
  assert.deepEqual(Object.values(PUSH_TEXTS), ['Arianna ti chiama', 'Arianna ha risposto', 'Arianna aspetta una tua decisione', 'Un lavoro è fallito']);
});

test('Web Push refused by the gateway: nothing is posted', async () => {
  const keys = generateVapidKeys();
  let posts = 0;
  const sql = (() => Promise.resolve([{ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }])) as unknown as Sql;
  const pusher = createPusher({
    sql,
    publicKey: keys.publicKey,
    key: vapidKey(keys.publicKey, keys.privateKey),
    subject: 'mailto:me@example.org',
    gate: () => Promise.resolve(false),
    post: () => {
      posts += 1;
      return Promise.resolve(201);
    },
  });
  assert.equal(await pusher.notify('failure'), 0);
  assert.equal(posts, 0);
});

test('a failed task without a conversation does not notify: nothing to open', async () => {
  const { notifier, broadcasts, pushes } = harness();
  assert.equal(await notifier.handle({ ...failure, taskId: randomUUID() }), 'none');
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(pushes, []);
});

test('the helper of the Mac (D-128): the notice unless the user is reading that conversation, and the pages are told not to show their own', async () => {
  const { notifier, broadcasts, helped, pushes, setVisible, setReading, setHelpers } = harness({ helpers: 1 });
  assert.equal(await notifier.handle(reply), 'push');
  assert.deepEqual(helped, [{ kind: 'reply', conversationId: CONVERSATION }]);
  assert.deepEqual(broadcasts, [{ kind: 'reply', conversationId: CONVERSATION, helper: true }]);
  // The Web Push of the phone does not change.
  assert.deepEqual(pushes, ['reply']);
  // A page in view but another app in front: the helper shows it, no push (the page is in view).
  setVisible(1);
  assert.equal(await notifier.handle(approval), 'pages');
  assert.equal(helped.length, 2);
  // `approval` belongs to OTHER (its task's conversation). The chat in front on another conversation: still the notification of the system, one only.
  setReading([CONVERSATION]);
  assert.equal(await notifier.handle(approval), 'pages');
  assert.equal(helped.length, 3);
  // In front on that conversation: the user is reading it, the helper says nothing.
  setReading([OTHER]);
  assert.equal(await notifier.handle(approval), 'pages');
  assert.equal(helped.length, 3);
  setReading([]);
  // No helper: as before D-128.
  setVisible(0);
  setHelpers(0);
  assert.equal(await notifier.handle(failure), 'push');
  assert.equal(helped.length, 3);
  assert.deepEqual(broadcasts.at(-1), { kind: 'failure', conversationId: OTHER });
});
