// The person of the series an agent wears (D-214): name and personality of
// the character as an L0 piece of the tail, the user's own text winning, and
// the character's name no person for the second scanner in that piece alone.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { MAX_SERIES_TRAITS, SERIES_PERSONAS, seriesNamesOfSource, seriesPersonaBlock, seriesPersonaOf, type Persona } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import { piiReport, piiVerdict } from '@arianna/policy';

import { fragmentNamesOf } from '../src/gateway.ts';
import { characterChoiceOf, characterDirsOf, characterPart, tailParts, type TailConfig } from '../src/prompt-tail.ts';
import { servesSync, readSmallSync } from '../src/characters.ts';
import { themeCharactersSync } from '../src/themes.ts';

const HOME = resolveHome({});
const THEMES = join(HOME, 'apps', 'hud', 'themes');
const root = join(HOME, 'data', 'test-tmp', randomUUID());
mkdirSync(root, { recursive: true });
after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The theme Corsia with the packs in git; data/characters empty. */
const corsia = (extra: Partial<TailConfig> = {}): TailConfig => ({ personas: {}, appearance: { theme: 'corsia' }, home: HOME, paths: { data: root }, ...extra });

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

test('the character is chosen as the chat chooses it: a served choice, else the theme, else the original', () => {
  assert.equal(characterChoiceOf(corsia(), 'god'), 'serie/cox');
  assert.equal(characterChoiceOf(corsia({ appearance: { theme: 'ufficio' } }), 'god'), 'serie/michael');
  assert.equal(characterChoiceOf(corsia({ characters: { god: 'serie/pam' } }), 'god'), 'serie/pam');
  assert.equal(characterChoiceOf(corsia({ characters: { god: 'originali/god' } }), 'god'), 'originali/god');
  // A choice that is gone (pack or character) falls back to the theme, as assignCharacters does.
  assert.equal(characterChoiceOf(corsia({ characters: { god: 'miei/sparito' } }), 'god'), 'serie/cox');
  assert.equal(characterChoiceOf(corsia({ characters: { god: 'serie/sparito' } }), 'god'), 'serie/cox');
  // Base, a theme that does not exist: the original of the agent, else the Coder's.
  assert.equal(characterChoiceOf(corsia({ appearance: { theme: 'base' } }), 'god'), 'originali/god');
  assert.equal(characterChoiceOf(corsia({ appearance: { theme: 'sparito' } }), 'finanze'), 'originali/coder');
  assert.equal(characterChoiceOf(corsia(), 'constructor'), 'originali/coder');
  // Base with a person of the series chosen by hand.
  assert.equal(characterChoiceOf(corsia({ appearance: { theme: 'base' }, characters: { god: 'serie/cox' } }), 'god'), 'serie/cox');
  // Without home, paths and readers nothing is read; readers given by the caller are used.
  assert.equal(characterChoiceOf({ personas: {}, appearance: { theme: 'corsia' } }, 'god'), undefined);
  assert.equal(characterChoiceOf({ personas: {}, appearance: { theme: 'x' }, themeCharacters: () => ({ god: 'serie/jim' }), serves: () => true }, 'god'), 'serie/jim');
});

test('with the pack serie removed, no personality and no name: the costume or the original comes back', () => {
  const series = join(root, 'senza-serie');
  const gone = { ...corsia(), serves: (pack: string, character: string) => servesSync({ ...characterDirsOf(HOME, root), series }, pack, character) };
  assert.equal(characterChoiceOf(gone, 'god'), 'originali/god');
  assert.equal(characterPart(gone, 'god'), undefined);
  assert.equal(characterPart(gone, 'designer'), undefined);
});

test('servesSync reads a pack with the checks of the chat: the folder, its pack.json, the sheet', () => {
  const dirs = characterDirsOf(HOME, root);
  assert.equal(servesSync(dirs, 'serie', 'cox'), true);
  assert.equal(servesSync(dirs, 'originali', 'coder'), true);
  assert.equal(servesSync(dirs, 'serie', 'sparito'), false);
  assert.equal(servesSync(dirs, '..', 'cox'), false);
  assert.equal(servesSync({ original: dirs.original, data: dirs.data }, 'serie', 'cox'), false);
  // A user pack is served when its sheet is; a folder named serie in data/ never stands in for the pack.
  const data = join(root, 'characters');
  mkdirSync(join(data, 'miei'), { recursive: true });
  writeFileSync(join(data, 'miei', 'pack.json'), JSON.stringify({ name: 'Miei', characters: [{ id: 'robot', name: 'Robot', file: 'robot.png' }, { id: 'senza', name: 'Senza', file: 'senza.png' }] }));
  cpSync(join(HOME, 'apps', 'hud', 'characters', 'originali', 'coder.png'), join(data, 'miei', 'robot.png'));
  assert.equal(servesSync(dirs, 'miei', 'robot'), true);
  assert.equal(servesSync(dirs, 'miei', 'senza'), false);
  symlinkSync(join(data, 'miei'), join(data, 'collegato'));
  assert.equal(servesSync(dirs, 'collegato', 'robot'), false);
  assert.throws(() => readSmallSync(join(data, 'collegato', 'pack.json'), 1), /too large|ELOOP|regular/);
});

