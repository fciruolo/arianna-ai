import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatError } from '../src/conversations.ts';
import {
  answeredByOf,
  checkQuestion,
  checkTitle,
  checkWidth,
  pinRefusal,
  questionLabelOf,
  raisedLabel,
  readSuggestion,
  REFRESH_TIMEOUT_MS,
  refreshAgentOf,
  refreshOutcome,
  refreshRefusal,
  TILE_BODY_MAX,
  tileBody,
} from '../src/dashboard.ts';

const open = { incognito: false, trialModel: null, seriesCharacter: null, dashboardOf: null, sideOf: null, origin: 'user' as const };

test('an answer is pinned from an ordinary conversation, never from an incognito, a trial, a character chat, a side thread, a system chat or a refresh', () => {
  assert.equal(pinRefusal(open), undefined);
  assert.match(pinRefusal({ ...open, incognito: true }) ?? '', /incognito/);
  assert.match(pinRefusal({ ...open, trialModel: 'qwen3.5-9b-mlx-4bit' }) ?? '', /trial/);
  assert.match(pinRefusal({ ...open, seriesCharacter: 'jd' }) ?? '', /character/);
  assert.match(pinRefusal({ ...open, dashboardOf: '00000000-0000-4000-8000-000000000001' }) ?? '', /refresh/);
  assert.match(pinRefusal({ ...open, sideOf: '00000000-0000-4000-8000-000000000002' }) ?? '', /side thread/);
  assert.match(pinRefusal({ ...open, origin: 'system' }) ?? '', /system chat/);
});

test('who answered: the cloud when Claude or ChatGPT wrote it, the local model otherwise', () => {
  assert.equal(answeredByOf(null, null, []), 'local');
  assert.equal(answeredByOf('local-chat', null, []), 'local');
  assert.equal(answeredByOf('finanze', null, []), 'local');
  assert.equal(answeredByOf('claude', 'sonnet', []), 'claude');
  assert.equal(answeredByOf('codex', 'luna', []), 'codex');
  // A system chat answered directly by Claude, a delegation to the Coder on Claude or Codex.
  assert.equal(answeredByOf(null, 'opus', []), 'claude');
  assert.equal(answeredByOf('coder', null, ['claude']), 'claude');
  assert.equal(answeredByOf(null, null, ['codex']), 'codex');
  // A local delegation stays local.
  assert.equal(answeredByOf(null, null, ['local']), 'local');
});

test('a refresh is answered by the local model or the agent of the Finances, never Arianna nor the cloud', () => {
  const finance = ['finanze'];
  assert.equal(refreshAgentOf({ agent: null, finance: false }, finance), 'local-chat');
  assert.equal(refreshAgentOf({ agent: 'claude', finance: false }, finance), 'local-chat');
  assert.equal(refreshAgentOf({ agent: 'codex', finance: false }, finance), 'local-chat');
  assert.equal(refreshAgentOf({ agent: 'coder', finance: false }, finance), 'local-chat');
  assert.equal(refreshAgentOf({ agent: 'finanze', finance: true }, finance), 'finanze');
  // A conversation of Arianna marked by finance data: the agent of the Finances reads it again.
  assert.equal(refreshAgentOf({ agent: null, finance: true }, finance), 'finanze');
  // Without an agent of the Finances: the local model, never Arianna.
  assert.equal(refreshAgentOf({ agent: null, finance: true }, []), 'local-chat');
});

test('the question is as protected as the conversation it was written in, finance data at Privato', () => {
  assert.equal(questionLabelOf({ clearance: 'L1', finance: false }, 'L1'), 'L1');
  assert.equal(questionLabelOf({ clearance: 'L1', finance: false }, 'L0'), 'L1');
  assert.equal(questionLabelOf({ clearance: 'L2', finance: false }, 'L1'), 'L2');
  assert.equal(questionLabelOf({ clearance: 'L2', finance: true }, 'L2'), 'L2');
  assert.notEqual(questionLabelOf({ clearance: 'L1', finance: false }, 'L1'), 'L0');
});

test('the label of a tile only goes up after a refresh', () => {
  assert.equal(raisedLabel('L1', 'L2'), 'L2');
  assert.equal(raisedLabel('L2', 'L1'), 'L2');
  assert.equal(raisedLabel('L1', 'L1'), 'L1');
  assert.notEqual(raisedLabel('L2', 'L0'), 'L0');
});

test('a Segreto tile is never refreshed, and a tile being refreshed is not refreshed twice', () => {
  assert.equal(refreshRefusal({ label: 'L2', refreshState: 'idle' }), undefined);
  assert.equal(refreshRefusal({ label: 'L1', refreshState: 'failed' }), undefined);
  assert.equal(refreshRefusal({ label: 'L3', refreshState: 'idle' })?.code, 'invalid');
  assert.equal(refreshRefusal({ label: 'L1', refreshState: 'running' })?.code, 'busy');
});

test('the end of a refresh, from the status of its task', () => {
  const start = new Date('2026-10-16T09:00:00Z');
  const soon = new Date(start.getTime() + 60_000);
  const late = new Date(start.getTime() + REFRESH_TIMEOUT_MS + 1);
  assert.equal(refreshOutcome('ready', start, soon), 'wait');
  assert.equal(refreshOutcome('running', start, soon), 'wait');
  assert.equal(refreshOutcome('done', start, soon), 'done');
  assert.equal(refreshOutcome('failed', start, soon), 'failed');
  // A refresh never asks the user.
  assert.equal(refreshOutcome('waiting_user', start, soon), 'question');
  assert.equal(refreshOutcome('running', start, late), 'timeout');
  assert.equal(refreshOutcome(undefined, start, soon), 'lost');
});

test('title, question and width are checked; a long answer is cut and says so', () => {
  assert.equal(checkTitle('  Spesa   di ottobre '), 'Spesa di ottobre');
  assert.throws(() => checkTitle(''), ChatError);
  assert.throws(() => checkTitle('x'.repeat(81)), ChatError);
  assert.throws(() => checkTitle(3), ChatError);
  assert.equal(checkQuestion(' Quanto ho speso a ottobre? '), 'Quanto ho speso a ottobre?');
  assert.throws(() => checkQuestion('   '), ChatError);
  assert.throws(() => checkQuestion('x'.repeat(2001)), ChatError);
  assert.equal(checkWidth('wide'), 'wide');
  assert.throws(() => checkWidth('huge'), ChatError);
  assert.equal(tileBody('breve'), 'breve');
  const cut = tileBody('x'.repeat(TILE_BODY_MAX + 10));
  assert.ok(cut.length <= TILE_BODY_MAX);
  assert.match(cut, /tagliata/);
});

test('the rewrite of the question is read only when complete and valid', () => {
  assert.deepEqual(readSuggestion({ value: { title: 'Spesa di settembre', question: 'Quanto ho speso in tutto a settembre?' }, finishReason: 'stop' }), {
    title: 'Spesa di settembre',
    question: 'Quanto ho speso in tutto a settembre?',
  });
  assert.equal(readSuggestion({ value: { title: 'x', question: 'y' }, finishReason: 'length' }), undefined);
  assert.equal(readSuggestion({ value: { title: '', question: 'y' }, finishReason: 'stop' }), undefined);
  assert.equal(readSuggestion({ value: ['x'], finishReason: 'stop' }), undefined);
  assert.equal(readSuggestion({ value: { title: 'x' }, finishReason: 'stop' }), undefined);
});
