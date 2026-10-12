import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXECUTOR_CARD, executorReceives, KEEP_ON_MAC, labelWord, restartBlocker, serverDown, serverName, serverStatus } from '../src/lib/settings-copy.ts';
import type { LocalServerStatus } from '../src/lib/settings.ts';

function server(over: Partial<LocalServerStatus> = {}): LocalServerStatus {
  return { id: 'omlx', url: 'http://127.0.0.1:7001/v1', managed: true, adopted: false, state: 'up', ...over };
}

test('the table of what stays on the Mac names every grade, and nothing unlabelled goes out', () => {
  assert.deepEqual([...new Set(KEEP_ON_MAC.map((row) => labelWord(row.label)))], ['Segreto', 'Privato', 'Interno', 'Pubblico']);
  const unlabelled = KEEP_ON_MAC.find((row) => /non ha un grado/.test(row.data));
  assert.equal(unlabelled?.label, 'L2');
  // Only Interno and Pubblico may leave.
  for (const row of KEEP_ON_MAC.filter((entry) => entry.label === 'L2' || entry.label === 'L3')) assert.doesNotMatch(row.meaning, /Possono (andare|uscire)/);
});

test('what Claude and Codex receive, said with the projects, on and off', () => {
  assert.equal(EXECUTOR_CARD.codex?.plan, 'abbonamento ChatGPT');
  assert.equal(
    executorReceives(true, [
      { name: 'demo', path: 'repos/demo', label: 'L0' },
      { name: 'sito', path: 'repos/sito', label: 'L1' },
    ]),
    'Riceve: la richiesta del lavoro, i file dei progetti demo, sito, le regole dei progetti.',
  );
  assert.match(executorReceives(false, []), /^Riceverebbe: .*nessun progetto/);
});

test('local servers by name and state, in words', () => {
  assert.equal(serverName('omlx'), 'oMLX · modelli sul Mac');
  assert.equal(serverName('altro'), 'altro');
  assert.deepEqual(serverStatus(server()), { text: 'Acceso', tone: 'ok', who: 'avviato da Arianna' });
  assert.equal(serverStatus(server({ state: 'down' })).tone, 'danger');
  assert.equal(serverStatus(server({ state: 'restarting' })).tone, 'warn');
  assert.equal(serverStatus(server({ managed: false, state: 'idle' })).who, 'solo controllato da Arianna');
  assert.equal(serverStatus(server({ adopted: true })).who, 'acceso a mano, fuori da Arianna');
});

test('a server Arianna cannot restart says where to do it; a broken one says what stops', () => {
  assert.equal(restartBlocker(server()), undefined);
  assert.match(restartBlocker(server({ managed: false })) ?? '', /controlla soltanto/);
  assert.match(restartBlocker(server({ adopted: true })) ?? '', /prima di Arianna/);
  assert.equal(serverDown(server()), undefined);
  assert.match(serverDown(server({ id: 'voice', state: 'down' })) ?? '', /le chiamate non partono/);
  assert.match(serverDown(server({ state: 'failed' })) ?? '', /modelli sul Mac non rispondono/);
  for (const text of [restartBlocker(server({ managed: false })), serverDown(server({ state: 'down' }))]) assert.doesNotMatch(text ?? '', /nucleo/);
});
