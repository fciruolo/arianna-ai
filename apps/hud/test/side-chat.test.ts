import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyChat } from '../src/lib/chat-state.ts';
import { canAskAside, closesPanel, sideAllowed, sideExcerpt, sideMessages, sidesByMessage, sideStatus, sideWho } from '../src/lib/side-chat.ts';
import { createSideChat, type SideApi, type SideChat } from '../src/lib/side-store.ts';
import type { Conversation, Message, Task } from '../src/lib/types.ts';

const MOTHER = '00000000-0000-4000-8000-000000000001';
const SIDE = '00000000-0000-4000-8000-000000000002';

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: MOTHER,
    mode: 'private',
    clearance: 'L2',
    effectiveLabel: 'L2',
    workspace: null,
    model: null,
    agent: null,
    contextTokens: null,
    title: 'Fattura',
    archivedAt: null,
    telegram: false,
    origin: 'user',
    systemReason: null,
    sourceTaskId: null,
    sourceConversationId: null,
    questionAttached: false,
    sourceTaskStatus: null,
    createdAt: '2026-10-16T08:00:00Z',
    lastMessageAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

function message(id: string, role: Message['role'], body: string, conversationId = MOTHER, taskId: string | null = null): Message {
  return { id, conversationId, ts: '2026-10-16T08:00:00Z', role, channel: 'web', label: 'L2', body, taskId, agent: null, model: null };
}

function task(id: string, status: Task['status'], waitingApprovalId: string | null = null): Task {
  return { id, conversationId: SIDE, title: 'x', status, effectiveLabel: 'L2', waitingReason: null, waitingApprovalId };
}

test('«Chiedi a lato» on the answers of Arianna, the local model and the plain chats, not elsewhere', () => {
  const answer = message('5', 'assistant', 'Risposta');
  assert.equal(canAskAside(conversation(), answer), true);
  for (const agent of ['local-chat', 'claude', 'codex']) assert.equal(sideAllowed(conversation({ agent })), true);
  assert.equal(canAskAside(conversation(), message('4', 'user', 'Domanda')), false);
  assert.equal(canAskAside(conversation(), message('6', 'system', 'Riga')), false);
  for (const overrides of [{ agent: 'coder' }, { incognito: true }, { secretary: true }, { trialModel: 'x' }, { archivedAt: '2026-10-16T09:00:00Z' }, { origin: 'system' as const }, { sideOf: SIDE }, { agent: 'claude', seriesCharacter: 'jd' }]) {
    assert.equal(sideAllowed(conversation(overrides)), false, JSON.stringify(overrides));
  }
  assert.equal(sideAllowed(undefined), false);
});

test('the excerpt is one plain paragraph, cut on a character', () => {
  assert.equal(sideExcerpt('## Fattura\n\n**Imponibile**: 1.000 €\n```\ncodice\n```\nfine'), 'Fattura Imponibile: 1.000 € […] fine');
  const long = sideExcerpt('à'.repeat(400), 10);
  assert.equal(Array.from(long).length, 10);
  assert.ok(long.endsWith('…'));
});

test('Esc closes the panel, not while a word is being composed', () => {
  assert.equal(closesPanel({ key: 'Escape' }), true);
  assert.equal(closesPanel({ key: 'Escape', isComposing: true }), false);
  assert.equal(closesPanel({ key: 'Enter' }), false);
});

test('the status of the side thread follows its latest question', () => {
  const chat = { ...emptyChat(SIDE), messages: [message('10', 'user', 'Cosa vuol dire?', SIDE, 't1')] };
  assert.equal(sideStatus(null, {}), 'idle');
  assert.equal(sideStatus(chat, { t1: task('t1', 'running') }), 'working');
  assert.equal(sideStatus(chat, { t1: task('t1', 'failed') }), 'failed');
  assert.equal(sideStatus(chat, { t1: task('t1', 'waiting_user', 'a1') }), 'waiting');
  const answered = { ...chat, messages: [...chat.messages, message('11', 'assistant', 'Vuol dire…', SIDE, 't1')] };
  assert.equal(sideStatus(answered, { t1: task('t1', 'done') }), 'idle');
  assert.deepEqual(sideMessages({ ...answered, messages: [...answered.messages, message('12', 'system', 'Riga', SIDE)] }).map((item) => item.id), ['10', '11']);
  assert.deepEqual([...sidesByMessage([{ messageId: '5', conversationId: SIDE }])], [['5', SIDE]]);
  assert.equal(sideWho('claude'), 'Claude');
  assert.equal(sideWho(null), 'Arianna');
});

