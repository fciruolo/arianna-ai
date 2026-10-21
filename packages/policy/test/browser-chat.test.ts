import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createContext,
  fakePiiCheck,
  gatewayCheck,
  isTarget,
  PolicyError,
  recordRead,
  recordUserMessage,
  secretMatcher,
  targetName,
  type Context,
  type Labeled,
  type Target,
} from '../src/index.ts';

// D-281: the Private chat the agent's browser passes to after an access made by the user. Its context has
// read L2 only from the site of the access and from the user (`browserSite`, declared by the core): it sends
// requests, forms and typed text towards that site only, never anything anywhere else.
const SITE = 'biblioteca-finta.it';
const CHAT = createContext('L2', 'L2', { browserSite: SITE });
const PRIVATE = createContext('L2', 'L2');
const INTERNAL = createContext('L1', 'L1');

const PAGE: Target = { kind: 'web', session: { site: SITE, type: 'document', method: 'GET' } };
const FETCH_POST: Target = { kind: 'web', session: { site: SITE, type: 'fetch', method: 'POST' } };
const FORM: Target = { kind: 'web', form: { site: SITE, bytes: 42 } };
const TYPED: Target = { kind: 'web', typed: 'session', site: SITE };

const piece = (value: unknown, label: Labeled<unknown>['label'] = 'L2', source = 'browser:session'): Labeled<unknown> => ({ value, label, source });
const NO_SECRETS = secretMatcher([]);
const check = (payload: readonly Labeled<unknown>[], context: Context, target: Target, secrets = NO_SECRETS) => gatewayCheck(payload, context, target, secrets, fakePiiCheck(payload));
const ruleOf = (payload: readonly Labeled<unknown>[], context: Context, target: Target, secrets = NO_SECRETS) => check(payload, context, target, secrets).rule;

test('browser chat: a context marked with the site of the access sends L2 requests and forms to that site', () => {
  const page = check([piece('https://www.biblioteca-finta.it/prestiti')], CHAT, PAGE);
  assert.equal(page.decision, 'allow');
  assert.equal(page.rule, 'session');
  assert.equal(page.label, 'L2');
  assert.equal(ruleOf([piece('https://api.biblioteca-finta.it/rinnova'), piece('{"prestito":"7"}')], CHAT, FETCH_POST), 'session');
  assert.equal(ruleOf([piece('https://www.biblioteca-finta.it/rinnova')], CHAT, FORM), 'form');
});

test('browser chat: the same requests from a private context without the mark stay local', () => {
  assert.equal(ruleOf([piece('https://www.biblioteca-finta.it/prestiti')], PRIVATE, PAGE), 'contaminated');
  assert.equal(ruleOf([piece('https://www.biblioteca-finta.it/rinnova')], PRIVATE, FORM), 'contaminated');
});

test('browser chat: never towards another site, whatever the target says', () => {
  const other: Target = { kind: 'web', session: { site: 'tracker-finto.net', type: 'image', method: 'GET' } };
  assert.equal(ruleOf([piece('https://tracker-finto.net/p.gif?u=7')], CHAT, other), 'contaminated');
  assert.equal(ruleOf([piece('https://tracker-finto.net/x')], CHAT, { kind: 'web', form: { site: 'tracker-finto.net', bytes: 3 } }), 'contaminated');
  assert.equal(ruleOf([piece('https://tracker-finto.net/p.gif')], CHAT, PAGE), 'session-invalid');
  assert.equal(ruleOf([piece('https://tracker-finto.net/', 'L2')], CHAT, { kind: 'web', page: { from: 'sites', sites: ['tracker-finto.net'] } }), 'contaminated');
  assert.equal(ruleOf([piece('https://tracker-finto.net/', 'L2')], CHAT, { kind: 'web', resource: { of: 'sites', type: 'image', method: 'GET' } }), 'contaminated');
});

test('browser chat: no other cloud target, no channel, no web search', () => {
  assert.equal(ruleOf([piece('rinnova i prestiti', 'L2', 'user')], CHAT, { kind: 'executor', id: 'claude', locality: 'cloud' }), 'contaminated');
  assert.equal(ruleOf([piece('ciao', 'L2', 'user')], CHAT, { kind: 'channel', id: 'telegram' }), 'contaminated');
  assert.equal(ruleOf([piece('libri', 'L2', 'user')], CHAT, { kind: 'web' }), 'contaminated');
  // Local targets take it, as for any private context.
  assert.equal(ruleOf([piece('ciao', 'L2', 'user')], CHAT, { kind: 'executor', id: 'local', locality: 'local' }), 'local');
});

