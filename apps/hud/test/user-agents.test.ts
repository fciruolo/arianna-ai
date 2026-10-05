import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  adjustPermissions,
  changeRows,
  cloudLines,
  permissionLines,
  PRESET_ORDER,
  PRESET_TEXT,
  samePermissionsOf,
  trifectaRows,
  UserAgentApiError,
  userAgentErrorText,
  workText,
  type AgentProposal,
  type CardSummary,
  type UserAgentSources,
  type UserPermissions,
} from '../src/lib/user-agents.ts';

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
  it('has a text and an example for every starting point, with a valid name', () => {
    for (const id of PRESET_ORDER) {
      const text = PRESET_TEXT[id];
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
      userAgentErrorText(new UserAgentApiError(400, 'x: max_label L2 is above L1 (cards made from the Agents page stay at L1 and A1)')),
      'La scheda supera il tetto L1/A1 delle schede utente: non può tornare fra i tuoi agenti.',
    );
    assert.equal(userAgentErrorText(new UserAgentApiError(400, 'deletion needs the name of the agent as confirmation')), 'Per eliminare scrivi esattamente il nome dell’agente.');
  });
});

describe('tappa T3b (D-119): permissions chosen within the list', () => {
  const allowed: UserAgentSources['allowed'] = {
    executors: ['local', 'claude'],
    tools: { local: [], claude: ['repo.read', 'repo.write', 'repo.test'] },
    acting: ['repo.write', 'repo.test'],
    limits: { maxSteps: 50, maxMinutes: 45 },
    trifecta: { private_data: false, untrusted_content: true, external_comms: false },
  };
  const code: UserPermissions = { executor: 'claude', tools: ['repo.read', 'repo.write', 'repo.test'], autonomy: 'A1', maxSteps: 50, maxMinutes: 45 };

  it('adjusts a click to what the core accepts', () => {
    assert.deepEqual(adjustPermissions({ ...code, executor: 'local' }, allowed).tools, []);
    assert.deepEqual(adjustPermissions({ ...code, autonomy: 'A0' }, allowed).tools, ['repo.read']);
    // The order of the list, whatever the order of the clicks.
    assert.deepEqual(adjustPermissions({ ...code, tools: ['repo.test', 'repo.read'] }, allowed).tools, ['repo.read', 'repo.test']);
    assert.equal(adjustPermissions({ ...code, maxSteps: 99 }, allowed).maxSteps, 50);
    assert.equal(adjustPermissions({ ...code, maxMinutes: 0 }, allowed).maxMinutes, 1);
    assert.equal(adjustPermissions({ ...code, maxMinutes: Number.NaN }, allowed).maxMinutes, 1);
    assert.equal(adjustPermissions({ ...code, maxSteps: 7.6 }, allowed).maxSteps, 8);
    assert.deepEqual(adjustPermissions(code, allowed), code);
  });
  it('compares two choices whatever the order of the tools', () => {
    assert.ok(samePermissionsOf(code, { ...code, tools: ['repo.test', 'repo.write', 'repo.read'] }));
    assert.ok(!samePermissionsOf(code, { ...code, maxMinutes: 44 }));
  });
  it('says in Italian what changes, the trifecta and what leaves for the cloud', () => {
    const after: CardSummary = { ...card, executors: ['claude'], tools: ['repo.read'], promptLabel: 'L1' };
    const proposal: AgentProposal = {
      name: 'revisore',
      confirmation: 'abc',
      before: card,
      after,
      changes: [
        { field: 'executor', before: 'local', after: 'claude' },
        { field: 'tools', before: [], after: ['repo.read'] },
        { field: 'maxLabel', before: 'L0', after: 'L1' },
      ],
      trifecta: after.trifecta,
      cloud: { executor: 'claude', briefMax: 'L1', promptLabel: 'L1', claudeTools: ['Read', 'Glob', 'Grep'] },
      expiresInMs: 600_000,
    };
    assert.deepEqual(changeRows(proposal), [
      { field: 'Dove lavora', before: 'modello locale', after: 'Claude Code' },
      { field: 'Strumenti', before: 'nessuno', after: 'legge il codice del progetto' },
      { field: 'Dati che può leggere', before: 'L0, solo dati pubblici', after: 'L1, dati di lavoro' },
    ]);
    assert.deepEqual(
      trifectaRows(proposal.trifecta).map(({ side, open }) => [side, open]),
      [
        ['Dati privati', false],
        ['Contenuti non fidati', true],
        ['Comunicazione esterna', false],
      ],
    );
    assert.match(cloudLines(proposal.cloud)[0] ?? '', /fino a L1, vanno a Claude Code passando dal gateway/);
    assert.match(cloudLines(proposal.cloud)[1] ?? '', /Read, Glob, Grep/);
    assert.deepEqual(cloudLines(null), ['Niente esce dal Mac: lavora sul modello locale.']);
    // A new card: every field, nothing before.
    assert.equal(changeRows({ ...proposal, before: null, changes: [{ field: 'autonomy', before: null, after: 'A0' }] })[0]?.before, '—');
  });
  it('turns the errors of the permissions into Italian', () => {
    assert.equal(
      userAgentErrorText(new UserAgentApiError(409, 'the card changed since the confirmation was shown: prepare the change again')),
      'La scheda è cambiata o la conferma è scaduta: rivedi le modifiche e conferma di nuovo.',
    );
    assert.equal(userAgentErrorText(new UserAgentApiError(400, 'the change of permissions needs the confirmation of the user')), 'Serve la tua conferma delle modifiche ai permessi.');
    assert.equal(
      userAgentErrorText(new UserAgentApiError(400, 'permissions: tool(s) repo.read not allowed on the local model: a local agent only answers')),
      'Sul modello locale l’agente risponde soltanto: niente strumenti.',
    );
    assert.equal(
      userAgentErrorText(new UserAgentApiError(400, 'permissions: tool(s) repo.write act: not allowed with A0, which only proposes')),
      'Con A0 l’agente propone soltanto: niente modifica del codice né test.',
    );
    assert.equal(userAgentErrorText(new UserAgentApiError(400, 'permissions: maxSteps must be a whole number from 1 to 50')), 'I passi vanno da 1 a 50.');
    assert.equal(
      userAgentErrorText(new UserAgentApiError(400, "x: executors must be one of local, claude (permissions of a user's agent, D-119)")),
      'La scheda va oltre i permessi ammessi per gli agenti utente: non può stare fra i tuoi agenti.',
    );
  });
});
