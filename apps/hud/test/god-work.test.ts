import assert from 'node:assert/strict';
import { test } from 'node:test';

import { actionsOf, hasPlanBlock, quotaText, verdictText, waitsText, withoutPlan } from '../src/lib/god-work.ts';

test('an answer of GOD with a plan: the card instead of the JSON', () => {
  const body = 'Ecco come.\n\n```god-plan\n{"title":"x","subtasks":[]}\n```';
  assert.equal(hasPlanBlock(body), true);
  assert.equal(withoutPlan(body), 'Ecco come.');
  assert.equal(hasPlanBlock('```json\n{}\n```'), false);
});

test('the actions of a subtask follow its state', () => {
  assert.deepEqual(actionsOf({ state: 'working' }), ['stop', 'discard']);
  assert.deepEqual(actionsOf({ state: 'reviewed' }), ['branch', 'stop', 'discard']);
  assert.deepEqual(actionsOf({ state: 'stopped' }), ['resume', 'branch', 'discard']);
  assert.deepEqual(actionsOf({ state: 'branch' }), ['discard']);
  assert.deepEqual(actionsOf({ state: 'discarded' }), []);
  assert.deepEqual(actionsOf({ state: 'attention', conversationId: null }), ['resume', 'discard'], 'its clone failed: it starts again');
  assert.deepEqual(actionsOf({ state: 'attention', conversationId: 'c' }), ['branch', 'stop', 'discard']);
});

test('verdict, waits and quota in words', () => {
  assert.equal(verdictText(null), null);
  assert.equal(verdictText('ok'), 'revisione: approvato');
  assert.equal(verdictText('changes'), 'revisione: da correggere');
  assert.equal(waitsText([]), null);
  assert.equal(waitsText([1]), 'aspetta il 1');
  assert.equal(waitsText([1, 2]), 'aspetta i 1 e 2');
  assert.equal(quotaText({ projection: null, concurrency: 2 }), 'Quota di Claude non ancora letta · 2 sottocompiti alla volta');
  assert.equal(quotaText({ projection: 1.234, concurrency: 1 }), 'Quota di Claude: 123% previsto a fine finestra · 1 sottocompito alla volta');
});
