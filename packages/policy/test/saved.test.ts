import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addressReadings,
  createContext,
  savedForms,
  fakePiiCheck,
  gatewayCheck,
  piiUnavailable,
  savedForm,
  savedMatcher,
  secretMatcher,
  type Context,
  type Decision,
  type Labeled,
  type PiiCheck,
  type SavedCheck,
  type Target,
} from '../src/index.ts';

// D-283: in the agent's browser and in web.fetch the saved private values of the user (clients and
// contacts) take the place of the second scanner on the address of a page and on a typed text.
// Fake values only.
const KNOWN = savedMatcher([
  { ref: 'client:c1:name', value: 'Ferramenta Lunardi Srl' },
  { ref: 'client:c1:person', value: 'Gilda Lunardi' },
  { ref: 'client:c1:address', value: 'Via dei Glicini 14' },
  { ref: 'client:c1:email', value: 'amministrazione@ferramenta-lunardi.example' },
  { ref: 'client:c1:phone', value: '+39 0471 552 908', phone: true },
  { ref: 'contact:k1:name', value: 'Ottavio Brenta' },
  { ref: 'contact:k1:mobile', value: '347 120 9981', phone: true },
  { ref: 'client:c2:name', value: 'Caffè Ròsa' },
  // Too short: never compared.
  { ref: 'client:c3:name', value: 'Bar' },
  { ref: 'contact:k3:phone', value: '12 34', phone: true },
]);
const NONE: ReadonlySet<string> = new Set();
const saved = (approved: ReadonlySet<string> = NONE): SavedCheck => ({ known: KNOWN, approved });

const PUBLIC = createContext('L1', 'L0');
const INTERNAL = createContext('L1', 'L1');
const SITE = 'biblioteca-finta.it';
const CHAT = createContext('L2', 'L2', { browserSite: SITE });

const PAGE_PUBLIC: Target = { kind: 'web', page: { from: 'public' } };
const TYPED_PUBLIC: Target = { kind: 'web', typed: 'public' };
const TYPED_USER: Target = { kind: 'web', typed: 'user' };
const RESOURCE: Target = { kind: 'web', resource: { of: 'public', type: 'fetch', method: 'GET' } };
const SESSION: Target = { kind: 'web', session: { site: SITE, type: 'fetch', method: 'GET' } };

const piece = (value: unknown, label: Labeled<unknown>['label'] = 'L0', source = 'web:page'): Labeled<unknown> => ({ value, label, source });
/** A second scanner that would find a person in every fragment: with `saved` it must never decide. */
const personEverywhere = (payload: readonly Labeled<unknown>[]): PiiCheck =>
  fakePiiCheck(payload, payload.map((fragment) => [{ kind: 'FULLNAME', start: 0, end: Math.min(5, String(fragment.value).length), score: 0.99 }]));

const check = (payload: readonly Labeled<unknown>[], context: Context, target: Target, check?: SavedCheck, pii: PiiCheck = piiUnavailable('off')) =>
  gatewayCheck(payload, context, target, secretMatcher([]), pii, check);
const savedOf = (decision: Decision) => (decision.decision === 'block' ? decision.saved : undefined);
const nextOf = (decision: Decision) => (decision.decision === 'block' ? decision.next : undefined);

test('saved form: no case, accents, punctuation nor double spaces', () => {
  assert.equal(savedForm('  Caffè   Ròsa, S.r.l. '), 'caffe rosa s r l');
  assert.equal(savedForm('ＦＥＲＲＡＭＥＮＴＡ'), 'ferramenta');
});

test('saved matcher: whole words only, references never values', () => {
  assert.deepEqual(KNOWN.find('Ferramenta lunardi SRL a Bolzano'), ['client:c1:name']);
  assert.deepEqual(KNOWN.find('cerca: caffe rosa'), ['client:c2:name']);
  // A piece of a word is not the value.
  assert.deepEqual(KNOWN.find('ferramenta lunardisrl'), []);
  // The surname alone, or a city, does not count.
  assert.deepEqual(KNOWN.find('Lunardi Bolzano'), []);
  // A short value is never compared.
  assert.deepEqual(KNOWN.find('un bar a Torino'), []);
  assert.deepEqual(KNOWN.find('via dei glicini, 14 - Bolzano'), ['client:c1:address']);
  assert.deepEqual(KNOWN.find('scrivi a amministrazione@ferramenta-lunardi.example'), ['client:c1:email']);
});

test('saved matcher: a phone by its digits, with or without the prefix, as a whole number', () => {
  assert.deepEqual(KNOWN.find('tel. 0471-552908'), ['client:c1:phone']);
  assert.deepEqual(KNOWN.find('chiama +39 347 1209981'), ['contact:k1:mobile']);
  assert.deepEqual(KNOWN.find('3471209981'), ['contact:k1:mobile']);
  // A longer number around it is another number.
  assert.deepEqual(KNOWN.find('codice 934712099817'), []);
  // Next to other digits: a civic number before it, another number after it.
  assert.deepEqual(KNOWN.find('Via Glicini 14 0471 552908'), ['client:c1:phone']);
  assert.deepEqual(KNOWN.find('0471 552908 / 347 1209981').sort(), ['client:c1:phone', 'contact:k1:mobile']);
  // Fewer than six digits are never a saved phone.
  assert.deepEqual(KNOWN.find('12 34'), []);
});

