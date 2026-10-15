import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codexFailureText } from '../src/codex-failure.ts';

const fail = (kind: string, more: { apiStatus?: number; durationMs?: number; exitCode?: number } = {}) =>
  codexFailureText({ kind: kind as never, apiStatus: more.apiStatus, durationMs: more.durationMs, exitCode: more.exitCode });

test('a refused login says to run codex login, a refused plan names the subscription', () => {
  assert.match(fail('auth', { apiStatus: 401, durationMs: 6000 }), /non è collegato.*`codex login`/);
  assert.match(fail('plan', { apiStatus: 400 }), /abbonamento ChatGPT non permette questo modello/);
  assert.doesNotMatch(fail('auth'), /codex: auth/);
});

test('a failure without a reason says how long it ran and to check codex login status', () => {
  assert.equal(
    fail('execution', { durationMs: 6200 }),
    'Codex si è fermato subito (dopo 6 secondi) senza dire perché: prova `codex login status` nel terminale per vedere se è collegato.',
  );
  // The service gave a status: no login advice.
  const withStatus = fail('execution', { apiStatus: 500, durationMs: 900 });
  assert.match(withStatus, /subito \(dopo 1 secondo\) per un errore 500 del servizio/);
  assert.doesNotMatch(withStatus, /codex login/);
  assert.match(fail('exit', { durationMs: 90_000 }), /^Codex si è fermato dopo 90 secondi senza finire/);
  assert.match(fail('exit', { durationMs: 5 * 60_000, exitCode: 1 }), /^Codex si è fermato dopo 5 minuti senza finire/);
  assert.match(fail('exit'), /^Codex si è fermato senza finire.*`codex login status`/);
  // Not a login matter: no codex login advice.
  assert.doesNotMatch(fail('timeout'), /codex login/);
  assert.doesNotMatch(fail('profile'), /codex login/);
});

test('every other kind gets an Italian line, never the bare code alone', () => {
  for (const kind of ['spawn', 'timeout', 'max-turns', 'profile', 'bad-output', 'not-enabled', 'workspace', 'handler', 'cancelled']) {
    const text = fail(kind);
    assert.ok(text.startsWith('Codex '), kind);
    assert.ok(!text.includes(kind), `${kind}: no bare code`);
  }
});
