import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { activityText, errorText, reasonText } from '../src/lib/italian.ts';

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
  assert.equal(api(400, 'project is not among the approved projects'), 'Questo progetto non è fra quelli approvati: aggiungilo con pnpm arianna:init --reconfigure.');
  assert.equal(api(422, 'a work conversation cannot hold this title (iban)'), 'Il titolo di una conversazione di lavoro non può contenere IBAN.');
  assert.equal(api(400, 'the title must be one line'), 'Il titolo dev’essere su una riga.');
  assert.equal(api(409, 'the conversation is archived: restore it to write'), 'La conversazione è archiviata: ripristinala per scrivere.');
  assert.equal(api(400, 'the conversation of Telegram cannot be archived'), 'La conversazione di Telegram non si può archiviare: il bot scrive lì.');
  assert.equal(
    api(409, 'a task of the conversation is still at work: wait for it to finish'),
    'Un task di questa conversazione sta ancora lavorando: aspetta che finisca, poi eliminala.',
  );
  assert.equal(api(403, 'cross-origin request'), 'Il nucleo ha rifiutato la richiesta: apri la chat dal suo indirizzo.');
  assert.equal(api(500, 'internal error'), 'Errore del nucleo: riprova fra poco.');
  assert.equal(api(400, 'unknown field(s): x'), 'Richiesta non valida.');
  assert.equal(errorText(new TypeError('Failed to fetch')), 'Il nucleo non risponde: controlla che sia avviato.');
  assert.equal(errorText('boom'), 'Errore imprevisto.');
});

test('activity lines are written in Italian; an unknown tool error is never shown as it is', () => {
  const line = (kind: 'search' | 'read' | 'error' | 'thinking', detail = '') => activityText({ conversationId: 'c', taskId: 't', step: 3, kind, detail });
  assert.equal(line('search', 'caldaia'), 'Cerco nella knowledge base: «caldaia»');
  assert.equal(line('read', 'kb/private/casa/caldaia.md'), 'Leggo kb/private/casa/caldaia.md');
  assert.equal(line('thinking'), 'Sto ragionando (passo 3)…');
  assert.equal(line('error', '"kb/ciao.html" is not a page path: pages look like kb/folder/name.md'), 'Errore: kb/ciao.html non è un percorso di pagina valido (kb/cartella/nome.md), provo un’altra strada');
  assert.equal(line('error', 'the same call as step 2, not run again'), 'Errore: la stessa chiamata del passo 2, non rifatta, provo un’altra strada');
  assert.equal(line('error', 'something the page does not know'), 'Errore: uno strumento ha restituito un errore, provo un’altra strada');
});

test('delegation lines: hand-over, the Coder at work, its tools, the waits, its errors', () => {
  const line = (kind: 'delegate' | 'tool' | 'wait' | 'error', detail: string) => activityText({ conversationId: 'c', taskId: 't', step: 2, kind, detail });
  assert.equal(line('delegate', 'coder'), 'Passo delegato al Coder');
  assert.equal(line('delegate', 'coder · claude/sonnet'), 'Il Coder lavora su Claude Code (Claude Sonnet)');
  assert.equal(line('tool', 'Edit'), 'Il Coder usa Edit');
  assert.equal(line('wait', 'budget · fable'), 'Serve la tua approvazione del budget per Claude Fable (con approvazione)');
  assert.match(line('wait', 'claude · 2026-10-03T15:00:00.000Z'), /^Claude Code ha esaurito la quota: riprovo alle \d\d:\d\d$/);
  assert.equal(line('wait', 'something else'), 'In attesa dell’esecutore');
  assert.equal(line('error', 'the user did not approve sending the brief to the cloud: do what you can here'), 'Errore: il brief non è stato approvato per il cloud, provo un’altra strada');
  assert.equal(line('error', 'no project for the Coder: the user opens a work conversation'), 'Errore: nessun progetto per il Coder: apri una conversazione di lavoro con un progetto approvato, provo un’altra strada');
  assert.equal(line('error', 'the project site is no longer among the projects the user approved: tell the user'), 'Errore: il progetto site non è più fra quelli approvati, provo un’altra strada');
  assert.equal(line('error', 'claude: timeout'), 'Errore: Claude Code si è fermato (timeout), provo un’altra strada');
  assert.equal(reasonText('approval needed: budget'), 'serve la tua approvazione per il budget del modello');
  assert.equal(reasonText('approval needed: workspace'), 'la cartella del progetto ha modifiche non committate: serve il tuo via libera');
  assert.equal(line('wait', 'workspace · repos/demo'), 'La cartella repos/demo ha modifiche non committate: aspetto il tuo via libera');
  assert.equal(line('error', 'the user did not want the Coder to work over uncommitted changes: tell the user'), 'Errore: hai preferito non far lavorare il Coder sopra le tue modifiche non committate, provo un’altra strada');
});

test('the orchestrator reasons are translated', () => {
  assert.equal(reasonText('the local model did not give a valid answer'), 'il modello locale non ha dato una risposta valida');
  assert.equal(reasonText('the local model keeps repeating the same call'), 'il modello locale ripete la stessa chiamata');
  assert.equal(reasonText('the gateway blocked the answer'), 'il gateway ha fermato la risposta');
});

test('the errors of the system chats become Italian (D-064)', () => {
  assert.equal(errorText(new ApiError(400, 'the question is already attached')), 'La domanda è già allegata.');
  assert.match(errorText(new ApiError(400, 'the task has no recorded error')), /non è stato salvato un errore/);
  assert.equal(errorText(new ApiError(409, 'the task cannot do this now')), 'Il task non può farlo adesso.');
});
