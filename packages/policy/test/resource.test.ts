import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createContext,
  fakePiiCheck,
  gatewayCheck,
  isTarget,
  localityOf,
  MAX_RESOURCE_BODY,
  secretMatcher,
  targetName,
  type Context,
  type Labeled,
  type Target,
} from '../src/index.ts';

// D-264: one resource of a page of the agent's browser, with the consent of its page.
const IMAGE_PUBLIC: Target = { kind: 'web', resource: { of: 'public', type: 'image', method: 'GET' } };
const FETCH_USER_POST: Target = { kind: 'web', resource: { of: 'user', type: 'fetch', method: 'POST' } };
const FETCH_USER_GET: Target = { kind: 'web', resource: { of: 'user', type: 'fetch', method: 'GET' } };
const SCRIPT_SITES: Target = { kind: 'web', resource: { of: 'sites', type: 'script', method: 'GET' } };

const PUBLIC = createContext('L1', 'L0');
const INTERNAL = createContext('L1', 'L1');

const piece = (value: unknown, label: Labeled<unknown>['label'] = 'L0', source = 'web:resource'): Labeled<unknown> => ({ value, label, source });

const NO_SECRETS = secretMatcher([]);
const check = (payload: readonly Labeled<unknown>[], context: Context, target: Target, secrets = NO_SECRETS) => gatewayCheck(payload, context, target, secrets, fakePiiCheck(payload));
const ruleOf = (payload: readonly Labeled<unknown>[], context: Context, target: Target, secrets = NO_SECRETS) => check(payload, context, target, secrets).rule;

test('resource: an image of a public page from a public session is allowed; with the public consent from an internal session it is not', () => {
  const decision = check([piece('https://cdn.example.net/a/logo.png')], PUBLIC, IMAGE_PUBLIC);
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.rule, 'resource');
  assert.deepEqual(decision.texts, ['https://cdn.example.net/a/logo.png']);
  assert.equal(ruleOf([piece('https://cdn.example.net/a/logo.png')], INTERNAL, IMAGE_PUBLIC), 'page-consent');
  // An L1 address in a public session: the public consent wants L0 both.
  assert.equal(ruleOf([piece('https://cdn.example.net/a/logo.png', 'L1')], PUBLIC, IMAGE_PUBLIC), 'page-consent');
});

test('resource: with the user or sites consent an internal session may load resources from any public site', () => {
  assert.equal(ruleOf([piece('https://cdn.example.net/lib.js', 'L1')], INTERNAL, SCRIPT_SITES), 'resource');
  assert.equal(ruleOf([piece('https://api.example.org/v1/items', 'L1')], INTERNAL, FETCH_USER_GET), 'resource');
  // Never from a private session.
  assert.equal(ruleOf([piece('https://cdn.example.net/lib.js', 'L1')], createContext('L2', 'L2'), SCRIPT_SITES), 'contaminated');
});

test('resource: a POST body of 64 KB is allowed, one byte more is not', () => {
  const address = piece('https://api.example.org/v1/log', 'L1');
  const full = 'a'.repeat(MAX_RESOURCE_BODY);
  const decision = check([address, piece(full, 'L1')], INTERNAL, FETCH_USER_POST);
  assert.equal(decision.rule, 'resource');
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.texts[1], full);
  assert.equal(ruleOf([address, piece(`${full}a`, 'L1')], INTERNAL, FETCH_USER_POST), 'resource-invalid');
  // Counted in UTF-8 bytes, not characters: 32 KB of «è» are 64 KB.
  assert.equal(ruleOf([address, piece('è'.repeat(MAX_RESOURCE_BODY / 2), 'L1')], INTERNAL, FETCH_USER_POST), 'resource');
  assert.equal(ruleOf([address, piece('è'.repeat(MAX_RESOURCE_BODY / 2 + 1), 'L1')], INTERNAL, FETCH_USER_POST), 'resource-invalid');
});

