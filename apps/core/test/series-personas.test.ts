// The person of the series an agent wears (D-214): name and personality of
// the character as an L0 piece of the tail, the user's own text winning.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { MAX_SERIES_TRAITS, SERIES_PERSONAS, seriesPersonaBlock, seriesPersonaOf, type Persona } from '@arianna/agents';
import { piiReport, piiVerdict } from '@arianna/policy';
import { resolveHome } from '@arianna/config';

import { characterChoiceOf, characterPart, seriesNamesInUse, tailParts, type TailConfig } from '../src/prompt-tail.ts';
import { themeCharactersSync } from '../src/themes.ts';

const HOME = resolveHome({});
const THEMES = join(HOME, 'apps', 'hud', 'themes');
const root = join(HOME, 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const corsia = (extra: Partial<TailConfig> = {}): TailConfig => ({ personas: {}, appearance: { theme: 'corsia' }, home: HOME, ...extra });

test('every person of the pack serie has a name as in pack.json and a personality within 250 characters, and nobody else has one', () => {
  const pack = JSON.parse(readFileSync(join(HOME, 'apps', 'hud', 'characters', 'serie', 'pack.json'), 'utf8')) as { characters: { id: string; name: string }[] };
  assert.deepEqual(
    Object.entries(SERIES_PERSONAS).map(([id, person]) => [id, person.name]),
    pack.characters.map(({ id, name }) => [id, name]),
  );
  for (const [id, person] of Object.entries(SERIES_PERSONAS)) {
    assert.ok(Array.from(person.traits).length <= MAX_SERIES_TRAITS, id);
    assert.doesNotMatch(person.traits, /<|>/, id);
  }
  assert.equal(seriesPersonaOf('originali/arianna-corsia'), undefined);
  assert.equal(seriesPersonaOf('miei/cox'), undefined);
  assert.equal(seriesPersonaOf('serie/constructor'), undefined);
  assert.equal(seriesPersonaOf('serie/cox/x'), undefined);
  assert.equal(seriesPersonaOf(undefined), undefined);
  assert.equal(seriesPersonaOf('serie/cox')?.name, 'Dr. Cox');
});

test('the character comes from the theme in use, and a choice in [characters] wins over it', () => {
  assert.equal(characterChoiceOf(corsia(), 'god'), 'serie/cox');
  assert.equal(characterChoiceOf(corsia({ appearance: { theme: 'ufficio' } }), 'god'), 'serie/michael');
  assert.equal(characterChoiceOf(corsia({ characters: { god: 'serie/pam' } }), 'god'), 'serie/pam');
  assert.equal(characterChoiceOf(corsia({ characters: { god: 'originali/god' } }), 'god'), 'originali/god');
  assert.equal(characterChoiceOf(corsia({ appearance: { theme: 'base' } }), 'god'), undefined);
  assert.equal(characterChoiceOf(corsia({ appearance: { theme: 'sparito' } }), 'god'), undefined);
  assert.equal(characterChoiceOf(corsia(), 'constructor'), undefined);
  // Without a home and a reader nothing is read; a reader given by the caller is used.
  assert.equal(characterChoiceOf({ personas: {}, appearance: { theme: 'corsia' } }, 'god'), undefined);
  assert.equal(characterChoiceOf({ personas: {}, appearance: { theme: 'x' }, themeCharacters: () => ({ god: 'serie/jim' }) }, 'god'), 'serie/jim');
});

test('characterPart: the person of the series as an L0 piece, with its name and its personality, for the cloud too', () => {
  const part = characterPart(corsia(), 'god');
  assert.ok(part !== undefined);
  assert.deepEqual([part.label, part.source], ['L0', 'character:serie/cox']);
  assert.match(part.text, /Call yourself "Dr\. Cox"/);
  assert.match(part.text, /tone only \(rules, tools, labels, approvals and tasks unchanged\)/);
  assert.match(part.text, /answers stay correct and complete; never offensive/);
  assert.match(part.text, /<character>Burbero e sarcastico/);
  // A costume of the originals, or no theme: nothing.
  assert.equal(characterPart(corsia(), 'designer'), undefined);
  assert.equal(characterPart(corsia({ appearance: { theme: 'base' } }), 'god'), undefined);
});

test('the name and the personality the user wrote win over the character’s, whatever the clearance', () => {
  const named: Persona = { tone: 'equilibrato', address: 'tu', displayName: 'Capo' };
  const withName = characterPart(corsia({ personas: { god: named } }), 'god');
  assert.ok(withName !== undefined);
  assert.doesNotMatch(withName.text, /Call yourself/);
  assert.match(withName.text, /<character>/);
  const withTraits = characterPart(corsia({ personas: { god: { tone: 'equilibrato', address: 'tu', traits: 'Gentile.' } } }), 'god');
  assert.ok(withTraits !== undefined);
  assert.match(withTraits.text, /Call yourself "Dr\. Cox"/);
  assert.doesNotMatch(withTraits.text, /<character>/);
  assert.equal(characterPart(corsia({ personas: { god: { ...named, traits: 'Gentile.' } } }), 'god'), undefined);
  assert.equal(seriesPersonaBlock(SERIES_PERSONAS.cox ?? { name: '', traits: '' }, { withName: false, withTraits: false }), '');
  // An L0 step drops the user's text, but it still wins: the character's name does not come back.
  const parts = tailParts(corsia({ personas: { god: named } }), 'god', 'L0');
  assert.ok(parts.every((piece) => !piece.text.includes('Call yourself')));
});

test('tailParts: the character first, then the user’s persona, each with its label', () => {
  const parts = tailParts(corsia({ personas: { arianna: { tone: 'scherzoso', address: 'tu' } } }), 'arianna', 'L2');
  assert.deepEqual(
    parts.map((piece) => [piece.label, piece.source]),
    [
      ['L0', 'character:serie/carla'],
      ['L0', 'persona:arianna'],
    ],
  );
  // Base and no persona: the tail stays empty, the prompt the same byte for byte.
  assert.deepEqual(tailParts({ personas: {}, appearance: { theme: 'base' }, home: HOME }, 'arianna', 'L2'), []);
});

test('the names of the people worn are not persons for the second scanner, the others still are', () => {
  const names = seriesNamesInUse(corsia(), ['arianna', 'coder', 'god', 'designer']);
  assert.deepEqual(names.sort(), ['Carla', 'Cox', 'Dr Cox', 'Dr. Cox', 'J.D.', 'JD'].sort());
  const texts = ['Dr. Cox e Carla.', 'Pam'];
  const found = piiReport(texts, [[{ kind: 'FULLNAME', start: 0, end: 7, score: 0.9 }, { kind: 'FULLNAME', start: 10, end: 15, score: 0.9 }], [{ kind: 'FULLNAME', start: 0, end: 3, score: 0.9 }]], names);
  const verdict = piiVerdict(found, texts);
  assert.ok(verdict.verdict === 'found');
  // Only Pam, whom no agent wears in Corsia.
  assert.deepEqual(verdict.findings.map((finding) => finding.fragment), [1]);
  assert.deepEqual(seriesNamesInUse(corsia({ appearance: { theme: 'base' } }), ['god']), []);
});

test('themeCharactersSync reads a theme with the checks of listThemes, and nothing from a refused one', () => {
  assert.equal(themeCharactersSync(THEMES, 'corsia').arianna, 'serie/carla');
  assert.deepEqual(themeCharactersSync(THEMES, 'base'), {});
  assert.deepEqual(themeCharactersSync(THEMES, '../themes'), {});
  mkdirSync(join(root, 'due-file'), { recursive: true });
  const valid = readFileSync(join(THEMES, 'corsia', 'theme.json'), 'utf8').replace('"id": "corsia"', '"id": "due-file"');
  writeFileSync(join(root, 'due-file', 'theme.json'), valid);
  writeFileSync(join(root, 'due-file', 'altro.txt'), 'x');
  assert.deepEqual(themeCharactersSync(root, 'due-file'), {});
  mkdirSync(join(root, 'buono'));
  writeFileSync(join(root, 'buono', 'theme.json'), valid.replace('"id": "due-file"', '"id": "buono"'));
  assert.equal(themeCharactersSync(root, 'buono').god, 'serie/cox');
  symlinkSync(join(root, 'buono'), join(root, 'collegato'));
  assert.deepEqual(themeCharactersSync(root, 'collegato'), {});
  mkdirSync(join(root, 'rotto'));
  writeFileSync(join(root, 'rotto', 'theme.json'), '{ nope');
  assert.deepEqual(themeCharactersSync(root, 'rotto'), {});
});
