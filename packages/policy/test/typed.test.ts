import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createContext,
  fakePiiCheck,
  gatewayCheck,
  isTarget,
  localityOf,
  MAX_TYPED_TEXT,
  recordRead,
  secretMatcher,
  targetName,
  type Context,
  type Decision,
  type Labeled,
  type PiiEntity,
  type Target,
} from '../src/index.ts';

// D-264: the text the agent's browser types in a field of a public page, with the consent of its page.
const TYPED_PUBLIC: Target = { kind: 'web', typed: 'public' };
const TYPED_USER: Target = { kind: 'web', typed: 'user' };
const TYPED_SITES: Target = { kind: 'web', typed: 'sites' };

const PUBLIC = createContext('L1', 'L0');
const INTERNAL = createContext('L1', 'L1');

const piece = (value: unknown, label: Labeled<unknown>['label'] = 'L0', source = 'browser:type'): Labeled<unknown> => ({ value, label, source });

const NO_SECRETS = secretMatcher([]);
const check = (payload: readonly Labeled<unknown>[], context: Context, target: Target, secrets = NO_SECRETS, entities?: PiiEntity[][]) =>
  gatewayCheck(payload, context, target, secrets, fakePiiCheck(payload, entities));
const nextOf = (decision: Decision) => (decision.decision === 'block' ? decision.next : undefined);
const piiOf = (decision: Decision) => (decision.decision === 'block' ? decision.pii?.map((finding) => finding.kind) : undefined);
const ruleOf = (payload: readonly Labeled<unknown>[], context: Context, target: Target, secrets = NO_SECRETS) => check(payload, context, target, secrets).rule;

test('typed: the public consent is allowed from a public session with an L0 text; from an internal session or with an L1 text it is not', () => {
  const decision = check([piece('Torino')], PUBLIC, TYPED_PUBLIC);
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.rule, 'typed');
  assert.deepEqual(decision.texts, ['Torino']);
  const internal = check([piece('Torino')], INTERNAL, TYPED_PUBLIC);
  assert.equal(internal.rule, 'page-consent');
  assert.equal(nextOf(internal), 'stay-local');
  assert.equal(ruleOf([piece('Torino', 'L1')], PUBLIC, TYPED_PUBLIC), 'page-consent');
});

test('typed: with the user or sites consent an internal session may type an L1 text', () => {
  assert.equal(ruleOf([piece('progetto esempio', 'L1')], INTERNAL, TYPED_USER), 'typed');
  assert.equal(ruleOf([piece('Array.prototype.flat', 'L1')], INTERNAL, TYPED_SITES), 'typed');
  assert.equal(ruleOf([piece('Torino')], PUBLIC, TYPED_USER), 'typed');
});

test('typed: never above L1, never from a private session, never with finance data', () => {
  assert.equal(ruleOf([piece('testo finto', 'L2')], INTERNAL, TYPED_USER), 'cloud-label');
  assert.equal(ruleOf([piece('testo finto', 'L1')], createContext('L2', 'L2'), TYPED_USER), 'contaminated');
  assert.equal(ruleOf([piece('testo finto', 'L3')], INTERNAL, TYPED_USER), 'secret');
  // An unlabeled fragment counts as L2.
  assert.equal(ruleOf([{ value: 'testo finto' } as Labeled<unknown>], INTERNAL, TYPED_USER), 'cloud-label');
  assert.equal(ruleOf([piece('Spesa finta 12,50', 'L1', 'finance:transactions')], INTERNAL, TYPED_USER), 'finance');
  const financeSession = recordRead(createContext('L2', 'L1'), 'L2', 'finance:accounts').context;
  assert.equal(ruleOf([piece('Torino', 'L1')], financeSession, TYPED_USER), 'finance');
});

test('typed: at most MAX_TYPED_TEXT characters, counted as code points', () => {
  assert.equal(MAX_TYPED_TEXT, 200);
  assert.equal(ruleOf([piece('a'.repeat(MAX_TYPED_TEXT))], PUBLIC, TYPED_PUBLIC), 'typed');
  assert.equal(ruleOf([piece('a'.repeat(MAX_TYPED_TEXT + 1))], PUBLIC, TYPED_PUBLIC), 'typed-invalid');
  // 200 emoji are 400 UTF-16 units and still 200 characters.
  assert.equal(ruleOf([piece('🙂'.repeat(MAX_TYPED_TEXT))], PUBLIC, TYPED_PUBLIC), 'typed');
  assert.equal(ruleOf([piece('🙂'.repeat(MAX_TYPED_TEXT + 1))], PUBLIC, TYPED_PUBLIC), 'typed-invalid');
});

