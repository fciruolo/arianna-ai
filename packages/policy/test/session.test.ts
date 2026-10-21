import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createContext,
  fakePiiCheck,
  gatewayCheck,
  isTarget,
  localityOf,
  MAX_FORM_BODY,
  secretMatcher,
  targetName,
  type Context,
  type Labeled,
  type Target,
} from '../src/index.ts';

// D-276: the agent's browser after an access made by the user. Requests of the site of the access
// (`session`) and the forms the user sends while driving (`form`) may carry L2, only to that site.
const PAGE: Target = { kind: 'web', session: { site: 'banca-finta.it', type: 'document', method: 'GET' } };
const FETCH_POST: Target = { kind: 'web', session: { site: 'banca-finta.it', type: 'fetch', method: 'POST' } };
const FORM: Target = { kind: 'web', form: { site: 'banca-finta.it', bytes: 120 } };

const PUBLIC = createContext('L1', 'L0');
const INTERNAL = createContext('L1', 'L1');
const PRIVATE = createContext('L2', 'L2');
const FINANCE = createContext('L2', 'L2', { finance: true });

const piece = (value: unknown, label: Labeled<unknown>['label'] = 'L2', source = 'browser:session'): Labeled<unknown> => ({ value, label, source });

const NO_SECRETS = secretMatcher([]);
const check = (payload: readonly Labeled<unknown>[], context: Context, target: Target, secrets = NO_SECRETS) => gatewayCheck(payload, context, target, secrets, fakePiiCheck(payload));
const ruleOf = (payload: readonly Labeled<unknown>[], context: Context, target: Target, secrets = NO_SECRETS) => check(payload, context, target, secrets).rule;

test('session: an L2 page of the site of the access is allowed from a session at most Internal, its subdomains too', () => {
  const decision = check([piece('https://www.banca-finta.it/conti/123')], INTERNAL, PAGE);
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.rule, 'session');
  assert.equal(decision.label, 'L2');
  assert.deepEqual(decision.texts, ['https://www.banca-finta.it/conti/123']);
  assert.equal(ruleOf([piece('https://app.banca-finta.it/')], PUBLIC, PAGE), 'session');
  assert.equal(ruleOf([piece('https://banca-finta.it/')], PUBLIC, PAGE), 'session');
});

test('session: never towards another site, nor a site that only ends with the same letters', () => {
  for (const address of ['https://tracker-finto.net/p?c=1', 'https://notbanca-finta.it/', 'https://banca-finta.it.evil-finto.net/', 'https://user:pw@banca-finta.it/']) {
    const decision = check([piece(address)], INTERNAL, PAGE);
    assert.equal(decision.decision, 'block', address);
    assert.equal(decision.rule, 'session-invalid', address);
  }
  // The same L2 address with the ordinary consents is blocked as L2 to the cloud.
  assert.equal(ruleOf([piece('https://banca-finta.it/conti')], INTERNAL, { kind: 'web', resource: { of: 'user', type: 'document', method: 'GET' } }), 'cloud-label');
  assert.equal(ruleOf([piece('https://banca-finta.it/conti')], INTERNAL, { kind: 'web', page: { from: 'sites', sites: ['banca-finta.it'] } }), 'cloud-label');
});

test('session: never from a session that has read Private or finance data, never L3, never a value of the vault', () => {
  assert.equal(ruleOf([piece('https://banca-finta.it/conti')], PRIVATE, PAGE), 'contaminated');
  assert.equal(ruleOf([piece('https://banca-finta.it/conti')], FINANCE, PAGE), 'finance');
  assert.equal(ruleOf([piece('https://banca-finta.it/conti', 'L3')], INTERNAL, PAGE), 'secret');
  const secrets = secretMatcher([{ ref: 'vault://banca', value: 'fake-session-canary-6b2e' }]);
  assert.equal(ruleOf([piece('https://banca-finta.it/x?k=fake%2Dsession%2Dcanary%2D6b2e')], INTERNAL, PAGE, secrets), 'secret');
  assert.equal(ruleOf([piece('https://banca-finta.it/api'), piece('{"k":"fake-session-canary-6b2e"}')], INTERNAL, FETCH_POST, secrets), 'secret');
});

