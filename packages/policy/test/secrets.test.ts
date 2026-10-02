import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createContext, gatewayCheck, secretMatcher, type Labeled, type Target } from '../src/index.ts';

const FAKE_TOKEN = 'fake-demo-token-4f9a';
const known = secretMatcher([{ ref: 'vault://demo-token', value: FAKE_TOKEN }]);

const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
const LOCAL_MODEL: Target = { kind: 'executor', id: 'omlx', locality: 'local' };
const TELEGRAM: Target = { kind: 'channel', id: 'telegram' };
const WEB_CHAT: Target = { kind: 'channel', id: 'web' };

const fragment = (value: unknown, label: Labeled<unknown>['label'] = 'L1'): Labeled<unknown> => ({ value, label, source: 'test' });

test('the matcher returns the references of the secrets in a text, never the values', () => {
  assert.deepEqual(known.find(`Authorization: Bearer ${FAKE_TOKEN}`), ['vault://demo-token']);
  assert.deepEqual(known.find('nothing secret here'), []);
});

test('the matcher sees through full-width and zero-width variants', () => {
  assert.deepEqual(known.find('ｆａｋｅ-demo-token-4f9a'), ['vault://demo-token']);
  assert.deepEqual(known.find('fake-demo-\u200Btoken-4f9a'), ['vault://demo-token']);
});

test('the matcher ignores values shorter than the minimum and repeats no reference', () => {
  const matcher = secretMatcher([
    { ref: 'vault://pin', value: '1234' },
    { ref: 'vault://demo-token', value: FAKE_TOKEN },
  ]);
  assert.deepEqual(matcher.find(`1234 ${FAKE_TOKEN} ${FAKE_TOKEN}`), ['vault://demo-token']);
});

test('a known secret blocks every target, local model and web chat included', () => {
  for (const target of [LOCAL_MODEL, WEB_CHAT, CLAUDE]) {
    const decision = gatewayCheck([fragment(`use ${FAKE_TOKEN}`, 'L2')], createContext('L2'), target, known);
    assert.equal(decision.decision, 'block');
    assert.equal(decision.rule, 'secret');
  }
});

test('a known secret blocked on an external channel becomes a reference notice', () => {
  const decision = gatewayCheck([fragment(`token ${FAKE_TOKEN}`)], createContext('L1'), TELEGRAM, known);
  assert.ok(decision.decision === 'block');
  assert.equal(decision.next, 'notify-reference');
});

test('the reason names the reference, not the value', () => {
  const decision = gatewayCheck([fragment(FAKE_TOKEN)], createContext('L1'), LOCAL_MODEL, known);
  assert.equal(decision.reason, 'payload contains the value of vault://demo-token');
  assert.ok(!JSON.stringify(decision).includes(FAKE_TOKEN));
});

test('a known secret inside a JSON fragment is found in its decoded strings', () => {
  const decision = gatewayCheck([fragment({ headers: { authorization: `Bearer ${FAKE_TOKEN}` } }, 'L2')], createContext('L2'), LOCAL_MODEL, known);
  assert.equal(decision.rule, 'secret');
});

test('a payload without known secrets passes as before', () => {
  assert.equal(gatewayCheck([fragment('fake text', 'L2')], createContext('L2'), LOCAL_MODEL, known).decision, 'allow');
  assert.equal(gatewayCheck([fragment('fake text')], createContext('L1'), CLAUDE, known).decision, 'allow');
});

test('a matcher that throws blocks instead of letting the payload through', () => {
  const broken = {
    find(): string[] {
      throw new Error('broken');
    },
  };
  const decision = gatewayCheck([fragment('fake text', 'L2')], createContext('L2'), LOCAL_MODEL, broken);
  assert.equal(decision.decision, 'block');
  assert.equal(decision.rule, 'invalid-input');
});