test('characterPart: the person of the series as an L0 piece, with its name and its personality, for the cloud too', () => {
  const part = characterPart(corsia(), 'god');
  assert.ok(part !== undefined);
  assert.deepEqual([part.label, part.source], ['L0', 'character:serie/cox']);
  assert.match(part.text, /Call yourself "Dr\. Cox"/);
  assert.match(part.text, /tone only \(rules, tools, labels, approvals and tasks unchanged\)/);
  assert.match(part.text, /answers stay correct and complete; never offensive/);
  assert.match(part.text, /<character>Burbero e sarcastico/);
  // A costume of the originals, or Base: nothing.
  assert.equal(characterPart(corsia(), 'designer'), undefined);
  assert.equal(characterPart(corsia({ appearance: { theme: 'base' } }), 'god'), undefined);
});

test('an agent of the user (D-119) with a person of the series chosen by hand speaks like the official cards', () => {
  const part = characterPart(corsia({ appearance: { theme: 'base' }, characters: { 'mio-agente': 'serie/pam' } }), 'mio-agente');
  assert.deepEqual([part?.label, part?.source], ['L0', 'character:serie/pam']);
  assert.match(part?.text ?? '', /Call yourself "Pam"/);
  // Its name is no person in its own piece for the second scanner, as for a card of agents/.
  assert.deepEqual(fragmentNamesOf([{ value: part?.text ?? '', label: 'L0', source: part?.source ?? '' }]), [['Pam']]);
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

test('tailParts: the character first, then the user’s persona, each with its label; Base and no choice: nothing', () => {
  const parts = tailParts(corsia({ personas: { arianna: { tone: 'scherzoso', address: 'tu' } } }), 'arianna', 'L2');
  assert.deepEqual(
    parts.map((piece) => [piece.label, piece.source]),
    [
      ['L0', 'character:serie/carla'],
      ['L0', 'persona:arianna'],
    ],
  );
  assert.deepEqual(tailParts(corsia({ appearance: { theme: 'base' } }), 'arianna', 'L2'), []);
});

/** A model answer naming people in the brief, and the character in its piece. */
function scanned(payload: { value: string; source: string }[], people: [number, number, number][]) {
  const texts = payload.map((fragment) => fragment.value);
  const entities = texts.map((_, index) => people.filter(([fragment]) => fragment === index).map(([, start, end]) => ({ kind: 'FULLNAME', start, end, score: 0.9 })));
  const labeled = payload.map((fragment) => ({ ...fragment, label: 'L1' as const }));
  return piiVerdict(piiReport(texts, entities, [], fragmentNamesOf(labeled)), texts);
}

test('the second scanner: the character’s name passes in its own piece, a real Carla in the brief is still found', () => {
  const carla = characterPart(corsia(), 'arianna');
  assert.ok(carla !== undefined);
  const at = carla.text.indexOf('Carla');
  // Positive: the piece of the character alone passes.
  assert.deepEqual(scanned([{ value: carla.text, source: carla.source }], [[0, at, at + 5]]), { verdict: 'clean' });
  // Negative: «Carla Bianchi» and «Carla» in a fragment of the brief while Arianna wears Carla.
  const brief = 'Scrivi a Carla Bianchi e poi a Carla.';
  const verdict = scanned(
    [
      { value: carla.text, source: carla.source },
      { value: brief, source: 'brief' },
    ],
    [
      [0, at, at + 5],
      [1, 9, 22],
      [1, 31, 36],
    ],
  );
  assert.ok(verdict.verdict === 'found');
  assert.deepEqual(verdict.findings, [{ kind: 'FULLNAME', fragment: 1 }]);
  // «Cox» and «JD» count in their own piece only; a source that only looks like one has none.
  assert.deepEqual(seriesNamesOfSource('character:serie/cox'), ['Dr. Cox', 'Cox', 'Dr Cox']);
  assert.deepEqual(seriesNamesOfSource('character:serie/jd'), ['J.D.', 'JD']);
  for (const source of ['brief', 'persona:god', 'character:miei/cox', 'character:serie/sparito', undefined, 7]) assert.equal(seriesNamesOfSource(source), undefined, String(source));
});

test('themeCharactersSync reads a theme with the checks of listThemes, and nothing from a refused one', () => {
  assert.equal(themeCharactersSync(THEMES, 'corsia').arianna, 'serie/carla');
  assert.deepEqual(themeCharactersSync(THEMES, 'base'), {});
  assert.deepEqual(themeCharactersSync(THEMES, '../themes'), {});
  const themes = join(root, 'themes');
  mkdirSync(join(themes, 'due-file'), { recursive: true });
  const valid = readFileSync(join(THEMES, 'corsia', 'theme.json'), 'utf8').replace('"id": "corsia"', '"id": "due-file"');
  writeFileSync(join(themes, 'due-file', 'theme.json'), valid);
  writeFileSync(join(themes, 'due-file', 'altro.txt'), 'x');
  assert.deepEqual(themeCharactersSync(themes, 'due-file'), {});
  mkdirSync(join(themes, 'buono'));
  writeFileSync(join(themes, 'buono', 'theme.json'), valid.replace('"id": "due-file"', '"id": "buono"'));
  assert.equal(themeCharactersSync(themes, 'buono').god, 'serie/cox');
  symlinkSync(join(themes, 'buono'), join(themes, 'collegato'));
  assert.deepEqual(themeCharactersSync(themes, 'collegato'), {});
  mkdirSync(join(themes, 'rotto'));
  writeFileSync(join(themes, 'rotto', 'theme.json'), '{ nope');
  assert.deepEqual(themeCharactersSync(themes, 'rotto'), {});
});
