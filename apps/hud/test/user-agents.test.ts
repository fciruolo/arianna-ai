import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { permissionLines, UserAgentApiError, userAgentErrorText, type CardSummary } from '../src/lib/user-agents.ts';

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
