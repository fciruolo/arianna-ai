import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { proposalErrorText, releaseErrorText, releaseProject, targetText, warningText } from '../src/lib/note-release.ts';

test('releaseErrorText: the refusals of the core in Italian, never its words (D-187)', () => {
  assert.match(releaseErrorText(new ApiError(403, 'wrong-password: wrong master password')), /^Master password sbagliata/);
  assert.match(releaseErrorText(new ApiError(429, 'locked: too many wrong passwords: try again in a few minutes')), /bloccata/);
  assert.match(releaseErrorText(new ApiError(503, 'no-password: no master password in the vault')), /pnpm vault:master/);
  assert.match(releaseErrorText(new ApiError(403, 'not-private: a Reserved note never leaves')), /Riservata non esce mai/);
  assert.match(releaseErrorText(new ApiError(409, 'changed: the note changed after it was opened')), /cambiata/);
  assert.match(releaseErrorText(new ApiError(400, 'target: choose a work conversation of the project')), /conversazione di lavoro/);
  assert.match(releaseErrorText(new ApiError(422, 'a work conversation cannot hold this message (iban)')), /scanner/);
  assert.match(releaseErrorText(new ApiError(409, 'the Coder is still working on the previous message')), /Coder sta ancora lavorando/);
  assert.doesNotMatch(releaseErrorText(new ApiError(403, 'wrong-password: wrong master password')), /wrong/);
});

test('proposalErrorText: why there is no anonymous version, with the way out', () => {
  assert.match(proposalErrorText(new ApiError(503, 'anonymous version not written: unavailable')), /oMLX/);
  assert.match(proposalErrorText(new ApiError(504, 'anonymous version not written: timeout')), /in tempo/);
  assert.match(proposalErrorText(new ApiError(409, 'an anonymous version is already being written')), /già/);
  assert.match(proposalErrorText(new ApiError(502, 'anonymous version not written: bad-response')), /scrivi tu/);
});

test('warningText: what the scanner still finds, or nothing', () => {
  assert.equal(warningText([]), null);
  assert.match(warningText(['iban']) ?? '', /c’è ancora: IBAN\./);
  assert.match(warningText(['iban', 'tax-code', 'token']) ?? '', /IBAN, codice fiscale e token o chiave di accesso/);
});

test('targetText: the title of the conversation, the project when it has none', () => {
  assert.equal(targetText({ title: 'Login con Google', workspace: 'progetto', agent: null }), 'Login con Google');
  assert.equal(targetText({ title: null, workspace: 'progetto:admin', agent: null }), 'Senza titolo (progetto:admin)');
  assert.equal(targetText({ title: ' ', workspace: 'p', agent: 'coder' }), 'Senza titolo (p) · chat diretta');
});

test('releaseProject: only a work chat on a project offers its Private notes', () => {
  assert.equal(releaseProject({ mode: 'work', workspace: 'progetto-test' }), 'progetto-test');
  assert.equal(releaseProject({ mode: 'work', workspace: 'progetto-test:progetto-test-admin' }), 'progetto-test');
  assert.equal(releaseProject({ mode: 'work', workspace: null }), null);
  assert.equal(releaseProject({ mode: 'private', workspace: 'progetto-test' }), null);
  assert.equal(releaseProject({ mode: 'work', workspace: 'progetto-test', incognito: true }), null);
  assert.equal(releaseProject({ mode: 'work', workspace: 'progetto-test', finance: true }), null);
  assert.equal(releaseProject({ mode: 'work', workspace: 'progetto-test', archivedAt: '2026-10-12T10:00:00Z' }), null);
  assert.equal(releaseProject({ mode: 'work', workspace: 'repos/demo' }), null);
});
