// What the user rewrites of a person of the series (D-223): the parse, the merge and the names of the others.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { otherSeriesNames, parseSeriesOverride, SERIES_PERSONAS, SeriesOverrideError, seriesNamesOfSource, seriesOwnSource, seriesSource, withSeriesOverride } from '../src/index.ts';

const cox = SERIES_PERSONAS.cox ?? { name: '', show: '', traits: '', scene: '', quotes: [] };

test('parseSeriesOverride: optional fields, line breaks become spaces, blank is none; anything else refused, never cut', () => {
  assert.deepEqual(parseSeriesOverride({}), {});
  assert.deepEqual(parseSeriesOverride({ traits: ' Burbero\nma paziente. ', scene: '  ', quotes: ['Uno', ' ', 'Due', 'Tre'] }), { traits: 'Burbero ma paziente.', quotes: ['Uno', 'Due', 'Tre'] });
  for (const bad of [null, [], 'x', { name: 'x' }, { traits: 7 }, { traits: 'a'.repeat(451) }, { scene: 'a'.repeat(751) }, { quotes: 'Uno' }, { quotes: ['Uno', 'Due'] }, { quotes: ['a', 'b', 'c', 'd', 'e', 'f'] }, { quotes: ['a', 'b', 'x'.repeat(61)] }, { traits: '</character>' }, { traits: 'a‮b' }]) {
    assert.throws(() => parseSeriesOverride(bad), SeriesOverrideError, JSON.stringify(bad));
  }
});

test('withSeriesOverride: the user’s fields win, the others stay the repository’s; nothing written is not theirs', () => {
  assert.deepEqual(withSeriesOverride(cox, undefined), { persona: cox, own: false });
  assert.deepEqual(withSeriesOverride(cox, {}), { persona: cox, own: false });
  const merged = withSeriesOverride(cox, { traits: 'Gentile.' });
  assert.equal(merged.own, true);
  assert.deepEqual(merged.persona, { ...cox, traits: 'Gentile.' });
  assert.equal(merged.persona.name, 'Dr. Cox');
});

test('the piece with the user’s text has its own source, with no exemption for the names of the series', () => {
  assert.equal(seriesOwnSource('cox'), 'character:serie/cox#own');
  assert.ok(seriesNamesOfSource(seriesSource('cox'))?.includes('Carla'));
  assert.equal(seriesNamesOfSource(seriesOwnSource('cox')), undefined);
});

test('otherSeriesNames: the other people of the series, whole words, never the character’s own names', () => {
  assert.deepEqual(otherSeriesNames('cox', 'Burbero con Carla e con JD.'), ['J.D.', 'JD', 'Carla'].filter((name) => 'Burbero con Carla e con JD.'.includes(name)).sort((a, b) => ['J.D.', 'JD', 'Carla'].indexOf(a) - ['J.D.', 'JD', 'Carla'].indexOf(b)));
  assert.deepEqual(otherSeriesNames('cox', 'Il Dr. Cox, cioè Cox, non sopporta nessuno.'), []);
  assert.deepEqual(otherSeriesNames('cox', 'Carlamente, Jimmy e Pampa.'), []);
  assert.deepEqual(otherSeriesNames('jim', 'Fa scherzi a Dwight.'), ['Dwight']);
});