test('resource: a body only with POST; a GET without body is allowed, with a body it is not', () => {
  assert.equal(ruleOf([piece('https://api.example.org/v1/items', 'L1')], INTERNAL, FETCH_USER_GET), 'resource');
  assert.equal(ruleOf([piece('https://api.example.org/v1/items', 'L1'), piece('{"a":1}', 'L1')], INTERNAL, FETCH_USER_GET), 'resource-invalid');
  const head: Target = { kind: 'web', resource: { of: 'user', type: 'fetch', method: 'HEAD' } };
  assert.equal(ruleOf([piece('https://api.example.org/v1/items', 'L1'), piece('', 'L1')], INTERNAL, head), 'resource-invalid');
  // A POST without a body is a POST.
  assert.equal(ruleOf([piece('https://api.example.org/v1/items', 'L1')], INTERNAL, FETCH_USER_POST), 'resource');
});

test('resource: one normalized http(s) address, a text body, nothing else', () => {
  for (const value of ['Leggi https://example.com/a', 'file:///etc/passwd', 'https://user:pw@example.com/a', 'https://example.com', 'ws://example.com/a', { url: 'https://example.com/a' }]) {
    assert.equal(ruleOf([piece(value)], PUBLIC, IMAGE_PUBLIC), 'resource-invalid', JSON.stringify(value));
  }
  assert.equal(ruleOf([piece('https://example.com/a')], PUBLIC, IMAGE_PUBLIC), 'resource');
  assert.equal(ruleOf([piece('https://api.example.org/a', 'L1'), piece({ a: 1 }, 'L1')], INTERNAL, FETCH_USER_POST), 'resource-invalid');
  assert.equal(ruleOf([piece('https://api.example.org/a', 'L1'), piece('x', 'L1'), piece('y', 'L1')], INTERNAL, FETCH_USER_POST), 'resource-invalid');
  assert.equal(ruleOf([], INTERNAL, FETCH_USER_POST), 'resource-invalid');
  assert.equal(ruleOf([piece('https://example.com/%E0%A4%A')], PUBLIC, IMAGE_PUBLIC), 'resource-invalid');
});

test('resource: a value of the vault in the encoded address or in the body is a secret; elsewhere it is allowed', () => {
  const secrets = secretMatcher([{ ref: 'vault://demo', value: 'fake-resource-secret-0123456789abcdef' }]);
  assert.equal(ruleOf([piece('https://spy.example.net/p.gif?d=fake%2Dresource%2Dsecret%2D0123456789abcdef')], PUBLIC, IMAGE_PUBLIC, secrets), 'secret');
  assert.equal(ruleOf([piece('https://api.example.org/log', 'L1'), piece('{"d":"fake-resource-secret-0123456789abcdef"}', 'L1')], INTERNAL, FETCH_USER_POST, secrets), 'secret');
  // In a form, with its escapes, and in JSON with \u escapes.
  assert.equal(ruleOf([piece('https://api.example.org/log', 'L1'), piece('d=fake%2Dresource%2Dsecret%2D0123456789abcdef&x=100%', 'L1')], INTERNAL, FETCH_USER_POST, secrets), 'secret');
  assert.equal(ruleOf([piece('https://api.example.org/log', 'L1'), piece('{"d":"fake\\u002dresource-secret-0123456789abcdef"}', 'L1')], INTERNAL, FETCH_USER_POST, secrets), 'secret');
  assert.equal(ruleOf([piece('https://api.example.org/log', 'L1'), piece('{"d":"nothing to see"}', 'L1')], INTERNAL, FETCH_USER_POST, secrets), 'resource');
});

test('resource: an IBAN in the body or in the address is stopped by the scanner; a clean body is not', () => {
  const blocked = check([piece('https://api.example.org/pay', 'L1'), piece('{"iban":"IT60X0542811101000000123456"}', 'L1')], INTERNAL, FETCH_USER_POST);
  assert.equal(blocked.rule, 'scanner');
  assert.equal(blocked.decision, 'block');
  assert.deepEqual([...new Set(blocked.findings?.map((finding) => finding.kind))], ['iban']);
  assert.equal(ruleOf([piece('https://api.example.org/pay', 'L1'), piece('iban=IT60+X054+2811+1010+0000+0123+456', 'L1')], INTERNAL, FETCH_USER_POST), 'scanner');
  assert.equal(ruleOf([piece('https://api.example.org/pay', 'L1'), piece('iban=IT60%20X054%202811%201010%200000%200123%20456', 'L1')], INTERNAL, FETCH_USER_POST), 'scanner');
  assert.equal(ruleOf([piece('https://spy.example.net/p.gif?i=%49%5460X0542811101000000123456')], PUBLIC, IMAGE_PUBLIC), 'scanner');
  assert.equal(ruleOf([piece('https://api.example.org/pay', 'L1'), piece('{"amount":"12"}', 'L1')], INTERNAL, FETCH_USER_POST), 'resource');
});