test('typed: exactly one text fragment, without control characters', () => {
  assert.equal(ruleOf([piece('Torino')], PUBLIC, TYPED_PUBLIC), 'typed');
  assert.equal(ruleOf([piece('Torino'), piece('Milano')], PUBLIC, TYPED_PUBLIC), 'typed-invalid');
  assert.equal(ruleOf([], PUBLIC, TYPED_PUBLIC), 'typed-invalid');
  assert.equal(ruleOf([piece({ q: 'Torino' })], PUBLIC, TYPED_PUBLIC), 'typed-invalid');
  assert.equal(ruleOf([piece(42)], PUBLIC, TYPED_PUBLIC), 'typed-invalid');
  assert.equal(ruleOf([piece('Torino\n')], PUBLIC, TYPED_PUBLIC), 'typed-invalid');
  assert.equal(ruleOf([piece('Tor\tino')], PUBLIC, TYPED_PUBLIC), 'typed-invalid');
  const refused = check([piece('a'.repeat(MAX_TYPED_TEXT + 1))], PUBLIC, TYPED_PUBLIC);
  assert.equal(nextOf(refused), 'stay-local');
});

test('typed: the value of a secret revealed by the vault is blocked; a text without it is allowed', () => {
  const secrets = secretMatcher([{ ref: 'vault://canary-typed', value: 'fake-canary-typed-41c0' }]);
  assert.equal(ruleOf([piece('cerca fake-canary-typed-41c0')], PUBLIC, TYPED_PUBLIC, secrets), 'secret');
  assert.equal(ruleOf([piece('cerca Torino')], PUBLIC, TYPED_PUBLIC, secrets), 'typed');
});

test('typed: the scanner blocks a fake IBAN or tax code, and stays local', () => {
  const iban = check([piece('IT60X0542811101000000123456')], PUBLIC, TYPED_PUBLIC);
  assert.equal(iban.rule, 'scanner');
  assert.equal(nextOf(iban), 'stay-local');
  assert.equal(ruleOf([piece('codice RSSMRA80A01H501U', 'L1')], INTERNAL, TYPED_USER), 'scanner');
  assert.equal(ruleOf([piece('meteo Torino domani', 'L1')], INTERNAL, TYPED_USER), 'typed');
});

test('typed: the second scanner blocks a person; nothing found is allowed', () => {
  const payload = [piece('Mario Rossi Torino', 'L1')];
  const found = check(payload, INTERNAL, TYPED_USER, NO_SECRETS, [[{ kind: 'FULLNAME', start: 0, end: 11, score: 0.99 }]]);
  assert.equal(found.rule, 'pii');
  assert.deepEqual(piiOf(found), ['FULLNAME']);
  assert.equal(check(payload, INTERNAL, TYPED_USER, NO_SECRETS, [[]]).rule, 'typed');
});

test('typed: the target is validated, logged by its consent only, and cloud', () => {
  for (const target of [TYPED_PUBLIC, TYPED_USER, TYPED_SITES]) assert.equal(isTarget(target), true);
  for (const target of [
    { kind: 'web', typed: 'other' },
    { kind: 'web', typed: '' },
    { kind: 'web', typed: 'public', page: { from: 'public' } },
    { kind: 'web', typed: 'public', resource: { of: 'public', type: 'image', method: 'GET' } },
    { kind: 'web', typed: { from: 'public' } },
  ]) {
    assert.equal(isTarget(target), false, JSON.stringify(target));
    assert.equal(ruleOf([piece('Torino')], PUBLIC, target as unknown as Target), 'invalid-input');
  }
  assert.equal(targetName(TYPED_PUBLIC), 'web-typed-public');
  assert.equal(targetName(TYPED_USER), 'web-typed-user');
  assert.equal(targetName(TYPED_SITES), 'web-typed-sites');
  assert.equal(localityOf(TYPED_USER), 'cloud');
});
