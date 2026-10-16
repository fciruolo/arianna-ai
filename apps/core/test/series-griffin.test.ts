// The theme «I Griffin» (D-238) on the side of the core: who wears whom, the
// piece of the character, who is who, the names worn for the second scanner
// and the pages of Wikiquote. The tests shared with the other series cover
// it too (names as in pack.json, limits of the texts, no other character's
// name in personality and lines); here what is its own.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { SERIES_PERSONAS, seriesShowNames } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { characterChoiceOf, characterPart, rosterPart, wornSeriesNames, type TailConfig } from '../src/prompt-tail.ts';
import { parseWikiquote, WIKIQUOTE_PAGES, WIKIQUOTE_SPEAKERS, wikiquoteName } from '../src/wikiquote.ts';

const HOME = resolveHome({});
const root = join(HOME, 'data', 'test-tmp', randomUUID());
mkdirSync(root, { recursive: true });
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const LOADED = { official: ['arianna', 'coder', 'god', 'designer', 'finanze', 'reviewer', 'local-chat'], user: [] };
const quahog = (extra: Partial<TailConfig> = {}): TailConfig => ({ personas: {}, appearance: { theme: 'quahog' }, home: HOME, paths: { data: root }, agentsNow: () => LOADED, ...extra });

const ROLES = { arianna: 'lois', coder: 'peter', god: 'stewie', reviewer: 'brian', finanze: 'meg', designer: 'chris', 'local-chat': 'cleveland' } as const;

test('with I Griffin every agent wears its person of the family, chosen as the chat chooses it (D-238)', () => {
  for (const [agent, person] of Object.entries(ROLES)) {
    assert.equal(characterChoiceOf(quahog(), agent), `serie/${person}`, agent);
    assert.equal(characterPart(quahog(), agent)?.source, `character:serie/${person}`, agent);
  }
  // A choice by hand still wins over the theme.
  assert.equal(characterChoiceOf(quahog({ characters: { god: 'serie/cox' } }), 'god'), 'serie/cox');
});

test('the piece of Stewie speaks with his voice, the scene with the family in a private step only (D-238)', () => {
  const work = characterPart(quahog(), 'god', 'L1');
  assert.ok(work !== undefined);
  assert.equal(work.label, 'L0');
  assert.match(work.text, /Call yourself "Stewie"\. You are Stewie of Family Guy, never Arianna/);
  assert.doesNotMatch(work.text, /<scene>|Quahog|Lois/);
  const play = characterPart(quahog(), 'god', 'L2');
  assert.match(play?.text ?? '', /<scene>[^<]*Quahog[^<]*Lois[^<]*<\/scene>/);
});

test('who is who names the others of the family, and their names are worn for the second scanner (D-238)', () => {
  const roster = rosterPart(quahog(), 'arianna');
  assert.ok(roster !== undefined);
  for (const name of ['Peter', 'Stewie', 'Brian', 'Meg', 'Chris']) assert.match(roster.text, new RegExp(`"${name}"`), name);
  assert.doesNotMatch(roster.text, /"Lois"/);
  const worn = wornSeriesNames(quahog());
  for (const name of ['Lois', 'Peter', 'Peter Griffin', 'Stewie', 'Brian', 'Meg', 'Chris', 'Cleveland', 'Cleveland Brown']) assert.ok(worn.includes(name), name);
  // A name of another series is no name worn with this theme.
  assert.ok(!worn.includes('Carla'));
  // The names of the series, for a chat with one of them: the family, and nobody of Scrubs.
  assert.ok(seriesShowNames('peter').includes('Lois'));
  assert.ok(!seriesShowNames('peter').includes('Carla'));
});

test('Wikiquote: one page for the whole series, the names of the dub for each person (D-238)', () => {
  assert.deepEqual(WIKIQUOTE_PAGES['Family Guy'], [{ title: 'I Griffin' }]);
  assert.equal(wikiquoteName('Family Guy'), 'I Griffin');
  for (const id of Object.keys(ROLES).map((agent) => ROLES[agent as keyof typeof ROLES])) {
    assert.equal(SERIES_PERSONAS[id]?.show, 'Family Guy', id);
    assert.ok((WIKIQUOTE_SPEAKERS[id]?.length ?? 0) > 0, id);
  }
  // A made-up page in the form of a whole series: the season from its heading, the episode from its own.
  const page = [
    '==Stagione 2==',
    "===Episodio 3, ''Un titolo inventato''===",
    "*Una battuta inventata per la prova del parser. ('''Stewie''')",
    "*'''Peter''': Hehehe, questa è inventata.<br />'''Stewie Griffin''': Anche questa, che noia.",
    '==Note==',
    "*Fuori dalla serie. ('''Stewie''')",
  ].join('\n');
  assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.stewie ?? []), [
    { text: 'Una battuta inventata per la prova del parser.', episode: '2x03' },
    { text: 'Anche questa, che noia.', episode: '2x03' },
  ]);
  assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.peter ?? []).map((line) => line.text), ['Hehehe, questa è inventata.']);
});
