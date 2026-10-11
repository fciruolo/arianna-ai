import assert from 'node:assert/strict';
import { test } from 'node:test';

import { afterLanding } from '../src/lib/god.ts';
import { actionsOf, badgeOf, hasPlanBlock, landActionsOf, planLandActionsOf, quotaText, verdictText, waitsText, withoutPlan } from '../src/lib/god-work.ts';

test('an answer of GOD with a plan: the card instead of the JSON', () => {
  const body = 'Ecco come.\n\n```god-plan\n{"title":"x","subtasks":[]}\n```';
  assert.equal(hasPlanBlock(body), true);
  assert.equal(withoutPlan(body), 'Ecco come.');
  assert.equal(hasPlanBlock('```json\n{}\n```'), false);
});

test('the actions of a subtask follow its state', () => {
  assert.deepEqual(actionsOf({ state: 'working' }), ['stop', 'discard']);
  assert.deepEqual(actionsOf({ state: 'reviewed' }), ['stop', 'discard']);
  assert.deepEqual(actionsOf({ state: 'stopped' }), ['resume', 'discard']);
  assert.deepEqual(actionsOf({ state: 'branch' }), ['discard']);
  assert.deepEqual(actionsOf({ state: 'discarded' }), []);
  assert.deepEqual(actionsOf({ state: 'attention', conversationId: null }), ['resume', 'discard'], 'its clone failed: it starts again');
  assert.deepEqual(actionsOf({ state: 'attention', conversationId: 'c' }), ['stop', 'discard']);
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

test('Prova and Approva funzionalità (D-179): when a subtask or a plan offers them', () => {
  assert.deepEqual(landActionsOf({ state: 'reviewed', conversationId: 'c' }), ['trial', 'approve']);
  assert.deepEqual(landActionsOf({ state: 'branch', conversationId: 'c' }), ['trial', 'approve']);
  assert.deepEqual(landActionsOf({ state: 'branch', trial: true }), ['approve', 'reject']);
  assert.deepEqual(landActionsOf({ state: 'branch', merged: true }), []);
  assert.deepEqual(landActionsOf({ state: 'working', conversationId: 'c' }), []);
  assert.deepEqual(landActionsOf({ state: 'attention', conversationId: null }), []);
  assert.deepEqual(actionsOf({ state: 'branch', trial: true }), []);
  const ready = { state: 'reviewed' as const, conversationId: 'c' };
  assert.deepEqual(planLandActionsOf([ready, ready, { state: 'discarded' }]), ['trial', 'approve']);
  assert.deepEqual(planLandActionsOf([ready]), [], 'one subtask: its own buttons are enough');
  assert.deepEqual(planLandActionsOf([ready, { state: 'working', conversationId: 'c' }]), []);
  assert.deepEqual(planLandActionsOf([{ state: 'branch', trial: true }, ready]), ['approve', 'reject']);
  assert.deepEqual(badgeOf({ state: 'branch', merged: true }), { text: 'in main', tone: 'ok' });
  assert.deepEqual(badgeOf({ state: 'branch', trial: true }), { text: 'in prova', tone: 'info' });
});

test('after Prova or Approva: reload on a new core, stop waiting on a failure after the click', () => {
  const started = { boot: 'a', since: '2026-10-12T10:00:00.000Z' };
  const idle = { installation: { branch: 'main', clean: true, trial: null }, landing: null };
  assert.equal(afterLanding(started, { boot: 'b', landing: { ...idle, outcome: null } }), 'reload');
  assert.equal(afterLanding(started, { boot: 'a', landing: { ...idle, outcome: { ok: false, text: 'x', at: '2026-10-12T10:00:05.000Z' } } }), 'done');
  assert.equal(afterLanding(started, { boot: 'a', landing: { ...idle, outcome: { ok: false, text: 'x', at: '2026-10-12T09:00:00.000Z' } } }), 'wait', 'an old failure is not this one');
  assert.equal(afterLanding(started, { boot: 'a', landing: { ...idle, outcome: { ok: true, text: 'x', at: '2026-10-12T10:00:05.000Z' } } }), 'wait', 'a success: the restart comes');
});
