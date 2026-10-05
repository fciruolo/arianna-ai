import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { permissionLines, TEMPLATE_ORDER, TEMPLATE_TEXT, UserAgentApiError, userAgentErrorText, workText, type CardSummary } from '../src/lib/user-agents.ts';

const card: CardSummary = {
  maxLabel: 'L1',
  executors: ['local', 'claude'],
  tools: ['repo.read', 'user.ask'],
  trifecta: { private_data: false, untrusted_content: true, external_comms: false },
  autonomy: 'A1',
  approvals: [],
  limits: { maxSteps: 50, maxMinutes: 45, maxCost: 0 },
};

describe('permissionLines', () => {
  it('says what the card allows in Italian', () => {
    assert.deepEqual(permissionLines(card), [
      'Dati: L1, dati di lavoro',
      'Autonomia: A1, agisce solo nella sandbox',
      'Gira su: modello locale, Claude Code',
      'Strumenti: legge il codice del progetto; ti fa domande in chat',
      'Limiti: 50 passi, 45 minuti per task',
    ]);
  });
  it('names no tools and the approvals when there are', () => {
    const lines = permissionLines({ ...card, tools: [], approvals: ['payment'] });
    assert.ok(lines.includes('Strumenti: nessuno'));
    assert.ok(lines.includes('Con la tua approvazione: payment'));
  });
});

describe('userAgentErrorText', () => {
  it('turns the core errors into Italian, never repeating the text', () => {
    assert.equal(userAgentErrorText(new UserAgentApiError(409, 'an agent named x already exists')), 'Esiste già un agente con questo nome.');
    assert.equal(userAgentErrorText(new UserAgentApiError(409, 'agents/ already has x')), 'In agents/ c’è già una scheda con questo nome.');
    assert.equal(
      userAgentErrorText(new UserAgentApiError(400, 'the prompt looks like personal data or a secret (iban): not saved')),
      'Il prompt sembra contenere dati personali o un segreto: non salvato.',
    );
    assert.equal(userAgentErrorText(new Error('boom')), 'Il core non risponde.');
  });
});

describe('tappa T3 (D-119)', () => {
  it('says what work each agent gets from Arianna', () => {
    assert.equal(workText('claude'), 'riceve lavoro da Arianna (Claude Code)');
    assert.equal(workText('local'), 'riceve lavoro da Arianna (modello locale)');
    assert.equal(workText(null), 'non riceve ancora lavoro');
  });
  it('has a text and an example for every template, with a valid name', () => {
    for (const id of TEMPLATE_ORDER) {
      const text = TEMPLATE_TEXT[id];
      assert.ok(text !== undefined, id);
      assert.match(text.example.name, /^[a-z][a-z0-9-]{1,39}$/);
      assert.ok(text.example.description.length <= 200);
    }
  });
  it('turns the errors of edit, delete and demote into Italian', () => {
    assert.equal(userAgentErrorText(new UserAgentApiError(409, 'deactivate x before deleting it')), 'Disattiva l’agente prima di eliminarlo.');
    assert.equal(userAgentErrorText(new UserAgentApiError(409, 'data/agents already has x')), 'In data/agents c’è già una scheda con questo nome: spostala o eliminala prima.');
    assert.equal(userAgentErrorText(new UserAgentApiError(400, 'x was not created from the Agents page')), 'Questo agente non è nato da questa pagina: resta ufficiale.');
    assert.equal(
      userAgentErrorText(new UserAgentApiError(400, 'x: the card does not match any template (tools changed)')),
      'La scheda è stata cambiata a mano oltre il suo modello: non può tornare fra i tuoi agenti.',
    );
    assert.equal(
      userAgentErrorText(new UserAgentApiError(400, 'x: max_label L2 is above L1 (cards made from the Agents page stay at L1 and A1)')),
      'La scheda supera il tetto L1/A1 delle schede utente: non può tornare fra i tuoi agenti.',
    );
    assert.equal(userAgentErrorText(new UserAgentApiError(400, 'deletion needs the name of the agent as confirmation')), 'Per eliminare scrivi esattamente il nome dell’agente.');
  });
});
