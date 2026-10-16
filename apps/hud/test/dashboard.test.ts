import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  anyRunning,
  answeredByText,
  canPin,
  canRefresh,
  cloudNote,
  countText,
  dashboardErrorText,
  droppedOn,
  elapsedText,
  moved,
  pinAllowed,
  REFRESH_LOCAL_TEXT,
  REFRESH_TEXT,
  refreshable,
  refreshButtonText,
  RETRY_TEXT,
  whenText,
  type DashboardTile,
} from '../src/lib/dashboard.ts';
import type { Conversation } from '../src/lib/types.ts';

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({ id: 'c1', mode: 'work', clearance: 'L1', incognito: false, origin: 'user', ...overrides }) as Conversation;

const tile = (overrides: Partial<DashboardTile> = {}): DashboardTile => ({
  id: 't1',
  title: 'Spesa di ottobre',
  question: 'Quanto ho speso a ottobre?',
  questionLabel: 'L2',
  body: '612,40 euro',
  label: 'L2',
  sourceConversationId: 'c1',
  sourceMessageId: '7',
  sourceTitle: 'Conti di casa',
  sourceArchived: false,
  answeredBy: 'local',
  originCloud: false,
  width: 'narrow',
  position: 0,
  refreshedAt: '2026-10-16T09:12:00',
  refreshState: 'idle',
  refreshError: null,
  refreshStartedAt: null,
  createdAt: '2026-10-16T09:12:00',
  ...overrides,
});

test('«Fissa al Cruscotto» on answers only, never in an incognito, a trial, a character chat or a refresh', () => {
  assert.equal(canPin(conversation(), { role: 'assistant' }), true);
  assert.equal(canPin(conversation(), { role: 'user' }), false);
  assert.equal(canPin(conversation(), { role: 'system' }), false);
  assert.equal(canPin(undefined, { role: 'assistant' }), false);
  assert.equal(pinAllowed(conversation({ incognito: true })), false);
  assert.equal(pinAllowed(conversation({ trialModel: 'qwen' })), false);
  assert.equal(pinAllowed(conversation({ seriesCharacter: 'jd' })), false);
  assert.equal(pinAllowed(conversation({ dashboardOf: 'c0' })), false);
  assert.equal(pinAllowed(conversation({ sideOf: 'c0' })), false);
  assert.equal(pinAllowed(conversation({ origin: 'system' })), false);
});

test('a Segreto tile is never refreshed, a running one not twice', () => {
  assert.equal(canRefresh(tile()), true);
  assert.equal(canRefresh(tile({ label: 'L3' })), false);
  assert.equal(canRefresh(tile({ refreshState: 'running' })), false);
  assert.equal(canRefresh(tile({ refreshState: 'failed' })), true);
  assert.deepEqual(refreshable([tile(), tile({ id: 't2', label: 'L3' }), tile({ id: 't3', refreshState: 'running' })]).map((item) => item.id), ['t1']);
  assert.equal(anyRunning([tile(), tile({ refreshState: 'running' })]), true);
  assert.equal(anyRunning([tile()]), false);
});

test('a tile born in the cloud says it is refreshed in local', () => {
  assert.equal(cloudNote(tile()), null);
  assert.match(cloudNote(tile({ originCloud: true, answeredBy: 'claude' })) ?? '', /Claude.*modello locale/);
  assert.match(cloudNote(tile({ originCloud: true, answeredBy: 'local' })) ?? '', /gli aggiornamenti li fa il modello locale/);
  assert.equal(refreshButtonText(tile({ originCloud: true, answeredBy: 'claude' })), REFRESH_LOCAL_TEXT);
  assert.equal(refreshButtonText(tile({ originCloud: true, answeredBy: 'local' })), REFRESH_TEXT);
  assert.equal(refreshButtonText(tile({ refreshState: 'failed', refreshError: 'failed' })), RETRY_TEXT);
  assert.equal(answeredByText(tile({ answeredBy: 'codex' })), 'ChatGPT · cloud');
  assert.equal(answeredByText(tile()), 'Modello locale');
});

test('when it was refreshed, and for how long a refresh has been at work', () => {
  const now = new Date(2026, 9, 16, 10, 0, 0);
  assert.equal(whenText(new Date(2026, 9, 16, 9, 12).toISOString(), now), 'oggi alle 09:12');
  assert.equal(whenText(new Date(2026, 9, 15, 18, 40).toISOString(), now), 'ieri alle 18:40');
  assert.equal(whenText(new Date(2026, 9, 14, 17, 5).toISOString(), now), '14/10 alle 17:05');
  assert.equal(whenText(new Date(2025, 9, 14, 17, 5).toISOString(), now), '14/10/2025');
  assert.equal(whenText('non una data', now), '');
  assert.equal(elapsedText(new Date(now.getTime() - 14_000).toISOString(), now), '0:14');
  assert.equal(elapsedText(new Date(now.getTime() - 185_000).toISOString(), now), '3:05');
  assert.equal(elapsedText(null, now), '0:00');
});

test('moving a tile: one place, or dropped on another', () => {
  assert.deepEqual(moved(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(moved(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 'x', 1), ['a', 'b', 'c']);
  assert.deepEqual(droppedOn(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(droppedOn(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(droppedOn(['a', 'b', 'c'], 'b', 'b'), ['a', 'b', 'c']);
});

test('counts and errors in plain words', () => {
  assert.equal(countText(1), '1 riquadro');
  assert.equal(countText(4), '4 riquadri');
  assert.match(dashboardErrorText(409, 'x'), /già/);
  assert.match(dashboardErrorText(422, 'x'), /IBAN/);
  assert.equal(dashboardErrorText(500, 'altro'), 'altro');
});