test('session: the scanner reads the address and the body; the second scanner never', () => {
  assert.equal(ruleOf([piece('https://banca-finta.it/carta/4111111111111111')], INTERNAL, PAGE), 'scanner');
  assert.equal(ruleOf([piece('https://banca-finta.it/api'), piece('iban=IT60X0542811101000000123456')], INTERNAL, FETCH_POST), 'scanner');
  // A name the second scanner would see as a person: not read here.
  const address = 'https://banca-finta.it/profilo/Mario%20Rossi';
  const start = address.indexOf('Mario');
  const found = (payload: readonly Labeled<unknown>[]) => fakePiiCheck(payload, [[{ kind: 'FULLNAME', start, end: start + 'Mario%20Rossi'.length, score: 0.98 }]]);
  const payload = [piece(address)];
  assert.equal(gatewayCheck(payload, INTERNAL, PAGE, NO_SECRETS, found(payload)).rule, 'session');
  // The same address as an L1 page of the user is read by it, and blocked.
  const internal = [piece(address, 'L1')];
  assert.equal(gatewayCheck(internal, INTERNAL, { kind: 'web', page: { from: 'user', addresses: [address] } }, NO_SECRETS, found(internal)).rule, 'pii');
  assert.equal(ruleOf([piece('https://banca-finta.it/api'), piece('{"q":"saldo"}')], INTERNAL, FETCH_POST), 'session');
});

test('session: the shape: a body only with POST, the site a host name, nothing else in the target', () => {
  assert.equal(ruleOf([piece('https://banca-finta.it/api'), piece('a=1')], INTERNAL, PAGE), 'session-invalid');
  assert.equal(ruleOf([piece('https://banca-finta.it/api'), piece('x'.repeat(64 * 1024 + 1))], INTERNAL, FETCH_POST), 'session-invalid');
  assert.equal(isTarget({ kind: 'web', session: { site: 'com', type: 'document', method: 'GET' } }), false);
  assert.equal(isTarget({ kind: 'web', session: { site: 'banca-finta.it', type: 'media', method: 'GET' } }), false);
  assert.equal(isTarget({ kind: 'web', session: { site: 'banca-finta.it', type: 'document', method: 'GET', extra: 1 } }), false);
  assert.equal(isTarget({ kind: 'web', session: { site: 'banca-finta.it', type: 'document', method: 'GET' }, page: { from: 'public' } }), false);
  assert.equal(isTarget(PAGE), true);
  assert.equal(targetName(PAGE), 'web-session');
  assert.equal(localityOf(PAGE), 'cloud');
});

test('form: the address of a form of the user to the site of its page is allowed with L2, its content never read', () => {
  const decision = check([piece('https://login.banca-finta.it/session')], INTERNAL, FORM);
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.rule, 'form');
  assert.match(decision.reason, /banca-finta\.it, 120 bytes, content not read/);
  assert.equal(targetName(FORM), 'web-form');
  assert.equal(localityOf(FORM), 'cloud');
});

test('form: never to another site, never with its content, never from a Private or finance session', () => {
  assert.equal(ruleOf([piece('https://raccolta-finta.net/steal')], INTERNAL, FORM), 'session-invalid');
  // The content is never a fragment: a second piece is refused.
  assert.equal(ruleOf([piece('https://banca-finta.it/session'), piece('user=mario&password=x')], INTERNAL, FORM), 'session-invalid');
  assert.equal(ruleOf([piece('https://banca-finta.it/session')], PRIVATE, FORM), 'contaminated');
  assert.equal(ruleOf([piece('https://banca-finta.it/session')], FINANCE, FORM), 'finance');
  assert.equal(ruleOf([piece('https://banca-finta.it/session', 'L3')], INTERNAL, FORM), 'secret');
  const secrets = secretMatcher([{ ref: 'vault://banca', value: 'fake-form-canary-9c4d' }]);
  assert.equal(ruleOf([piece('https://banca-finta.it/session?t=fake%2Dform%2Dcanary%2D9c4d')], INTERNAL, FORM, secrets), 'secret');
  assert.equal(ruleOf([piece('https://banca-finta.it/session?c=4111111111111111')], INTERNAL, FORM), 'scanner');
  for (const bytes of [-1, 1.5, MAX_FORM_BODY + 1]) assert.equal(isTarget({ kind: 'web', form: { site: 'banca-finta.it', bytes } }), false, String(bytes));
  assert.equal(isTarget({ kind: 'web', form: { site: 'banca-finta.it', bytes: MAX_FORM_BODY } }), true);
  assert.equal(isTarget({ kind: 'web', form: { site: 'banca-finta.it', bytes: 1 }, typed: 'user' }), false);
});