test('saved forms: dots and apostrophes inside a word count as written and as taken away', () => {
  const known = savedMatcher([
    { ref: 'client:r1:name', value: 'Rossi S.r.l.' },
    { ref: 'client:r2:person', value: "Mario D'Angelo" },
    { ref: 'client:r3:name', value: 'Bianchi Srl' },
  ]);
  assert.deepEqual(known.find('cerca Rossi Srl'), ['client:r1:name']);
  assert.deepEqual(known.find('cerca rossi s.r.l. a Torino'), ['client:r1:name']);
  assert.deepEqual(known.find('mario dangelo'), ['client:r2:person']);
  assert.deepEqual(known.find('Mario DAngelo'), ['client:r2:person']);
  assert.deepEqual(known.find("Mario D'Angelo"), ['client:r2:person']);
  assert.deepEqual(known.find('Bianchi S.r.l.'), ['client:r3:name']);
  // Words apart stay apart: no value made by gluing two words of the text.
  assert.deepEqual(known.find('mario d angelo'), ['client:r2:person']);
  assert.deepEqual(known.find('rossi s r l'), ['client:r1:name']);
  assert.deepEqual(known.find('Rossini Srl'), []);
  assert.deepEqual(savedForms("D'Angelo"), ['d angelo', 'dangelo']);
  assert.deepEqual(savedForms('Rossi'), ['rossi']);
});

test('address readings: decoded again while they change, at most three times', () => {
  const known = savedMatcher([{ ref: 'contact:k9:contact-name', value: 'Mario Rossi' }]);
  assert.ok(addressReadings('https://cerca.example/?q=Mario%2520Rossi').some((reading) => known.find(reading).length > 0));
  assert.ok(addressReadings('https://cerca.example/?q=Mario%252520Rossi').some((reading) => known.find(reading).length > 0));
  // A fourth encoding is not taken apart.
  assert.ok(!addressReadings('https://cerca.example/?q=Mario%25252520Rossi').some((reading) => known.find(reading).length > 0));
  assert.equal(addressReadings('https://cerca.example/?q=orari').length, 1);
});

test('address readings: as written, decoded, and + as a space', () => {
  assert.deepEqual(addressReadings('https://cerca.example/?q=via+dei%20glicini'), [
    'https://cerca.example/?q=via+dei%20glicini',
    'https://cerca.example/?q=via dei glicini',
    'https://cerca.example/?q=via+dei glicini',
  ]);
});

test('saved-private: a page address with a saved value asks the user, naming kinds only', () => {
  const decision = check([piece('https://cerca.example/?q=Ferramenta+Lunardi+Srl')], PUBLIC, PAGE_PUBLIC, saved());
  assert.equal(decision.decision, 'block');
  assert.equal(decision.rule, 'saved-private');
  assert.equal(nextOf(decision), 'ask-user');
  assert.deepEqual(savedOf(decision), ['client:c1:name']);
  assert.doesNotMatch(decision.reason, /lunardi|c1/i);
  // Encoded in the path too.
  const encoded = check([piece('https://cerca.example/Gilda%20Lunardi')], PUBLIC, PAGE_PUBLIC, saved());
  assert.deepEqual(savedOf(encoded), ['client:c1:person']);
});

test('saved-private: a value the user approved passes, without the second scanner', () => {
  const payload = [piece('https://cerca.example/?q=Ferramenta+Lunardi+Srl')];
  const decision = check(payload, PUBLIC, PAGE_PUBLIC, saved(new Set(['client:c1:name'])), personEverywhere(payload));
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.rule, 'page');
  assert.match(decision.reason, /saved values compared, no second check/);
  // Another value of the same address is still asked.
  const two = check([piece('https://cerca.example/?q=Ferramenta+Lunardi+Srl+Ottavio+Brenta')], PUBLIC, PAGE_PUBLIC, saved(new Set(['client:c1:name'])));
  assert.deepEqual(savedOf(two), ['contact:k1:name']);
});

test('saved-private: a name like a saved one but not equal passes, and the second scanner is not asked', () => {
  const payload = [piece('https://cerca.example/?q=Ferramenta+Lunardini')];
  // Without the saved values the second scanner decides: unavailable here, so it blocks.
  assert.equal(check(payload, PUBLIC, PAGE_PUBLIC).rule, 'pii-unavailable');
  // With them it is never asked, whatever it would say.
  const decision = check(payload, PUBLIC, PAGE_PUBLIC, saved(), personEverywhere(payload));
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.rule, 'page');
});

