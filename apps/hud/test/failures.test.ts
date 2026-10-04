import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatCanHelp, claudeAnswersSystemChat, failureText } from '../src/lib/failures.ts';

test('a local model that is down is explained with its server and port, and the steps to start it', () => {
  const text = failureText({ code: 'local-model.unavailable', details: { endpoint: 'omlx', port: 7001, attempts: 3 } });
  assert.equal(text.title, 'Il modello locale non risponde');
  assert.match(text.explanation, /il server omlx \(porta 7001\)/);
  assert.match(text.explanation, /Ho provato 3 volte\./);
  assert.ok(text.steps.some((step) => /oMLX/.test(step)));
  assert.match(text.steps.at(-1) ?? '', /Riprova/);
});

test('missing details give a plainer text, never "undefined"', () => {
  for (const code of ['local-model.unavailable', 'local-model.http', 'engine.step-failed', 'engine.database', 'local-model.timeout']) {
    const text = failureText({ code, details: {} });
    assert.doesNotMatch(`${text.explanation} ${text.steps.join(' ')}`, /undefined|null|NaN|\s{2}/, code);
  }
  assert.match(failureText({ code: 'local-model.unavailable', details: {} }).explanation, /il server del modello locale/);
  assert.match(failureText({ code: 'local-model.http', details: { status: 503 } }).explanation, /stato HTTP 503/);
});

test('an unknown code gets a generic text, and claude codes a common one', () => {
  const unknown = failureText({ code: 'engine.made-up', details: { error: 'Weird' } });
  assert.equal(unknown.title, 'Errore imprevisto');
  assert.doesNotMatch(unknown.explanation, /made-up|Weird/);
  assert.equal(failureText({ code: 'claude.exit', details: {} }).title, 'Claude Code si è fermato');
});

test('the system chat is not offered as the fix when the local model is the problem', () => {
  assert.equal(chatCanHelp({ origin: 'local-model' }), false);
  assert.equal(chatCanHelp({ origin: 'engine' }), true);
});

test('with Claude answering the system chat, it is offered even when the local model is down', () => {
  assert.equal(chatCanHelp({ origin: 'local-model' }, true), true);
  const local = failureText({ code: 'local-model.unavailable', details: {} });
  const claude = failureText({ code: 'local-model.unavailable', details: {} }, true);
  assert.ok(local.steps.some((step) => /stesso modello locale/.test(step)));
  assert.ok(!claude.steps.some((step) => /stesso modello locale/.test(step)));
  assert.ok(claude.steps.some((step) => /risponde Claude/.test(step)));
  assert.equal(claude.steps.length, local.steps.length);
});

test('Claude answers a system chat only from a work conversation with Sonnet turned on, as the core opens it', () => {
  const sonnet = [{ executor: 'claude', model: 'sonnet' }];
  assert.equal(claudeAnswersSystemChat('work', sonnet), true);
  assert.equal(claudeAnswersSystemChat('private', sonnet), false);
  assert.equal(claudeAnswersSystemChat(undefined, sonnet), false);
  assert.equal(claudeAnswersSystemChat('work', []), false);
  assert.equal(claudeAnswersSystemChat('work', [{ executor: 'claude', model: 'fable' }]), false);
  assert.equal(claudeAnswersSystemChat('work', [{ executor: 'claude', model: 'opus' }]), false);
  assert.equal(claudeAnswersSystemChat('work', [{ executor: 'codex', model: 'sonnet' }]), false);
});
