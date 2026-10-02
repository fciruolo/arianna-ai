import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { errorText, reasonText } from '../src/lib/italian.ts';

test('the reasons the core writes become Italian', () => {
  assert.equal(reasonText('the orchestrator is not available yet (task 1.10)'), 'l’orchestratore non è ancora disponibile (task 1.10)');
  assert.equal(reasonText('approval needed: send_external'), 'serve la tua approvazione (invio all’esterno)');
  assert.equal(reasonText('approval needed: declassify'), 'serve la tua approvazione (declassamento)');
  assert.equal(reasonText('approval needed: something_new'), 'serve la tua approvazione (un’azione)');
  assert.equal(reasonText('limit reached: 30 of 30 steps'), 'limite raggiunto: 30 su 30 passi');
  assert.equal(reasonText('limit reached: 0.75 of 0.5 euro'), 'limite raggiunto: 0,75 su 0,5 euro');
  assert.equal(reasonText('limit reached: 20 minutes'), 'limite raggiunto: 20 minuti');
});

test('a reason the page does not know is not shown in English', () => {
  assert.equal(reasonText(null), undefined);
  assert.equal(reasonText('the executor needs a password'), undefined);
  assert.equal(reasonText('approval needed: Send External'), undefined);
});

// The core's own reasons: a new one without a translation fails here, not on the page.
test('every fixed reason of the core has an Italian text', () => {
  const sources = ['engine.ts', 'main.ts'].map((file) => readFileSync(new URL(`../../core/src/${file}`, import.meta.url), 'utf8'));
  const reasons = sources.flatMap((source) => [
    ...[...source.matchAll(/reason: '([^']+)'/g)].map((match) => match[1] ?? ''),
    ...[...source.matchAll(/task\.id, '([^']+)', '(?:limit|executor)'/g)].map((match) => match[1] ?? ''),
  ]);
  assert.ok(reasons.length >= 8, `found ${String(reasons.length)} reasons`);
  for (const reason of reasons) assert.notEqual(reasonText(reason), undefined, reason);
});

test('API errors become Italian, and unknown ones a generic message', () => {
  const api = (status: number, message: string): string => errorText(new ApiError(status, message));
  assert.equal(
    api(422, 'a work conversation cannot hold this message (iban, tax-code): open a private conversation'),
    'Una conversazione di lavoro non può contenere questo messaggio (IBAN, codice fiscale): aprine una privata.',
  );
  assert.equal(api(422, 'a work conversation cannot hold this message (token, private-key, something): x'), 'Una conversazione di lavoro non può contenere questo messaggio (token o chiave di accesso, chiave privata, dati riservati): aprine una privata.');
  assert.equal(api(400, 'the message is empty'), 'Il messaggio è vuoto.');
  assert.equal(api(400, 'the message is longer than 16000 characters'), 'Il messaggio supera 16000 caratteri.');
  assert.equal(api(409, 'the approval is already approved'), 'Questa richiesta è già stata decisa.');
  assert.equal(api(400, 'workspace is not in cloud.allowlist'), 'Questo repository non è fra quelli ammessi (cloud.allowlist in arianna.toml).');
  assert.equal(api(403, 'cross-origin request'), 'Il nucleo ha rifiutato la richiesta: apri la chat dal suo indirizzo.');
  assert.equal(api(500, 'internal error'), 'Errore del nucleo: riprova fra poco.');
  assert.equal(api(400, 'unknown field(s): x'), 'Richiesta non valida.');
  assert.equal(errorText(new TypeError('Failed to fetch')), 'Il nucleo non risponde: controlla che sia avviato.');
  assert.equal(errorText('boom'), 'Errore imprevisto.');
});
