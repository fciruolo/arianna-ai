// The theme Langley, American Dad! (D-239): who wears whom, the names of the
// Smiths for the second scanner, their lines on Wikiquote. Fan art for
// personal use like the pack `serie`: it goes away with it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { SERIES_PERSONAS, seriesNamesOf, seriesNamesOfSource, seriesShowNames } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { characterChoiceOf, characterPart, rosterPart, wornSeriesNames, type TailConfig } from '../src/prompt-tail.ts';
import { themeCharactersSync } from '../src/themes.ts';
import { parseWikiquote, WIKIQUOTE_PAGES, WIKIQUOTE_SPEAKERS, wikiquoteName } from '../src/wikiquote.ts';

const HOME = resolveHome({});
const THEMES = join(HOME, 'apps', 'hud', 'themes');
const root = join(HOME, 'data', 'test-tmp', randomUUID());
mkdirSync(root, { recursive: true });
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const LOADED = { official: ['arianna', 'coder', 'god', 'designer', 'finanze', 'reviewer', 'local-chat'], user: [] };
const langley = (extra: Partial<TailConfig> = {}): TailConfig => ({ personas: {}, appearance: { theme: 'langley' }, home: HOME, paths: { data: root }, agentsNow: () => LOADED, ...extra });

const ROLES = { arianna: 'francine', coder: 'stan', god: 'roger', reviewer: 'hayley', finanze: 'bullock', designer: 'steve', 'local-chat': 'klaus' } as const;

test('in American Dad every agent of the theme wears its Smith, as the chat chooses it', () => {
  assert.deepEqual(themeCharactersSync(THEMES, 'langley'), Object.fromEntries(Object.entries(ROLES).map(([agent, id]) => [agent, `serie/${id}`])));
  for (const [agent, id] of Object.entries(ROLES)) {
    assert.equal(characterChoiceOf(langley(), agent), `serie/${id}`, agent);
    assert.equal(characterPart(langley(), agent)?.source, `character:serie/${id}`, agent);
  }
  // The explicit choice still wins over the theme; another theme gives nobody of American Dad.
  assert.equal(characterChoiceOf(langley({ characters: { coder: 'serie/jd' } }), 'coder'), 'serie/jd');
  assert.ok(!Object.values(themeCharactersSync(THEMES, 'corsia')).some((choice) => Object.values(ROLES).some((id) => choice === `serie/${id}`)));
});

test('the block says who the character is, of which series, never Arianna; the scene only in a private step', () => {
  const work = characterPart(langley(), 'coder', 'L1');
  assert.ok(work !== undefined);
  assert.equal(work.label, 'L0');
  assert.match(work.text, /Call yourself "Stan"\. You are Stan of American Dad!, never Arianna/);
  assert.doesNotMatch(work.text, /<scene>|Langley Falls|Francine/);
  const play = characterPart(langley(), 'coder', 'L2');
  assert.match(play?.text ?? '', /<scene>[^<]*Langley Falls[^<]*Francine[^<]*<\/scene>/);
});

test('who is who names the Smiths, and an answer that names them goes on; their names are no persons in their own pieces', () => {
  const roster = rosterPart(langley(), 'arianna');
  assert.ok(roster !== undefined);
  for (const name of ['Stan', 'Roger', 'Hayley', 'Bullock', 'Steve', 'Klaus']) assert.match(roster.text, new RegExp(`"${name}"`), name);
  assert.doesNotMatch(roster.text, /"Francine"/);
  const worn = wornSeriesNames(langley());
  for (const name of ['Francine', 'Stan', 'Stan Smith', 'Roger', 'Hayley', 'Bullock', 'Avery Bullock', 'Steve', 'Klaus']) assert.ok(worn.includes(name), name);
  // Negative: with Scrubs nobody wears a Smith.
  assert.ok(!wornSeriesNames({ ...langley(), appearance: { theme: 'corsia' } }).includes('Stan'));
  assert.ok(seriesNamesOfSource('character:serie/roger')?.includes('Avery Bullock'));
  assert.deepEqual(seriesNamesOf(SERIES_PERSONAS.bullock ?? { name: '', show: '', traits: '', scene: '', quotes: [] }), ['Bullock', 'Avery Bullock']);
  assert.deepEqual(new Set(seriesShowNames('klaus')), new Set(['Francine', 'Francine Smith', 'Stan', 'Stan Smith', 'Roger', 'Hayley', 'Hayley Smith', 'Bullock', 'Avery Bullock', 'Steve', 'Steve Smith', 'Klaus']));
  assert.ok(!seriesShowNames('klaus').includes('Carla'));
});

test('the lines of the Smiths on Wikiquote: one page for the series, their names before the lines', () => {
  assert.deepEqual(WIKIQUOTE_PAGES['American Dad!'], [{ title: 'American Dad!' }]);
  assert.equal(wikiquoteName('American Dad!'), 'American Dad!');
  const page = [
    '==Stagione 1==',
    "===Episodio 3, ''Un titolo inventato''===",
    "*Una battuta inventata per provare il parser. ('''Stan''')",
    "*'''Roger''': Un turno inventato di un dialogo.<br />'''Francine''': Una risposta inventata.",
    '==Note==',
    "*Fuori dalla serie. ('''Stan''')",
  ].join('\n');
  assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.stan ?? []), [{ text: 'Una battuta inventata per provare il parser.', episode: '1x03' }]);
  assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.roger ?? []), [{ text: 'Un turno inventato di un dialogo.', episode: '1x03' }]);
  assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.hayley ?? []), []);
  for (const id of Object.values(ROLES)) assert.equal(SERIES_PERSONAS[id]?.show, 'American Dad!', id);
});
