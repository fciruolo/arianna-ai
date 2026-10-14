// The name of the person of the series first, the agent's under it (D-214).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { agentLabelOf, agentLabelText, characterNames, rememberCharacterNames, seriesNames } from '../src/lib/character-names.ts';
import type { CharacterListing } from '../src/lib/types.ts';

const pack = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'characters', 'serie', 'pack.json'), 'utf8')) as { name: string; characters: { id: string; name: string }[] };

const listing: CharacterListing = {
  packs: [
    { id: 'originali', name: 'Originali', source: '', original: true, characters: [{ id: 'coder-corsia', name: 'Coder · Corsia', rows: 4 }] },
    { id: 'serie', name: pack.name, source: '', original: false, characters: pack.characters.map(({ id, name }) => ({ id, name, rows: 4 as const })) },
    { id: 'miei', name: 'Miei', source: '', original: false, characters: [{ id: 'cox', name: 'Un altro Cox', rows: 4 }] },
  ],
  refused: [],
  agents: {
    god: { pack: 'serie', character: 'cox', rows: 4, from: 'theme' },
    arianna: { pack: 'serie', character: 'carla', rows: 4, from: 'choice' },
    designer: { pack: 'originali', character: 'coder-corsia', rows: 4, from: 'theme' },
    coder: { pack: 'miei', character: 'cox', rows: 4, from: 'choice' },
    reviewer: { pack: 'serie', character: 'sparito', rows: 4, from: 'theme' },
  },
};

test('with a person of the series the chat shows the character first and the agent under it', () => {
  const names = seriesNames(listing);
  assert.deepEqual(names, { god: 'Dr. Cox', arianna: 'Carla' });
  assert.deepEqual(agentLabelOf('god', names), { main: 'Dr. Cox', sub: 'GOD' });
  assert.equal(agentLabelText('god', names), 'Dr. Cox (GOD)');
});

test('a costume, a pack of the user with the same id, a character missing from the pack: the agent’s name alone', () => {
  const names = seriesNames(listing);
  for (const agent of ['designer', 'coder', 'reviewer', 'finanze']) {
    assert.equal(agentLabelOf(agent, names).sub, null, agent);
  }
  assert.equal(agentLabelText('coder', names), 'Coder');
  assert.deepEqual(seriesNames(null), {});
  assert.deepEqual(seriesNames({ ...listing, packs: listing.packs.filter((entry) => entry.id !== 'serie') }), {});
  assert.equal(agentLabelOf('constructor', names).sub, null);
});

test('the store remembers the names at each read of the characters, and forgets them with Base', () => {
  rememberCharacterNames(listing);
  assert.equal(characterNames.value.god, 'Dr. Cox');
  rememberCharacterNames({ ...listing, agents: { god: { pack: 'originali', character: 'god', rows: 4, from: 'original' } } });
  assert.deepEqual(characterNames.value, {});
});
