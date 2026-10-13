import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentEntries, changedAgents, filterEntries, lengthText, permissionWords, tabLabel, tabsOf, unsavedNames, whereOf, type AgentParts } from '../src/lib/agents-page.ts';
import { DEFAULT_PERSONA_FORM } from '../src/lib/persona.ts';
import type { CardSummary, UserAgentListing, UserAgentView } from '../src/lib/user-agents.ts';

const card = (executors: string[]): CardSummary => ({
  maxLabel: 'L1',
  executors,
  tools: [],
  trifecta: { private_data: false, untrusted_content: false, external_comms: false },
  autonomy: 'A1',
  approvals: [],
  limits: { maxSteps: 10, maxMinutes: 10, maxCost: 0 },
});
const view = (name: string, state: UserAgentView['state'], executors: string[], description = ''): UserAgentView => ({
  name,
  description,
  state,
  card: card(executors),
  works: null,
  permissions: null,
  origin: 'page',
});
const listing: UserAgentListing = {
  official: [view('coder', 'official', ['claude'], 'Scrive codice'), view('arianna', 'official', ['local'], 'L’assistente')],
  user: [view('revisore', 'active', ['local'], 'Rilegge testi'), view('grafico', 'disabled', ['claude'], 'Propone grafici')],
  refused: [],
};
const name = (id: string): string => (id === 'arianna' ? 'Arianna' : id === 'coder' ? 'Coder' : id);

describe('agentEntries', () => {
  it('puts Arianna first, the others by id, official ones always on', () => {
    const entries = agentEntries(listing, []);
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.official, entry.on, entry.where]),
      [
        ['arianna', true, true, 'local'],
        ['coder', true, true, 'cloud'],
        ['grafico', false, false, 'cloud'],
        ['revisore', false, true, 'local'],
      ],
    );
  });

  it('gives a card to an agent only the settings name, and none twice', () => {
    const entries = agentEntries(listing, ['coder', 'vecchio']);
    assert.equal(entries.filter((entry) => entry.id === 'coder').length, 1);
    const old = entries.find((entry) => entry.id === 'vecchio');
    assert.equal(old?.view, undefined);
    assert.equal(old?.official, true);
  });

  it('lists the known agents while the listing is not there yet', () => {
    assert.deepEqual(
      agentEntries(null, ['coder', 'arianna']).map((entry) => entry.id),
      ['arianna', 'coder'],
    );
  });
});

describe('whereOf', () => {
  it('is cloud with any executor but the local model', () => {
    assert.equal(whereOf(view('a', 'active', ['local', 'claude'])), 'cloud');
  });
  it('is local with the local model only', () => {
    assert.equal(whereOf(view('a', 'active', ['local'])), 'local');
  });
});

describe('filterEntries', () => {
  const entries = agentEntries(listing, []);
  it('keeps the active ones, or the ones switched off', () => {
    assert.deepEqual(
      filterEntries(entries, '', 'off', name).map((entry) => entry.id),
      ['grafico'],
    );
    assert.equal(filterEntries(entries, '', 'on', name).length, 3);
  });
  it('searches the shown name and the description, whatever the case', () => {
    assert.deepEqual(
      filterEntries(entries, 'CODER', 'all', name).map((entry) => entry.id),
      ['coder'],
    );
    assert.deepEqual(
      filterEntries(entries, 'testi', 'all', name).map((entry) => entry.id),
      ['revisore'],
    );
  });
  it('finds nothing for words nobody has', () => {
    assert.deepEqual(filterEntries(entries, 'meteo', 'all', name), []);
  });
});

describe('tabsOf', () => {
  it('shows "Scheda e prompt" only for the user’s agents', () => {
    const [arianna, , grafico] = agentEntries(listing, []);
    assert.ok(arianna !== undefined && grafico !== undefined);
    assert.equal(tabsOf(arianna).includes('card'), false);
    assert.equal(tabsOf(grafico).includes('card'), true);
  });
  it('shows "Skill" for every agent, after the model (D-161)', () => {
    for (const entry of agentEntries(listing, [])) assert.equal(tabsOf(entry)[3], 'skills');
  });
});

describe('changedAgents', () => {
  const base: AgentParts = { characters: { coder: 'originali/coder' }, personas: { coder: { ...DEFAULT_PERSONA_FORM } }, agents: { coder: '' } };
  const copy = (): AgentParts => structuredClone(base);

  it('is empty when nothing changed, a default persona added included', () => {
    const form = copy();
    form.personas.revisore = { ...DEFAULT_PERSONA_FORM };
    assert.deepEqual(changedAgents(form, base), []);
  });
  it('names the agent whose persona, model or character changed', () => {
    const form = copy();
    form.personas.coder = { ...DEFAULT_PERSONA_FORM, tone: 'asciutto' };
    form.agents.revisore = 'sonnet';
    form.characters.grafico = 'miei/grafico';
    assert.deepEqual(changedAgents(form, base), ['coder', 'grafico', 'revisore']);
  });
  it('names the agent whose skills changed, not one with an empty list as before (D-161)', () => {
    const before: AgentParts = { ...copy(), skills: { coder: ['a/b/c'], revisore: [] } };
    const form = structuredClone(before);
    assert.deepEqual(changedAgents(form, before), []);
    form.skills = { coder: ['a/b/c', 'a/b/d'], revisore: [] };
    assert.deepEqual(changedAgents(form, before), ['coder']);
    form.skills = { coder: ['a/b/c'], revisore: ['x/y/z'] };
    assert.deepEqual(changedAgents(form, before), ['revisore']);
  });
  it('names an agent whose character went back to the default', () => {
    const form = copy();
    delete form.characters.coder;
    assert.deepEqual(changedAgents(form, base), ['coder']);
  });
});

describe('unsavedNames', () => {
  it('names up to three agents', () => {
    assert.equal(unsavedNames(['Coder', 'revisore']), 'Coder, revisore');
  });
  it('counts the others', () => {
    assert.equal(unsavedNames(['a', 'b', 'c', 'd', 'e']), 'a, b, c e altri 2');
  });
});

describe('permissionWords (D-192)', () => {
  it('says the grade and the autonomy in words', () => {
    assert.deepEqual(permissionWords({ maxLabel: 'L1', autonomy: 'A1' }), { sees: 'Vede: dati di lavoro', can: 'Può: modificare file in una copia protetta' });
    assert.deepEqual(permissionWords({ maxLabel: 'L0', autonomy: 'A0' }), { sees: 'Vede: solo dati pubblici', can: 'Può: solo proporre' });
  });
  it('shows an unknown code as it is', () => {
    assert.deepEqual(permissionWords({ maxLabel: 'L9', autonomy: 'A9' }), { sees: 'Vede: L9', can: 'Può: A9' });
  });
});

describe('tabLabel and lengthText (D-192)', () => {
  it('counts the skills only on their tab, only when there are some', () => {
    assert.equal(tabLabel('skills', 2), 'Skill · 2');
    assert.equal(tabLabel('skills', 0), 'Skill');
    assert.equal(tabLabel('persona', 3), 'Personalità');
  });
  it('says the characters used of the maximum', () => {
    assert.equal(lengthText(68, 400), '68 di 400 caratteri');
    assert.equal(lengthText(0, 4000), '0 di 4.000 caratteri');
  });
});