test('saved-private: a typed text with a saved value asks the user; another text passes', () => {
  const decision = check([piece('Ottavio Brenta', 'L1', 'browser:typed')], INTERNAL, TYPED_USER, saved());
  assert.equal(decision.rule, 'saved-private');
  assert.equal(nextOf(decision), 'ask-user');
  assert.deepEqual(savedOf(decision), ['contact:k1:name']);
  const other = [piece('orari biblioteca', 'L0', 'browser:typed')];
  const allowed = check(other, PUBLIC, TYPED_PUBLIC, saved(), personEverywhere(other));
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.rule, 'typed');
});

test('saved-private: the vault still blocks first, whatever the user approved', () => {
  const secrets = secretMatcher([{ ref: 'vault://chiave-finta', value: 'chiave-finta-1234567' }]);
  const decision = gatewayCheck([piece('https://cerca.example/?q=chiave-finta-1234567')], PUBLIC, PAGE_PUBLIC, secrets, piiUnavailable('off'), saved());
  assert.equal(decision.rule, 'secret');
  const typed = gatewayCheck([piece('chiave-finta-1234567', 'L0', 'browser:typed')], PUBLIC, TYPED_PUBLIC, secrets, piiUnavailable('off'), saved());
  assert.equal(typed.rule, 'secret');
});

test('saved-private: the scanner still blocks first (an IBAN, a tax code)', () => {
  const iban = check([piece('https://cerca.example/?q=IT60X0542811101000000123456')], PUBLIC, PAGE_PUBLIC, saved());
  assert.equal(iban.rule, 'scanner');
  const code = check([piece('RSSMRA85T10A562S', 'L0', 'browser:typed')], PUBLIC, TYPED_PUBLIC, saved());
  assert.equal(code.rule, 'scanner');
});

test('saved-private: a resource with a saved value is stopped without asking; without one it goes', () => {
  const decision = check([piece('https://track.example/p?u=amministrazione%40ferramenta-lunardi.example', 'L0', 'web:resource')], PUBLIC, RESOURCE, saved());
  assert.equal(decision.rule, 'saved-private');
  assert.equal(nextOf(decision), 'stay-local');
  // In a POST body as JSON too.
  const post: Target = { kind: 'web', resource: { of: 'public', type: 'fetch', method: 'POST' } };
  const body = check([piece('https://track.example/p', 'L0', 'web:resource'), piece('{"q":"Gilda Lunardi"}', 'L0', 'web:resource')], PUBLIC, post, saved());
  assert.equal(body.rule, 'saved-private');
  const clean = check([piece('https://cdn.example/app.js', 'L0', 'web:resource')], PUBLIC, RESOURCE, saved());
  assert.equal(clean.rule, 'resource');
  // Approved: it goes.
  const approved = check([piece('https://track.example/p?u=amministrazione%40ferramenta-lunardi.example', 'L0', 'web:resource')], PUBLIC, RESOURCE, saved(new Set(['client:c1:email'])));
  assert.equal(approved.rule, 'resource');
});

test('saved-private: a request of the site of an access from a work session is stopped too; the Private chat of the access is unchanged', () => {
  const payload = [piece('https://www.biblioteca-finta.it/prestiti?nome=Ottavio+Brenta', 'L2', 'web:resource')];
  const work = check(payload, INTERNAL, SESSION, saved());
  assert.equal(work.rule, 'saved-private');
  assert.equal(nextOf(work), 'stay-local');
  assert.equal(check(payload, CHAT, SESSION, saved()).rule, 'session');
  const typed: Target = { kind: 'web', typed: 'session', site: SITE };
  assert.equal(check([piece('Ottavio Brenta', 'L2', 'browser:typed')], CHAT, typed, saved()).rule, 'typed');
});

test('saved-private: without the check every exit is as before (the second scanner decides)', () => {
  const payload = [piece('https://cerca.example/?q=Ferramenta+Lunardi+Srl')];
  assert.equal(check(payload, PUBLIC, PAGE_PUBLIC, undefined, personEverywhere(payload)).rule, 'pii');
  assert.equal(check(payload, PUBLIC, PAGE_PUBLIC, undefined, fakePiiCheck(payload)).rule, 'page');
});

test('saved-private: a check given in a broken shape, or a matcher that throws, refuses', () => {
  const payload = [piece('https://cerca.example/?q=orari')];
  const broken = { known: KNOWN } as unknown as SavedCheck;
  assert.equal(check(payload, PUBLIC, PAGE_PUBLIC, broken).rule, 'invalid-input');
  const throwing: SavedCheck = { known: { find: () => { throw new Error('not loaded'); } }, approved: NONE };
  assert.equal(check(payload, PUBLIC, PAGE_PUBLIC, throwing).rule, 'invalid-input');
});

test('saved-private: other cloud targets are not compared, the second scanner stays', () => {
  const payload = [piece('Scrivi a Gilda Lunardi', 'L1', 'task:t1')];
  const executor: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
  assert.equal(check(payload, INTERNAL, executor, saved(), personEverywhere(payload)).rule, 'pii');
});
