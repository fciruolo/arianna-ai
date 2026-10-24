// What Arianna writes in the direct chat for a brief the gateway refused (D-250).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gatewayRefusalOf, gatewayRefusalReply } from '../src/orchestrator/gateway-refusal.ts';

test('the reason of the gateway, only from a refused brief', () => {
  assert.equal(gatewayRefusalOf('error: task.delegate: the gateway refused the brief (second scanner found personal data: FULLNAME)'), 'second scanner found personal data: FULLNAME');
  assert.equal(gatewayRefusalOf('the gateway refused the brief (scanner matched: iban)'), 'scanner matched: iban');
  assert.equal(gatewayRefusalOf('error: task.delegate: claude: error'), undefined);
  assert.equal(gatewayRefusalOf('error: task.delegate: the gateway refused the report (second scanner found personal data: FULLNAME)'), undefined, 'a report is not a brief');
  assert.equal(gatewayRefusalOf(null), undefined);
});

test('the message says where it did not go and why, by the kind of the rule', () => {
  assert.equal(
    gatewayRefusalReply('second scanner found personal data: FULLNAME', 'claude'),
    'Non ho mandato il messaggio a Claude: il controllo dei dati personali ha trovato un nome di persona. Se è nel tuo messaggio, toglilo e riscrivilo; se non c’è, è nelle regole o nelle note del progetto che lo accompagnano.',
  );
  assert.match(gatewayRefusalReply('second scanner found personal data: TELEPHONENUM', 'codex'), /^Non ho mandato il messaggio a Codex: .*un numero di telefono\./);
  assert.match(gatewayRefusalReply('second scanner found personal data: FULLNAME, EMAIL', 'local'), /^Non ho mandato il messaggio al modello locale: .*dei dati personali\./);
  assert.match(gatewayRefusalReply('second check not available (timeout)', 'claude'), /non ha risposto\. Riprova fra poco\.$/);
  assert.match(gatewayRefusalReply('scanner matched: iban', 'claude'), /un dato riservato/);
  assert.match(gatewayRefusalReply('payload contains the value of vault://x', 'claude'), /segreto del vault/);
  assert.match(gatewayRefusalReply('the session has read finance data: it stays local', 'claude'), /dati di Finanze/);
  assert.match(gatewayRefusalReply('the session has read L2: it stays local', 'claude'), /dati Privati.*«Nuova conversazione» → «Lavoro»/);
  assert.match(gatewayRefusalReply('L2 cannot go to a cloud target; at most L1', 'claude'), /dati Privati.*«Nuova conversazione» → «Lavoro»/);
  assert.equal(gatewayRefusalReply('something new', null), 'Non ho mandato il messaggio all’agente: il gateway l’ha fermato.');
});

test('never a word of the reason beyond the kinds: a reference of the vault stays out', () => {
  assert.ok(!gatewayRefusalReply('payload contains the value of vault://banca/password', 'claude').includes('banca'));
});