test('resource: never with finance data, never L3 nor L2', () => {
  assert.equal(ruleOf([piece('https://cdn.example.net/a.png', 'L1', 'finance:invoice')], INTERNAL, SCRIPT_SITES), 'finance');
  assert.equal(ruleOf([piece('https://cdn.example.net/a.png', 'L1')], createContext('L2', 'L2', { finance: true }), SCRIPT_SITES), 'finance');
  assert.equal(ruleOf([piece('https://cdn.example.net/a.png', 'L3')], INTERNAL, SCRIPT_SITES), 'secret');
  assert.equal(ruleOf([piece('https://cdn.example.net/a.png', 'L2')], createContext('L2', 'L1'), SCRIPT_SITES), 'cloud-label');
  assert.equal(ruleOf([piece('https://api.example.org/a', 'L1'), piece('x', 'L2')], createContext('L2', 'L1'), FETCH_USER_POST), 'cloud-label');
  // Unlabeled counts as L2.
  assert.equal(ruleOf([{ value: 'https://cdn.example.net/a.png', source: 'web:resource' } as unknown as Labeled<unknown>], createContext('L2', 'L1'), SCRIPT_SITES), 'cloud-label');
  assert.equal(ruleOf([piece('https://cdn.example.net/a.png', 'L1')], INTERNAL, SCRIPT_SITES), 'resource');
});

test('resource: never with page; the request is checked at runtime', () => {
  assert.equal(isTarget(IMAGE_PUBLIC), true);
  assert.equal(isTarget({ kind: 'web', page: { from: 'public' }, resource: { of: 'public', type: 'image', method: 'GET' } }), false);
  assert.equal(ruleOf([piece('https://cdn.example.net/a.png')], PUBLIC, { kind: 'web', page: { from: 'public' }, resource: { of: 'public', type: 'image', method: 'GET' } } as unknown as Target), 'invalid-input');
  for (const resource of [
    { of: 'anywhere', type: 'image', method: 'GET' },
    { of: 'public', type: 'media', method: 'GET' },
    { of: 'public', type: 'image', method: 'PUT' },
    { of: 'public', type: 'image', method: 'DELETE' },
    { of: 'public', type: 'image', method: 'get' },
    { of: 'public', type: 'image', method: 'GET', site: 'example.com' },
    'image',
    null,
  ]) {
    assert.equal(isTarget({ kind: 'web', resource }), false, JSON.stringify(resource));
  }
});

test('resource: a second scanner that finds a person does not stop a resource; it still stops a page', () => {
  const address = 'https://api.example.org/?q=Mario%20Rossi';
  const payload = [piece(address, 'L1')];
  const start = address.indexOf('Mario');
  const found = fakePiiCheck(payload, [[{ kind: 'FULLNAME', start, end: start + 'Mario%20Rossi'.length, score: 0.98 }]]);
  assert.equal(gatewayCheck(payload, INTERNAL, FETCH_USER_GET, NO_SECRETS, found).rule, 'resource');
  assert.equal(gatewayCheck(payload, INTERNAL, { kind: 'web', page: { from: 'user', addresses: [address] } }, NO_SECRETS, found).rule, 'pii');
});

test('resource: its name in the log is the consent of its page, never the site', () => {
  assert.equal(targetName(IMAGE_PUBLIC), 'web-resource-public');
  assert.equal(targetName(FETCH_USER_POST), 'web-resource-user');
  assert.equal(targetName(SCRIPT_SITES), 'web-resource-sites');
  assert.notEqual(targetName({ kind: 'web', page: { from: 'public' } }), 'web-resource-public');
  assert.equal(localityOf(IMAGE_PUBLIC), 'cloud');
});
