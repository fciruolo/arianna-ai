import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Conversation } from '../src/conversations.ts';
import { SIDE_AGENTS, sideRefusal, sideSpeaker } from '../src/side-threads.ts';

/** A conversation of the user with Arianna, open: it takes side threads. */
function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    mode: 'private',
    clearance: 'L2',
    effectiveLabel: 'L2',
    finance: false,
    workspace: null,
    model: null,
    agent: null,
    contextTokens: null,
    title: 'Fattura',
    archivedAt: null,
    pinnedAt: null,
    character: true,
    telegram: false,
    incognito: false,
    trialModel: null,
    secretary: false,
    secretarySessionAt: null,
    directSessionAt: null,
    origin: 'user',
    systemReason: null,
    sourceTaskId: null,
    sourceConversationId: null,
    questionAttached: false,
    sourceTaskStatus: null,
    sideOf: null,
    sideMessageId: null,
    seriesCharacter: null,
    createdAt: new Date(0),
    lastMessageAt: null,
    ...overrides,
  };
}

test('Arianna, the local model and the plain chats take a side thread', () => {
  for (const agent of SIDE_AGENTS) assert.equal(sideRefusal(conversation({ agent, mode: agent === 'claude' || agent === 'codex' ? 'work' : 'private' })), undefined);
});

test('no side thread for a direct chat, a system chat, an incognito, the secretary, a trial, an archived one or a side thread', () => {
  const refused: Partial<Conversation>[] = [
    { agent: 'coder', mode: 'work', workspace: 'demo' },
    { agent: 'finanze' },
    { origin: 'system' },
    { incognito: true },
    { secretary: true },
    { trialModel: 'qwen3.5-9b-mlx-4bit', incognito: true },
    { archivedAt: new Date(0) },
    { sideOf: '00000000-0000-4000-8000-000000000002', sideMessageId: '7' },
  ];
  for (const overrides of refused) assert.notEqual(sideRefusal(conversation(overrides)), undefined, JSON.stringify(overrides));
});

test('who wrote a message of the mother, as the side thread reads it', () => {
  assert.equal(sideSpeaker('user', null, null), 'Utente');
  assert.equal(sideSpeaker('system', null, null), 'Sistema');
  assert.equal(sideSpeaker('assistant', null, null), 'Arianna');
  assert.equal(sideSpeaker('assistant', 'designer', null), 'designer');
  assert.equal(sideSpeaker('assistant', null, 'claude'), 'Claude');
  assert.equal(sideSpeaker('assistant', null, 'codex'), 'ChatGPT');
  assert.equal(sideSpeaker('assistant', null, 'local-chat'), 'Modello locale');
});

test('the chat with a character of the series takes no side thread (D-225, D-232)', () => {
  assert.equal(sideRefusal(conversation({ agent: 'claude', mode: 'work', clearance: 'L1', effectiveLabel: 'L1' })), undefined);
  assert.match(sideRefusal(conversation({ agent: 'claude', mode: 'work', clearance: 'L1', effectiveLabel: 'L1', seriesCharacter: 'jd' })) ?? '', /character/);
});
