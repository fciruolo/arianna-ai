// The source «Dashboard» of the page «Routine» (D-258), without a browser:
// what the card says, the choice of tiles in the form («Tutti» or some), what
// the form sends, and the card in the chat of a routine Arianna proposes,
// which is always every tile. Fake data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROPOSAL_DASHBOARD_TEXT, routineProposal } from '../src/lib/routine-approval.ts';
import { dashboardText, emptyForm, formBody, formOf, formProblem, SOURCE_CHOICES, toggledAllTiles, toggledTile, type Routine, type TileChoice } from '../src/lib/routines.ts';

const TILES: TileChoice[] = [
  { id: 'a', title: 'Spese del mese', label: 'L2' },
  { id: 'b', title: 'Scadenze', label: 'L2' },
  { id: 'c', title: 'Clienti finti', label: 'L1' },
];

test('the source is offered in the form, off in a new routine, with every tile', () => {
  assert.ok(SOURCE_CHOICES.some((choice) => choice.id === 'dashboard' && choice.label === 'Aggiorna la Dashboard'));
  const form = emptyForm();
  assert.ok(!form.sources.includes('dashboard'));
  assert.equal(form.dashboardTiles, null);
});

test('the card: every tile, the titles chosen (two, then the others counted), none left', () => {
  assert.equal(dashboardText(null, TILES), 'Dashboard: tutti i riquadri');
  assert.equal(dashboardText(['b'], TILES), 'Dashboard: Scadenze');
  assert.equal(dashboardText(['a', 'b'], TILES), 'Dashboard: Spese del mese, Scadenze');
  assert.equal(dashboardText(['a', 'b', 'c'], TILES), 'Dashboard: Spese del mese, Scadenze e un altro');
  assert.equal(dashboardText(['a', 'b', 'c', 'd'], [...TILES, { id: 'd', title: 'Altro', label: 'L2' }]), 'Dashboard: Spese del mese, Scadenze e altri 2');
  assert.equal(dashboardText([], TILES), 'Dashboard: nessuno dei riquadri scelti c’è ancora');
  // The titles not loaded: only counted.
  assert.equal(dashboardText(['a', 'b'], []), 'Dashboard: 2 riquadri');
});

test('«Tutti» and one tile at a time, in the order of the Dashboard', () => {
  const form = { ...emptyForm(), title: 'Mattina', sources: ['dashboard' as const] };
  // «Tutti» off: from the tiles there are now, so the user takes some away.
  const some = toggledAllTiles(form, TILES);
  assert.deepEqual(some, ['a', 'b', 'c']);
  const chosen = { ...form, dashboardTiles: some };
  assert.deepEqual(toggledTile(chosen, 'b', TILES), ['a', 'c']);
  assert.deepEqual(toggledTile({ ...form, dashboardTiles: ['c'] }, 'a', TILES), ['a', 'c']);
  // «Tutti» on again: every tile, also those pinned later.
  assert.equal(toggledAllTiles(chosen, TILES), null);
  // None chosen: the form says so.
  assert.equal(formProblem({ ...form, dashboardTiles: [] }), 'Scegli almeno un riquadro della Dashboard, o «Tutti».');
  assert.equal(formProblem({ ...form, dashboardTiles: ['a'] }), null);
  assert.equal(formProblem({ ...form, sources: ['todo'], dashboardTiles: [] }), null);
});

test('what the form sends: the choice only with the source, as chosen (the core drops the tiles no longer there)', () => {
  const form = { ...emptyForm(), title: '  Mattina ', sources: ['todo' as const, 'dashboard' as const], dashboardTiles: ['a', 'gone'] };
  // Also before the tiles are loaded: the choice is never emptied by the page.
  assert.deepEqual(formBody(form), { title: 'Mattina', days: form.days, at: form.at, sources: ['todo', 'dashboard'], summary: true, dashboardTiles: ['a', 'gone'] });
  assert.equal(formBody({ ...form, dashboardTiles: null }).dashboardTiles, null);
  assert.ok(!('dashboardTiles' in formBody({ ...form, sources: ['todo'] })));
});

test('a routine whose tiles were all removed opens with an empty choice, never «Tutti» by itself', () => {
  const routine = { title: 'Mattina', days: [1], at: '08:00', sources: ['dashboard'], dashboardTiles: [], summary: false } as unknown as Routine;
  assert.deepEqual(formOf(routine).dashboardTiles, []);
  assert.notEqual(formProblem(formOf(routine)), null);
});

test('the card of a proposal in the chat: the source «Dashboard» is every tile', () => {
  const card = routineProposal({ kind: 'routine', detail: { routineId: 'x', title: 'Mattina finta', days: [1, 2, 3, 4, 5], at: '08:00', timezone: 'Europe/Rome', sources: ['todo', 'dashboard'], summary: true } }, 'Europe/Rome');
  assert.deepEqual(card?.sources, ['Da fare', PROPOSAL_DASHBOARD_TEXT]);
});
