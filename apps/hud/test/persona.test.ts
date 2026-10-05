import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADDRESSES as AGENT_ADDRESSES,
  MAX_DISPLAY_NAME as AGENT_MAX_DISPLAY_NAME,
  MAX_SPECIALIZATION,
  MAX_TRAITS,
  parsePersona,
  TONES as AGENT_TONES,
} from '../../../packages/agents/src/persona.ts';
import { FIXED_NAMES as CONFIG_FIXED_NAMES } from '../../../packages/config/src/personas.ts';
import {
  ADDRESSES,
  characters,
  costText,
  DEFAULT_PERSONA_FORM,
  FIXED_NAMES,
  MAX_DISPLAY_NAME,
  MAX_TEXT,
  PERSONA_NOTICE,
  personaCost,
  personaProblem,
  personasBody,
  personasForm,
  personasProblem,
  TONE_EXAMPLE,
  TONE_TEXT,
  TONES,
  type PersonaForm,
} from '../src/lib/persona.ts';
import { sectionChanged } from '../src/lib/settings.ts';

const form = (fields: Partial<PersonaForm> = {}): PersonaForm => ({ ...DEFAULT_PERSONA_FORM, ...fields });

test('five tones, each with its name and its example', () => {
  assert.deepEqual([...TONES], ['serio', 'asciutto', 'equilibrato', 'caloroso', 'scherzoso']);
  for (const tone of TONES) {
    assert.ok(TONE_TEXT[tone].length > 0, tone);
    assert.ok(TONE_EXAMPLE[tone].length > 0, tone);
  }
  assert.equal(new Set(Object.values(TONE_EXAMPLE)).size, TONES.length);
});

test('a form per agent the file names, empty texts where it has none', () => {
  assert.deepEqual(personasForm({ coder: { tone: 'asciutto', address: 'lei', specialization: 'Senior.' } }), {
    coder: form({ tone: 'asciutto', address: 'lei', specialization: 'Senior.' }),
  });
  assert.deepEqual(personasForm({}), {});
});

test('the copies of the closed lists and limits match packages/agents and packages/config', () => {
  assert.deepEqual([...TONES], [...AGENT_TONES]);
  assert.deepEqual([...ADDRESSES], [...AGENT_ADDRESSES]);
  assert.equal(MAX_TEXT, MAX_TRAITS);
  assert.equal(MAX_TEXT, MAX_SPECIALIZATION);
  assert.equal(MAX_DISPLAY_NAME, AGENT_MAX_DISPLAY_NAME);
  assert.deepEqual(FIXED_NAMES, CONFIG_FIXED_NAMES);
  // Same name rule: what the core refuses, the page refuses (the page trims the spaces around it).
  for (const name of ['Dario', "D'Ari", 'Ari-Bo', 'R2D2', 'Ari"', 'A'.repeat(25)]) {
    let core = true;
    try {
      parsePersona({ display_name: name });
    } catch {
      core = false;
    }
    assert.equal(personaProblem('coder', form({ displayName: name })) === undefined, core, name);
  }
});

test('the body leaves out the agents with the defaults and the empty texts, and trims the name only', () => {
  assert.deepEqual(personasBody({ arianna: form(), coder: form({ traits: '  ', displayName: ' Dario ', specialization: ' Senior.\n' }) }), {
    coder: { tone: 'equilibrato', address: 'tu', displayName: 'Dario', specialization: ' Senior.\n' },
  });
  assert.deepEqual(personasBody({ arianna: form({ tone: 'serio' }) }), { arianna: { tone: 'serio', address: 'tu' } });
  assert.deepEqual(personasBody({ arianna: form() }), {});
});

test('an agent added with the defaults is no change; a tone or a text is', () => {
  const base = { coder: form({ tone: 'serio' }) };
  assert.equal(sectionChanged('personas', { ...base, arianna: form() }, base), false);
  assert.equal(sectionChanged('personas', { ...base, arianna: form({ tone: 'caloroso' }) }, base), true);
  assert.equal(sectionChanged('personas', { coder: form({ tone: 'serio', traits: 'Calmo.' }) }, base), true);
});

test('counts code points, as the core does', () => {
  assert.equal(characters('😀à'), 2);
});

test('the cost: nothing for no text, and grows with the text', () => {
  assert.deepEqual(personaCost(form()), { tokens: 0, seconds: 0 });
  assert.equal(costText(personaCost(form())), 'Nessun testo: il prompt non cambia.');
  const full = personaCost(form({ traits: 'a'.repeat(MAX_TEXT), specialization: 'b'.repeat(MAX_TEXT) }));
  assert.equal(full.tokens, Math.ceil(1000 / 3.5));
  assert.ok(full.seconds > personaCost(form({ traits: 'a'.repeat(MAX_TEXT) })).seconds);
  assert.match(costText(full), /^Circa 286 token, circa 4,3 s in più a ogni passo/);
});

test('what cannot be saved, in Italian: names, Arianna, the limits', () => {
  assert.equal(personaProblem('coder', form({ displayName: 'Dario', traits: 'a'.repeat(MAX_TEXT), specialization: 'b'.repeat(MAX_TEXT) })), undefined);
  assert.equal(personaProblem('arianna', form()), undefined);
  assert.match(personaProblem('arianna', form({ displayName: 'Ari' })) ?? '', /Arianna non si cambia/);
  assert.match(personaProblem('coder', form({ displayName: 'R2D2' })) ?? '', /lettere/);
  assert.match(personaProblem('coder', form({ displayName: 'A'.repeat(25) })) ?? '', /lettere/);
  assert.match(personaProblem('coder', form({ traits: 'a'.repeat(MAX_TEXT + 1) })) ?? '', /personalità supera/);
  assert.match(personaProblem('coder', form({ specialization: '😀'.repeat(MAX_TEXT + 1) })) ?? '', /specializzazione supera/);
  assert.equal(personasProblem({ arianna: form(), coder: form({ displayName: '1' }) }, (agent) => agent.toUpperCase())?.startsWith('CODER: '), true);
});

test('the notice under the fields says where the text goes', () => {
  assert.equal(PERSONA_NOTICE, 'Questo testo va anche a Claude e Codex: non scriverci dati personali.');
});
