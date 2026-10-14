import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createContext,
  fakePiiCheck,
  gatewayCheck,
  piiReport,
  piiUnavailable,
  piiVerdict,
  secretMatcher,
  type Labeled,
  type PiiCheck,
  type PiiEntity,
  type Target,
} from '../src/index.ts';

const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
const TELEGRAM: Target = { kind: 'channel', id: 'telegram' };
const LOCAL_MODEL: Target = { kind: 'executor', id: 'omlx', locality: 'local' };
const LINK: Target = { kind: 'link', consent: 'click' };

const fragment = (value: unknown, label: 'L0' | 'L1' | 'L2' = 'L1'): Labeled<unknown> => ({ value, label, source: 'test' });
const entity = (text: string, value: string, kind: string): PiiEntity => {
  const start = text.indexOf(value);
  assert.ok(start >= 0, 'the value is in the text');
  return { kind, start, end: start + value.length, score: 0.98 };
};
const check = (payload: Labeled<unknown>[], target: Target, pii: PiiCheck) => gatewayCheck(payload, createContext('L1'), target, secretMatcher([]), pii);

test('a person found by the second scanner blocks an exit to a cloud executor', () => {
  const text = 'Scrivi a Mario Rossi per il preventivo';
  const decision = check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [[entity(text, 'Mario Rossi', 'FULLNAME')]]));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
  assert.equal(decision.next, 'wait-user');
  assert.deepEqual(decision.pii, [{ kind: 'FULLNAME', fragment: 0 }]);
  assert.ok(!decision.reason.includes('Mario'), 'the reason names kinds, never the text');
});

test('a finding towards Telegram notifies with a reference', () => {
  const text = 'Chiama il 333 1234567';
  const decision = check([fragment(text)], TELEGRAM, fakePiiCheck([fragment(text)], [[entity(text, '333 1234567', 'TELEPHONENUM')]]));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
  assert.equal(decision.next, 'notify-reference');
});

test('nothing found lets a clean text go to the cloud', () => {
  const payload = [fragment('Aggiungi un test per la somma')];
  const decision = check(payload, CLAUDE, fakePiiCheck(payload));
  assert.ok(decision.decision === 'allow');
  assert.equal(decision.reason, 'L1 to a cloud target, scan clean', 'both scanners clean');
});

test('kinds that alone point at no one do not block, every other kind does', () => {
  const text = 'Il 3 marzo alle 10 a Milano, porta 7420, 40 anni, 120 euro, Acme srl';
  const harmless: PiiEntity[] = [
    entity(text, '3 marzo', 'DATE'),
    entity(text, '10', 'TIME'),
    entity(text, 'Milano', 'CITY'),
    entity(text, '7420', 'BUILDINGNUM'),
    entity(text, '40 anni', 'AGE'),
    entity(text, '120 euro', 'AMOUNT'),
    entity(text, 'Acme srl', 'ORG'),
  ];
  assert.equal(check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [harmless])).decision, 'allow');
  const unknown = check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [[entity(text, 'Acme srl', 'BRANDNEW')]]));
  assert.ok(unknown.decision === 'block');
  assert.equal(unknown.rule, 'pii', 'a kind the policy does not know blocks');
});

test('a house number with a postcode is an address, either alone is not', () => {
  const text = 'Consegna al 12, 20121';
  const both = check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [[entity(text, '12', 'BUILDINGNUM'), entity(text, '20121', 'ZIPCODE')]]));
  assert.ok(both.decision === 'block');
  assert.deepEqual(both.pii, [{ kind: 'ADDRESS', fragment: 0 }]);
  assert.equal(check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [[entity(text, '20121', 'ZIPCODE')]])).decision, 'allow');
});

test('the name of the assistant and of the agents is not a person, a longer name is', () => {
  const text = 'Arianna chiede al Coder Bruno di parlare con Arianna Bianchi';
  const names = [entity(text, 'Arianna', 'FULLNAME'), entity(text, 'Bruno', 'FULLNAME')];
  const texts = [text];
  assert.equal(check([fragment(text)], CLAUDE, piiReport(texts, [names], ['Bruno'])).decision, 'allow');
  const withoutAgent = check([fragment(text)], CLAUDE, piiReport(texts, [names]));
  assert.ok(withoutAgent.decision === 'block', 'Bruno is a person when no agent has that name');
  const person = check([fragment(text)], CLAUDE, piiReport(texts, [[entity(text, 'Arianna Bianchi', 'FULLNAME')]], ['Bruno']));
  assert.ok(person.decision === 'block');
  assert.equal(person.rule, 'pii');
});

test('an ignored name only covers FULLNAME', () => {
  const text = 'Arianna';
  assert.equal(check([fragment(text)], CLAUDE, piiReport([text], [[{ kind: 'EMAIL', start: 0, end: 7, score: 0.9 }]])).decision, 'block');
});

