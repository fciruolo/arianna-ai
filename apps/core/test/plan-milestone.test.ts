import assert from 'node:assert/strict';
import { test } from 'node:test';

import { milestoneOfBrief, planMilestoneText } from '../src/plan-milestone.ts';

// Saturday 24 October 2026; invented projects and milestones.
const TODAY = '2026-10-24';

test('the milestone a «/progetta» names in its first words (D-313, seguito 3)', () => {
  assert.deepEqual(milestoneOfBrief('la milestone Accessi che deve fare login, registrazione e recupero password', TODAY), { title: 'Accessi', due: null });
  assert.deepEqual(milestoneOfBrief('Milestone Area clienti: profilo, ordini, fatture', TODAY), { title: 'Area clienti', due: null });
  assert.deepEqual(milestoneOfBrief('una milestone «Sezione dashboard» con grafici e filtri', TODAY), { title: 'Sezione dashboard', due: null });
  assert.deepEqual(milestoneOfBrief('la nuova milestone chiamata Pagamenti, con carrello e checkout', TODAY), { title: 'Pagamenti', due: null });
  assert.deepEqual(milestoneOfBrief('la milestone Accessi', TODAY), { title: 'Accessi', due: null });
});

test('the due day after «entro», computed by the code', () => {
  assert.deepEqual(milestoneOfBrief('la milestone Accessi entro fine novembre che deve fare login e registrazione', TODAY), { title: 'Accessi', due: '2026-11-30' });
  assert.deepEqual(milestoneOfBrief('la milestone Accessi che deve fare login e registrazione, da finire entro il 15 dicembre', TODAY), { title: 'Accessi', due: '2026-12-15' });
  assert.deepEqual(milestoneOfBrief('la milestone Accessi, scadenza venerdì, con login', TODAY), { title: 'Accessi', due: '2026-10-30' });
  // Each «per il …», «entro …» in turn: the first one says no day here.
  assert.deepEqual(milestoneOfBrief('la milestone Accessi per il cliente Rossi, entro fine novembre', TODAY), { title: 'Accessi', due: '2026-11-30' });
  assert.deepEqual(milestoneOfBrief('la milestone v1.2 con login', TODAY), { title: 'v1.2', due: null });
  // A day the code cannot read: no due, never a guess.
  assert.deepEqual(milestoneOfBrief('la milestone Accessi entro quando possibile', TODAY), { title: 'Accessi', due: null });
});

test('a plan that names no milestone has none', () => {
  assert.equal(milestoneOfBrief('il sito del panificio con home, menu e contatti', TODAY), undefined);
  assert.equal(milestoneOfBrief('le card per la milestone Accessi', TODAY), undefined);
  assert.equal(milestoneOfBrief('la milestone «»', TODAY), undefined);
  // A sentence about a milestone is not its name.
  assert.equal(milestoneOfBrief('la milestone attuale è troppo grande, dividila', TODAY), undefined);
  assert.equal(milestoneOfBrief('la milestone di login va rifatta', TODAY), undefined);
  assert.equal(milestoneOfBrief('la milestone delle pagine nuove del sito che stiamo facendo', TODAY), undefined);
  assert.equal(milestoneOfBrief('la milestone uno due tre quattro cinque con login', TODAY), undefined);
  assert.equal(milestoneOfBrief(`la milestone «${'x'.repeat(201)}»`, TODAY), undefined);
});

test('the answer says where the cards went, or why not', () => {
  assert.equal(planMilestoneText({ title: 'Accessi', due: null }, { title: 'Accessi', project: 'demo', due: null }), 'Sono nella milestone «Accessi» di demo.');
  assert.equal(planMilestoneText({ title: 'Accessi', due: '2026-11-30' }, { title: 'Accessi', project: 'demo', due: '2026-11-30' }), 'Sono nella milestone «Accessi» di demo, che scade lunedì 30 novembre 2026.');
  assert.equal(planMilestoneText({ title: 'Accessi', due: null }, undefined), 'Non le ho messe nella milestone «Accessi»: il progetto ha già 50 milestone aperte. Puoi spostarle dal «Cardwall».');
  assert.match(planMilestoneText({ title: 'Accessi', due: null }, undefined, 'secret'), /: il piano è Segreto, e una milestone è al più Privata\./);
  assert.match(planMilestoneText({ title: 'Accessi', due: null }, undefined, 'no-project'), /: questa conversazione non ha un progetto\./);
});