/** The chat of the panel, read fresh (no narrowing from an earlier read). */
function chatOf(side: SideChat) {
  return side.panel.value?.chat ?? null;
}

/** A stand-in for the core that records the calls. */
function fakeApi(seen: string[]): SideApi {
  const child = conversation({ id: SIDE, sideOf: MOTHER, sideMessageId: '5' });
  const stored: Message[] = [];
  return {
    listSides: (id) => {
      seen.push(`sides ${id}`);
      return Promise.resolve([]);
    },
    openSide: (id, messageId) => {
      seen.push(`open ${id} ${messageId}`);
      return Promise.resolve(child);
    },
    loadConversation: () => Promise.resolve(child),
    listMessages: (id) => {
      seen.push(`messages ${id}`);
      return Promise.resolve([...stored]);
    },
    sendMessage: (id, body) => {
      seen.push(`send ${id} ${body}`);
      const sent = message('10', 'user', body, id, 't1');
      stored.push(sent);
      return Promise.resolve({ message: sent, task: task('t1', 'ready') });
    },
    loadTask: (id) => Promise.resolve(task(id, 'running')),
    loadQueue: () => Promise.resolve({ paused: false, messages: [] }),
  };
}

test('the first question creates the side thread, then goes to it; the answer streams in the panel only', async () => {
  const seen: string[] = [];
  const side = createSideChat(fakeApi(seen));
  await side.loadSides(MOTHER);
  await side.open(MOTHER, message('5', 'assistant', 'Imponibile 1.000 euro'));
  assert.equal(side.panel.value?.conversation, null);
  assert.equal(await side.send('Cosa vuol dire imponibile?'), true);
  assert.deepEqual(seen, [`sides ${MOTHER}`, `open ${MOTHER} 5`, `send ${SIDE} Cosa vuol dire imponibile?`]);
  assert.equal(side.sides.value.get('5'), SIDE);
  assert.equal(side.openId(), SIDE);
  assert.deepEqual(chatOf(side)?.messages.map((item) => item.body), ['Cosa vuol dire imponibile?']);

  // A fragment of the main conversation never reaches the panel; one of the side thread does.
  side.onLive({ type: 'delta', replyId: 'r1', conversationId: MOTHER, taskId: 'm1', seq: 0, text: 'no' });
  side.onLive({ type: 'delta', replyId: 'r2', conversationId: SIDE, taskId: 't1', seq: 0, text: 'È la base' });
  assert.deepEqual(chatOf(side)?.streaming.map((reply) => reply.text), ['È la base']);

  // Deleting the mother closes the panel.
  side.onLive({ type: 'event', event: { id: '1', ts: '', taskId: null, runId: null, agent: null, kind: 'conversation.purged', label: 'L0', payload: { conversationId: MOTHER } } });
  assert.equal(side.panel.value, null);
  assert.equal(side.openId(), null);
});

test('an answer with a side thread opens the same one again; an empty question does not leave', async () => {
  const seen: string[] = [];
  const api = fakeApi(seen);
  const side = createSideChat({ ...api, listSides: () => Promise.resolve([{ messageId: '5', conversationId: SIDE }]) });
  await side.loadSides(MOTHER);
  await side.open(MOTHER, message('5', 'assistant', 'Imponibile 1.000 euro'));
  assert.equal(side.panel.value?.conversation?.id, SIDE);
  assert.ok(seen.includes(`messages ${SIDE}`));
  assert.equal(await side.send('   '), false);
  assert.ok(!seen.some((line) => line.startsWith('open ')));
});
