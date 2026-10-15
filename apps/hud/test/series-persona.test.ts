// The card of a person of the series (D-223): the form, the rewrite and the checks.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nameForms, namesIn, quoteLines, seriesForm, seriesProblem, seriesRewrite, withRewrite } from '../src/lib/series-persona.ts';

const REPO = { traits: 'Burbero e sarcastico.', scene: 'Lavora al Sacro Cuore.', quotes: ['Che vuoi?', 'Sbagliato!', 'Ecco la risposta.'] };

test('the form shows the rewrite where there is one, the repository elsewhere', () => {
  assert.deepEqual(seriesForm(REPO, null), { traits: REPO.traits, scene: REPO.scene, quotes: 'Che vuoi?\nSbagliato!\nEcco la risposta.' });
  assert.deepEqual(seriesForm(REPO, { traits: 'Gentile.' }).traits, 'Gentile.');
  assert.equal(seriesForm(REPO, { traits: 'Gentile.' }).scene, REPO.scene);
});

test('the rewrite keeps only what differs, spaces and blank lines aside', () => {
  assert.deepEqual(seriesRewrite(seriesForm(REPO, null), REPO), {});
  assert.deepEqual(seriesRewrite({ ...seriesForm(REPO, null), traits: '  Burbero   e sarcastico. ' }, REPO), {});
  assert.deepEqual(seriesRewrite({ ...seriesForm(REPO, null), quotes: 'Che vuoi?\n\nSbagliato!\nEcco la risposta.\n' }, REPO), {});
  assert.deepEqual(seriesRewrite({ ...seriesForm(REPO, null), traits: 'Gentile\ne calmo.' }, REPO), { traits: 'Gentile e calmo.' });
  assert.deepEqual(seriesRewrite({ ...seriesForm(REPO, null), quotes: 'Uno\nDue\nTre' }, REPO), { quotes: ['Uno', 'Due', 'Tre'] });
  // An emptied field goes back to the repository's text, never to nothing.
  assert.deepEqual(seriesRewrite({ ...seriesForm(REPO, null), scene: '   ' }, REPO), {});
  assert.deepEqual(quoteLines(' a \n\n b '), ['a', 'b']);
});

test('the checks the core makes, in Italian: limits, catchphrases, angle brackets', () => {
  assert.equal(seriesProblem(seriesForm(REPO, null)), null);
  assert.match(seriesProblem({ ...seriesForm(REPO, null), traits: 'x'.repeat(451) }) ?? '', /450/);
  assert.match(seriesProblem({ ...seriesForm(REPO, null), scene: 'x'.repeat(751) }) ?? '', /750/);
  assert.match(seriesProblem({ ...seriesForm(REPO, null), quotes: 'Uno\nDue' }) ?? '', /da 3 a 5/);
  assert.match(seriesProblem({ ...seriesForm(REPO, null), quotes: 'a\nb\nc\nd\ne\nf' }) ?? '', /da 3 a 5/);
  assert.match(seriesProblem({ ...seriesForm(REPO, null), quotes: `a\nb\n${'x'.repeat(61)}` }) ?? '', /60/);
  assert.match(seriesProblem({ ...seriesForm(REPO, null), traits: '<scene>' }) ?? '', /< né >/);
});

test('another character of the series only in the scene; the forms of a name as the core reads them', () => {
  const others = ['J.D.', 'JD', 'Carla', 'Turk'];
  assert.equal(seriesProblem({ ...seriesForm(REPO, null), scene: 'Con Carla e JD.' }, others), null);
  assert.match(seriesProblem({ ...seriesForm(REPO, null), traits: 'Non sopporta JD.' }, others) ?? '', /^JD: gli altri personaggi solo nella scena/);
  assert.match(seriesProblem({ ...seriesForm(REPO, null), quotes: 'Ciao Turk\nDue\nTre' }, others) ?? '', /^Turk:/);
  assert.equal(seriesProblem({ ...seriesForm(REPO, null), traits: 'Carlamente.' }, others), null);
  assert.deepEqual(nameForms('Dr. Cox'), ['Dr. Cox', 'Cox', 'Dr Cox']);
  assert.deepEqual(nameForms('J.D.'), ['J.D.', 'JD']);
  assert.deepEqual(namesIn('Con J.D. e Turk', others), ['J.D.', 'Turk']);
});

test('withRewrite replaces one character and drops it when nothing differs', () => {
  const series = { cox: { traits: 'A.' }, jd: { scene: 'B.' } };
  assert.deepEqual(withRewrite(series, 'cox', {}), { jd: { scene: 'B.' } });
  assert.deepEqual(withRewrite(series, 'cox', { quotes: ['x', 'y', 'z'] }), { jd: { scene: 'B.' }, cox: { quotes: ['x', 'y', 'z'] } });
  assert.deepEqual(series, { cox: { traits: 'A.' }, jd: { scene: 'B.' } });
});