test('browser chat: typed text goes to the site of the access only from its chat, scanned, without the second check', () => {
  const typed = check([piece('Il nome della rosa', 'L2', 'browser:typed')], CHAT, TYPED);
  assert.equal(typed.decision, 'allow');
  assert.equal(typed.rule, 'typed');
  assert.equal(typed.label, 'L2');
  assert.equal(targetName(TYPED), 'web-typed-session');
  // From a context without the mark, or with another site: refused.
  assert.equal(ruleOf([piece('Il nome della rosa')], PRIVATE, TYPED), 'typed-invalid');
  assert.equal(ruleOf([piece('Il nome della rosa', 'L1')], INTERNAL, TYPED), 'typed-invalid');
  assert.equal(ruleOf([piece('Il nome della rosa')], CHAT, { kind: 'web', typed: 'session', site: 'altra-biblioteca.it' }), 'typed-invalid');
  // The scanner reads it; a name the second scanner would find is not read.
  assert.equal(ruleOf([piece('IT60X0542811101000000123456')], CHAT, TYPED), 'scanner');
  const name = [piece('Mario Rossi')];
  assert.equal(gatewayCheck(name, CHAT, TYPED, NO_SECRETS, fakePiiCheck(name, [[{ kind: 'FULLNAME', start: 0, end: 11, score: 0.99 }]])).rule, 'typed');
  // Its shape: one text, at most 200 characters, no control characters.
  assert.equal(ruleOf([piece('a'.repeat(201))], CHAT, TYPED), 'typed-invalid');
  assert.equal(ruleOf([piece('riga\nnuova')], CHAT, TYPED), 'typed-invalid');
  assert.equal(ruleOf([piece('uno'), piece('due')], CHAT, TYPED), 'typed-invalid');
});

test('browser chat: never L3, never a value of the vault', () => {
  assert.equal(ruleOf([piece('https://www.biblioteca-finta.it/x', 'L3')], CHAT, PAGE), 'secret');
  const secrets = secretMatcher([{ ref: 'vault://biblioteca', value: 'fake-browser-chat-canary-91c4' }]);
  assert.equal(ruleOf([piece('fake-browser-chat-canary-91c4')], CHAT, TYPED, secrets), 'secret');
  assert.equal(ruleOf([piece('https://www.biblioteca-finta.it/x?k=fake-browser-chat-canary-91c4')], CHAT, PAGE, secrets), 'secret');
});

test('browser chat: the target shape: the site only with typed session, and there a host name', () => {
  assert.equal(isTarget(TYPED), true);
  assert.equal(isTarget({ kind: 'web', typed: 'session' }), false);
  assert.equal(isTarget({ kind: 'web', typed: 'session', site: 'https://biblioteca-finta.it' }), false);
  assert.equal(isTarget({ kind: 'web', typed: 'session', site: 'it' }), false);
  assert.equal(isTarget({ kind: 'web', typed: 'user', site: SITE }), false);
  assert.equal(isTarget({ kind: 'web', session: { site: SITE, type: 'document', method: 'GET' }, site: SITE }), false);
  assert.equal(isTarget({ kind: 'web', page: { from: 'public' }, site: SITE }), false);
});

test('browser chat: the context: cleared for L2, a host name, never with finance data', () => {
  assert.throws(() => createContext('L1', 'L1', { browserSite: SITE }), PolicyError);
  assert.throws(() => createContext('L2', 'L2', { browserSite: 'https://biblioteca-finta.it/' }), PolicyError);
  assert.throws(() => createContext('L2', 'L2', { browserSite: SITE, finance: true }), PolicyError);
  assert.equal(CHAT.browserSite, SITE);
  assert.equal(PRIVATE.browserSite, undefined);
});

test('browser chat: a read of L2 from another source drops the mark; the site and the user keep it', () => {
  const fresh = createContext('L2', 'L0', { browserSite: SITE });
  const fromSite = recordRead(fresh, 'L2', 'browser:read');
  assert.equal(fromSite.context.browserSite, SITE);
  assert.equal(recordUserMessage(fresh).browserSite, SITE);
  assert.equal(recordRead(fresh, 'L1', 'kb:note').context.browserSite, SITE);
  const note = recordRead(fresh, 'L2', 'kb:private-note');
  assert.equal(note.context.browserSite, undefined);
  assert.equal(ruleOf([piece('https://www.biblioteca-finta.it/prestiti')], note.context, PAGE), 'contaminated');
  // Without a source an L2 read drops it too: it fails closed.
  assert.equal(recordRead(fresh, 'L2').context.browserSite, undefined);
  // Finance data marks the context and drops the site.
  const finance = recordRead(fresh, 'L2', 'finance:transactions');
  assert.equal(finance.context.browserSite, undefined);
  assert.equal(finance.context.finance, true);
});