test('no answer blocks: off, starting, timeout, error', () => {
  for (const reason of ['off', 'starting', 'timeout', 'error'] as const) {
    const decision = check([fragment('Aggiungi un test')], CLAUDE, piiUnavailable(reason));
    assert.ok(decision.decision === 'block', reason);
    assert.equal(decision.rule, 'pii-unavailable');
    assert.equal(decision.next, 'wait-user');
    assert.match(decision.reason, new RegExp(reason));
  }
});

test('on a development installation no answer lets the exit go, and says so', () => {
  const decision = check([fragment('Aggiungi un test')], CLAUDE, piiUnavailable('off', true));
  assert.ok(decision.decision === 'allow');
  assert.match(decision.reason, /second check skipped on a development installation \(off\)/);
});

test('development never skips a finding', () => {
  const text = 'Scrivi a mario.rossi@example.it';
  const decision = check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [[entity(text, 'mario.rossi@example.it', 'EMAIL')]]));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
});

test('an answer of the wrong shape is a check that did not happen', () => {
  const text = 'Aggiungi un test';
  const malformed: unknown[] = [
    undefined,
    'nothing',
    [],
    [[], []],
    [[{ kind: 'FULLNAME', start: 0, end: 99, score: 1 }]],
    [[{ kind: 'FULLNAME', start: 3, end: 3, score: 1 }]],
    [[{ kind: 'FULLNAME', start: -1, end: 2, score: 1 }]],
    [[{ kind: 'FULLNAME', start: 0.5, end: 2, score: 1 }]],
    [[{ kind: 'full name', start: 0, end: 2, score: 1 }]],
    [[{ kind: 'FULLNAME', start: 0, end: 2, score: Number.NaN }]],
    [[null]],
  ];
  for (const answer of malformed) {
    const decision = check([fragment(text)], CLAUDE, piiReport([text], answer));
    assert.ok(decision.decision === 'block', JSON.stringify(answer));
    assert.equal(decision.rule, 'pii-unavailable');
    assert.match(decision.reason, /malformed/);
  }
  assert.equal(check([fragment(text)], CLAUDE, piiReport([text], [[{ kind: 'DATE', start: 0, end: 2, score: 1 }]])).decision, 'allow');
});

test('a check made for other texts, or not made here, is no check', () => {
  const scanned = fakePiiCheck([fragment('un altro testo')]);
  const other = check([fragment('Aggiungi un test')], CLAUDE, scanned);
  assert.ok(other.decision === 'block');
  assert.equal(other.rule, 'pii-unavailable');
  assert.match(other.reason, /other-texts/);
  const forged = check([fragment('Aggiungi un test')], CLAUDE, Object.freeze({ brand: 'pii-check' }));
  assert.ok(forged.decision === 'block');
  assert.match(forged.reason, /not-checked/);
  const missing = gatewayCheck([fragment('Aggiungi un test')], createContext('L1'), CLAUDE, secretMatcher([]), undefined as unknown as PiiCheck);
  assert.ok(missing.decision === 'block');
  assert.equal(missing.rule, 'pii-unavailable');
  assert.deepEqual(piiVerdict(scanned, ['un altro testo']), { verdict: 'clean' });
});

test('the check binds each fragment: a finding in the second fragment names it', () => {
  const first = 'Aggiungi un test';
  const second = 'per Laura Verdi';
  const payload = [fragment(first), fragment(second)];
  const decision = check(payload, CLAUDE, fakePiiCheck(payload, [[], [entity(second, 'Laura Verdi', 'FULLNAME')]]));
  assert.ok(decision.decision === 'block');
  assert.deepEqual(decision.pii, [{ kind: 'FULLNAME', fragment: 1 }]);
});

test('JSON fragments are checked as the gateway serializes them', () => {
  const value = { to: 'Laura Verdi' };
  const text = JSON.stringify(value);
  const decision = check([fragment(value)], CLAUDE, piiReport([text], [[entity(text, 'Laura Verdi', 'FULLNAME')]]));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
});

test('local targets and links are not read by the second scanner', () => {
  assert.equal(gatewayCheck([fragment('Mario Rossi', 'L2')], createContext('L2'), LOCAL_MODEL, secretMatcher([]), piiUnavailable('off')).decision, 'allow');
  assert.equal(check([fragment('https://example.com/pagina')], LINK, piiUnavailable('off')).decision, 'allow');
});

test('the deterministic rules come first', () => {
  const decision = check([fragment('IBAN IT60X0542811101000000123456')], CLAUDE, piiUnavailable('off'));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'scanner');
  const l2 = gatewayCheck([fragment('fake text', 'L2')], createContext('L2', 'L1'), CLAUDE, secretMatcher([]), fakePiiCheck([fragment('fake text', 'L2')]));
  assert.ok(l2.decision === 'block');
  assert.equal(l2.rule, 'cloud-label', 'a clean second scan never lets L2 out');
});
