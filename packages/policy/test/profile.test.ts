import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_FACT_LABEL, FACT_TOPIC_LABEL, factFieldsToScan, isFactLabel, isFactLowering, PolicyError, profileFits, type ProfileFact } from '../src/index.ts';

// Invented facts (development uses fake data only).
const facts: ProfileFact[] = [
  { topic: 'città', text: 'Vive a Borgo Finto', label: 'L2' },
  { topic: 'lavoro', text: 'Sviluppatore web freelance', label: 'L1' },
];

test('a new fact is "Solo in casa" (L2); the topic is L1 by declaration (D-114)', () => {
  assert.equal(DEFAULT_FACT_LABEL, 'L2');
  assert.equal(FACT_TOPIC_LABEL, 'L1');
});

test('isFactLabel: L1 and L2 only', () => {
  assert.equal(isFactLabel('L1'), true);
  assert.equal(isFactLabel('L2'), true);
  for (const value of ['L0', 'L3', 'l1', '', undefined, null, 1]) assert.equal(isFactLabel(value), false, JSON.stringify(value));
});

test('profileFits: a private step (L2) gets topics and texts of every fact', () => {
  assert.deepEqual(profileFits('L2', facts), [
    { topic: 'città', text: 'Vive a Borgo Finto' },
    { topic: 'lavoro', text: 'Sviluppatore web freelance' },
  ]);
  assert.deepEqual(profileFits('L3', facts), profileFits('L2', facts));
});

test('profileFits: a work step (L1) gets the texts of L1 facts and only the topics of L2 facts', () => {
  const fitting = profileFits('L1', facts);
  assert.deepEqual(fitting, [
    { topic: 'città', text: null },
    { topic: 'lavoro', text: 'Sviluppatore web freelance' },
  ]);
  // Negative: the text of an L2 fact never enters a work step.
  assert.equal(JSON.stringify(fitting).includes('Borgo Finto'), false);
});

test('profileFits: an L0 step, or a clearance that is not a label, gets nothing', () => {
  assert.deepEqual(profileFits('L0', facts), []);
  for (const clearance of [undefined, null, '', 'l2', 'L9', 2, {}]) assert.deepEqual(profileFits(clearance, facts), [], JSON.stringify(clearance));
});

test('profileFits: a fact that is not L1 or L2 never enters, not even its topic', () => {
  const odd: ProfileFact[] = [
    { topic: 'salute', text: 'finto', label: 'L3' },
    { topic: 'senza', text: 'finto', label: undefined },
    { topic: 'pubblico', text: 'finto', label: 'L0' },
  ];
  for (const clearance of ['L1', 'L2', 'L3']) assert.deepEqual(profileFits(clearance, odd), [], clearance);
  // Positive beside them: a valid fact still enters.
  assert.deepEqual(profileFits('L2', [...odd, ...facts.slice(1)]), [{ topic: 'lavoro', text: 'Sviluppatore web freelance' }]);
});

test('factFieldsToScan: the topic always, the text only of an L1 fact', () => {
  assert.deepEqual(factFieldsToScan('L1'), ['topic', 'text']);
  assert.deepEqual(factFieldsToScan('L2'), ['topic']);
});

test('factFieldsToScan: L3 and anything that is not L1 or L2 are refused', () => {
  assert.throws(() => factFieldsToScan('L3'), PolicyError);
  for (const label of ['L0', undefined, null, 'l1', 'L9']) assert.throws(() => factFieldsToScan(label), PolicyError, JSON.stringify(label));
});

test('isFactLowering: L2 → L1 is a declassification', () => {
  assert.equal(isFactLowering('L2', 'L1'), true);
});

test('isFactLowering: raising and keeping are not, and a label a fact cannot have throws', () => {
  assert.equal(isFactLowering('L1', 'L2'), false);
  assert.equal(isFactLowering('L1', 'L1'), false);
  assert.equal(isFactLowering('L2', 'L2'), false);
  assert.throws(() => isFactLowering('L3', 'L1'), PolicyError);
  assert.throws(() => isFactLowering('L2', 'L0'), PolicyError);
});
