// Which session a step of claude -p continues (D-111, tappa A2): pure, no database.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionToResume } from '../src/claude-step.ts';

const CRASHED = { resume: { runId: 'r1', sessionRef: 'crashed-session' } };

test('the interrupted run comes first; without it, the session the caller asks for', () => {
  assert.equal(sessionToResume(CRASHED, { sessionRef: 'chat-session' }), 'crashed-session');
  assert.equal(sessionToResume({}, { sessionRef: 'chat-session' }), 'chat-session');
  // A crash before the init left no session: the caller's goes on.
  assert.equal(sessionToResume({ resume: { runId: 'r1', sessionRef: null } }, { sessionRef: 'chat-session' }), 'chat-session');
  assert.equal(sessionToResume(CRASHED, {}), 'crashed-session');
});

test('null starts a new session, even after a crash; nothing asked and no crash is a new one too', () => {
  assert.equal(sessionToResume(CRASHED, { sessionRef: null }), undefined);
  assert.equal(sessionToResume({}, { sessionRef: null }), undefined);
  assert.equal(sessionToResume({}, {}), undefined);
});
