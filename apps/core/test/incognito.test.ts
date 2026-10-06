// Incognito conversations (D-136, I-4 tappa 2): the rules of the core that need no database.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_NOTIFICATIONS, resolveHome } from '@arianna/config';

import { createIncognitoWatch, INCOGNITO_OFF_TOOLS } from '../src/incognito.ts';
import { createNoticeBoard, createNotifier } from '../src/notifications.ts';
import { orchestratorTools } from '../src/orchestrator/orchestrator.ts';
import { incognitoClosedFrame, visibilityOf } from '../src/server/http.ts';
import { committedAgents } from './support/committed-agents.ts';

const arianna = committedAgents(resolveHome({})).get('arianna');
const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa';

test('in an incognito conversation the tools that keep something are never offered', () => {
  assert.ok(arianna !== undefined);
  const normal = orchestratorTools(arianna, true, true);
  // The card offers them in a normal conversation: the filter has something to remove.
  for (const tool of ['kb.write', 'task.create', 'task.update'] as const) assert.ok(normal.includes(tool), tool);
  const incognito = orchestratorTools(arianna, true, true, true);
  for (const tool of INCOGNITO_OFF_TOOLS) assert.ok(!incognito.includes(tool), tool);
  // Reading the KB, asking and delegating stay: "a chat like the others".
  assert.deepEqual(incognito, normal.filter((tool) => !(INCOGNITO_OFF_TOOLS as readonly string[]).includes(tool)));
  assert.ok(incognito.includes('kb.search') && incognito.includes('kb.read') && incognito.includes('task.delegate'));
});

test('the closing event becomes its own frame for the chat; any other event does not', () => {
  assert.deepEqual(incognitoClosedFrame({ kind: 'conversation.incognito-closed', payload: { conversationId: ID, cause: 'idle' } }), {
    type: 'conversation.incognito-closed',
    conversationId: ID,
    cause: 'idle',
  });
  assert.equal(incognitoClosedFrame({ kind: 'conversation.purged', payload: { conversationId: ID, tasks: 1 } }), undefined);
  assert.equal(incognitoClosedFrame({ kind: 'conversation.incognito-closed', payload: { conversationId: ID, cause: 'other' } }), undefined);
  assert.equal(incognitoClosedFrame({ kind: 'conversation.incognito-closed', payload: null }), undefined);
});

test('the visibility frame says the conversation open also when the page is not in view', () => {
  assert.deepEqual(visibilityOf(JSON.stringify({ type: 'visibility', visible: false, conversation: ID })), { visible: false, focused: false, conversation: ID });
  assert.equal(visibilityOf(JSON.stringify({ type: 'visibility', visible: false, conversation: 'not-an-id' })), undefined);
});

function watchHarness(pages: Map<string, number>, open: string[]) {
  let clock = 0;
  const closed: string[] = [];
  const warned: [string, number][] = [];
  const watch = createIncognitoWatch({
    list: () => Promise.resolve(open.filter((id) => !closed.includes(id))),
    pagesOn: (id) => pages.get(id) ?? 0,
    close: (id) => {
      closed.push(id);
      return Promise.resolve();
    },
    warn: (id, inSeconds) => warned.push([id, inSeconds]),
    now: () => clock,
  });
  return {
    watch,
    closed,
    warned,
    at: (minutes: number) => {
      clock = minutes * 60_000;
    },
  };
}

test('10 minutes without a page close an incognito conversation, with the warning at 9', async () => {
  const h = watchHarness(new Map(), [ID]);
  await h.watch.tick();
  h.at(8.9);
  await h.watch.tick();
  assert.deepEqual(h.warned, []);
  h.at(9);
  await h.watch.tick();
  assert.deepEqual(h.warned, [[ID, 60]]);
  h.at(9.5);
  await h.watch.tick();
  // Warned once only.
  assert.equal(h.warned.length, 1);
  assert.deepEqual(h.closed, []);
  h.at(10);
  await h.watch.tick();
  assert.deepEqual(h.closed, [ID]);
});

test('a page on the conversation keeps it open, and coming back in time starts the count again', async () => {
  const pages = new Map([[ID, 1]]);
  const h = watchHarness(pages, [ID, OTHER]);
  await h.watch.tick();
  h.at(30);
  await h.watch.tick();
  // OTHER had no page all along; ID had one.
  assert.deepEqual(h.closed, [OTHER]);
  pages.set(ID, 0);
  h.at(39);
  await h.watch.tick();
  // OTHER went past the ten minutes between two looks: closed at once, without a warning.
  assert.deepEqual(h.warned.map(([id]) => id), [ID]);
  pages.set(ID, 1);
  h.at(39.5);
  await h.watch.tick();
  pages.set(ID, 0);
  h.at(49);
  await h.watch.tick();
  assert.deepEqual(h.closed, [OTHER], 'the page came back at 39.5: the ten minutes start from there');
  h.at(49.5);
  await h.watch.tick();
  assert.deepEqual(h.closed, [OTHER, ID]);
});

test('no notice of any kind for an incognito conversation; the others as before', async () => {
  const broadcasts: unknown[] = [];
  const helped: unknown[] = [];
  const pushes: unknown[] = [];
  const notifier = createNotifier({
    settings: () => DEFAULT_NOTIFICATIONS,
    conversationOf: () => Promise.resolve(ID),
    incognito: (conversationId) => Promise.resolve(conversationId === ID),
    visiblePages: () => 0,
    broadcast: (notice) => broadcasts.push(notice),
    helpers: () => 1,
    readingPages: () => 0,
    toHelpers: (notice) => helped.push(notice),
    push: () => (kind) => {
      pushes.push(kind);
      return Promise.resolve(1);
    },
    board: createNoticeBoard(),
  });
  const reply = (conversationId: string) => ({ kind: 'message.created', taskId: null, payload: { conversationId, role: 'assistant', messageId: '1' } });
  assert.equal(await notifier.handle(reply(ID)), 'none');
  assert.equal(await notifier.handle({ kind: 'approval.requested', taskId: 'task', payload: { approvalId: 'a' } }), 'none');
  assert.equal(await notifier.handle({ kind: 'task.failed', taskId: 'task', payload: {} }), 'none');
  assert.deepEqual([broadcasts, helped, pushes], [[], [], []]);
  assert.equal(await notifier.handle(reply(OTHER)), 'push');
  assert.equal(broadcasts.length, 1);
});

test('a closing that fails is tried again at the next look, without starting the ten minutes again', async () => {
  let clock = 0;
  let failures = 1;
  const closed: string[] = [];
  const errors: unknown[] = [];
  const watch = createIncognitoWatch({
    list: () => Promise.resolve(closed.includes(ID) ? [] : [ID]),
    pagesOn: () => 0,
    close: (id) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('busy'));
      }
      closed.push(id);
      return Promise.resolve();
    },
    warn: () => undefined,
    now: () => clock,
    onError: (error) => errors.push(error),
  });
  await watch.tick();
  clock = 10 * 60_000;
  await watch.tick();
  assert.deepEqual([closed, errors.length], [[], 1]);
  clock += 15_000;
  await watch.tick();
  assert.deepEqual(closed, [ID]);
});
