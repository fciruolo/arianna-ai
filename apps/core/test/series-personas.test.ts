// The person of the series an agent wears (D-214): name and personality of
// the character as an L0 piece of the tail, the user's own text winning, and
// the character's name no person for the second scanner in that piece alone.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { MAX_SERIES_TEXT, SERIES_PERSONAS, SERIES_QUOTES, seriesNamesOfSource, seriesPersonaBlock, seriesPersonaOf, type Persona } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import { piiReport, piiVerdict, secretMatcher } from '@arianna/policy';

import { configureWornNames, fragmentNamesOf } from '../src/gateway.ts';
import { characterChoiceOf, characterDirsOf, characterPart, rosterPart, userNamesPart, wornSeriesNames, PROFILE_SOURCE, profilePart, promptTail, tailParts, type TailConfig } from '../src/prompt-tail.ts';
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
/** The cards of agents/ and one agent of the user (D-119), as main.ts tells the tail. */
const LOADED = { official: ['arianna', 'coder', 'god', 'designer', 'finanze', 'reviewer'], user: ['mio-agente'] };
const corsia = (extra: Partial<TailConfig> = {}): TailConfig => ({ personas: {}, appearance: { theme: 'corsia' }, home: HOME, paths: { data: root }, agentsNow: () => LOADED, ...extra });

test('every person of the pack serie has a name as in pack.json, a personality and 3-5 short catchphrases within 600 characters, and nobody else has one', () => {
  const pack = JSON.parse(readFileSync(join(HOME, 'apps', 'hud', 'characters', 'serie', 'pack.json'), 'utf8')) as { characters: { id: string; name: string }[] };
  assert.deepEqual(
    Object.entries(SERIES_PERSONAS).map(([id, person]) => [id, person.name]),
    pack.characters.map(({ id, name }) => [id, name]),
  );
  const others = (id: string) => Object.entries(SERIES_PERSONAS).filter(([other]) => other !== id).flatMap(([, person]) => [person.name, ...person.name.split(' ')]).filter((name) => name.length > 2 && name !== 'Dr.');
  for (const [id, person] of Object.entries(SERIES_PERSONAS)) {
    assert.ok(Array.from([person.traits, ...person.quotes].join('')).length <= MAX_SERIES_TEXT, id);
    assert.ok(person.quotes.length >= SERIES_QUOTES.min && person.quotes.length <= SERIES_QUOTES.max, id);
    for (const quote of person.quotes) {
      assert.ok(quote.trim() !== '' && Array.from(quote).length <= SERIES_QUOTES.maxLength, `${id}: ${quote}`);
      assert.doesNotMatch(quote, /[<>\n]/, id);
    }
    assert.doesNotMatch(person.traits, /<|>/, id);
    // No other character's name in its piece: in a brief to the cloud it would be a person (D-113).
    for (const name of others(id)) assert.ok(![person.traits, ...person.quotes].some((text) => text.includes(name)), `${id} names ${name}`);
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
  // The catchphrases, one to open or close every answer, in turn (the user's request).
  assert.match(part.text, /Open or close every answer with one of these lines of the character, a different one each time; it never changes what the answer says:\n- Che vuoi, pivello\?/);
  // A costume of the originals, or Base: nothing.
  assert.equal(characterPart(corsia(), 'designer'), undefined);
  assert.equal(characterPart(corsia({ appearance: { theme: 'base' } }), 'god'), undefined);
});

test('an agent of the user (D-119) with a person of the series chosen by hand speaks like the official cards', () => {
  const part = characterPart(corsia({ appearance: { theme: 'base' }, characters: { 'mio-agente': 'serie/pam' } }), 'mio-agente');
  assert.deepEqual([part?.label, part?.source], ['L0', 'character:serie/pam']);
  assert.match(part?.text ?? '', /Call yourself "Pam"/);
  // Its name is no person in its own piece for the second scanner, as for a card of agents/.
  assert.ok(fragmentNamesOf([{ value: part?.text ?? '', label: 'L0', source: part?.source ?? '' }], [])[0]?.includes('Pam'));
  // And the others know it by that name (D-217), in the piece of the user's text: its name is the user's, L1.
  const mine = corsia({ appearance: { theme: 'base' }, characters: { 'mio-agente': 'serie/pam' } });
  assert.equal(rosterPart(mine, 'arianna'), undefined);
  const names = userNamesPart(mine, 'arianna', 'L1');
  assert.deepEqual([names?.label, names?.source], ['L1', 'persona:names']);
  assert.match(names?.text ?? '', /- Mio-agente: "Pam"/);
  assert.equal(userNamesPart(mine, 'arianna', 'L0'), undefined);
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
  assert.doesNotMatch(withTraits.text, /<character>|pivello/);
  assert.equal(characterPart(corsia({ personas: { god: { ...named, traits: 'Gentile.' } } }), 'god'), undefined);
  assert.equal(seriesPersonaBlock(SERIES_PERSONAS.cox ?? { name: '', traits: '', quotes: [] }, { withName: false, withTraits: false }), '');
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
      ['L0', 'character:roster'],
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
  // Every name of the series, with «Cox» and «JD», in the pieces of the characters and of who is who only (D-217).
  for (const source of ['character:serie/cox', 'character:roster']) {
    for (const name of ['Dr. Cox', 'Cox', 'Dr Cox', 'J.D.', 'JD', 'Carla', 'Pam']) assert.ok(seriesNamesOfSource(source)?.includes(name), `${source} ${name}`);
  }
  for (const source of ['brief', 'persona:god', 'persona:names', 'character:miei/cox', 'character:serie/sparito', undefined, 7]) assert.equal(seriesNamesOfSource(source), undefined, String(source));
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

test('the character, the user’s persona and the profile «Su di te» (D-213) live together in the tail, each with its label and source', () => {
  const facts = [
    { topic: 'Lavoro', text: 'Lavoro da casa il venerdì.', label: 'L1' },
    { topic: 'Salute', text: 'Allergico alle arachidi.', label: 'L2' },
  ];
  const config = corsia({ personas: { arianna: { tone: 'scherzoso', address: 'tu' } } });
  for (const clearance of ['L2', 'L1'] as const) {
    const profile = profilePart(facts, clearance, { shareTool: true });
    assert.ok(profile !== undefined, clearance);
    const tail = [...tailParts(config, 'arianna', clearance), profile];
    assert.deepEqual(
      tail.map((piece) => piece.source),
      ['character:serie/carla', 'character:roster', 'persona:arianna', PROFILE_SOURCE],
      clearance,
    );
    // The character stays L0 and does not lower nor raise the profile's label.
    assert.equal(tail[0]?.label, 'L0');
    assert.equal(tail[3]?.label, profile.label);
    const text = promptTail(tail.map((piece) => piece.text));
    assert.ok(text.indexOf('<character>') < text.indexOf('Persona set by the user') && text.indexOf('Persona set by the user') < text.indexOf('Lavoro'), clearance);
    // Without names worn (no theme told to the gateway) the second scanner takes «Carla» for no person in the
    // character's pieces only, never in the profile; with a theme the worn names count everywhere, whole (D-217).
    assert.deepEqual(
      fragmentNamesOf(
        tail.map((piece) => ({ value: piece.text, label: piece.label, source: piece.source })),
        [],
      ).map((names) => names?.includes('Carla') ?? false),
      [true, true, false, false],
    );
  }
});

test('who is who (D-217): each agent reads the names of the others in the theme, the user’s names winning, with their label', () => {
  const roster = rosterPart(corsia(), 'god');
  assert.ok(roster !== undefined);
  assert.deepEqual([roster.label, roster.source], ['L0', 'character:roster']);
  assert.match(roster.text, /call it by its name here \(Arianna is also the assistant, the system\)/);
  assert.match(roster.text, /- Arianna: "Carla"/);
  assert.match(roster.text, /- Coder: "J\.D\."/);
  assert.match(roster.text, /- Reviewer: "Elliot"/);
  // Not itself, nor an agent in a costume of the originals.
  assert.doesNotMatch(roster.text, /GOD|Designer/);
  // An agent without a person of the series still reads the others' names.
  assert.match(rosterPart(corsia(), 'designer')?.text ?? '', /- GOD: "Dr\. Cox"/);
  // Base and no choice: nobody.
  assert.equal(rosterPart(corsia({ appearance: { theme: 'base' } }), 'god'), undefined);
  // The name the user wrote wins: out of the L0 piece, into the user's piece, L1 and only where L1 fits.
  const named = corsia({ personas: { arianna: { tone: 'equilibrato', address: 'tu' }, coder: { tone: 'equilibrato', address: 'tu', displayName: 'Bruno' } } });
  assert.doesNotMatch(rosterPart(named, 'god')?.text ?? '', /Coder|J\.D\./);
  const own = userNamesPart(named, 'god', 'L1');
  assert.deepEqual([own?.label, own?.source], ['L1', 'persona:names']);
  assert.match(own?.text ?? '', /- Coder: "Bruno"/);
  assert.equal(userNamesPart(named, 'god', 'L0'), undefined);
  assert.equal(userNamesPart(named, 'coder', 'L1'), undefined, 'its own name is in its persona');
  // The names worn now, whole, for the gateway.
  assert.deepEqual(wornSeriesNames(corsia()).sort(), ['Carla', 'Cox', 'Dr Cox', 'Dr. Cox', 'Elliot', 'J.D.', 'JD', 'Turk']);
  assert.deepEqual(wornSeriesNames(corsia({ appearance: { theme: 'base' } })), []);
});

test('an answer that called an agent by its character goes on in a brief; a real person does not (D-217)', () => {
  const brief = 'Ne ho parlato con Carla e con il Dr. Cox. Scrivi a Carla Bianchi e a Pam.';
  const at = (name: string, from = 0) => brief.indexOf(name, from);
  const people: [number, number, number][] = [
    [0, at('Carla'), at('Carla') + 5],
    [0, at('Dr. Cox'), at('Dr. Cox') + 7],
    [0, at('Carla Bianchi'), at('Carla Bianchi') + 13],
    [0, at('Pam'), at('Pam') + 3],
  ];
  const texts = [brief];
  const entities = [people.map(([, start, end]) => ({ kind: 'FULLNAME', start, end, score: 0.9 }))];
  const check = (worn: readonly string[]) => piiVerdict(piiReport(texts, entities, [], fragmentNamesOf([{ value: brief, label: 'L1', source: 'message:1' }], worn)), texts);
  // With Scrubs: Carla and Dr. Cox are names worn now and pass whole; Carla Bianchi and Pam (nobody wears Pam) are persons.
  const scrubs = check(wornSeriesNames(corsia()));
  assert.ok(scrubs.verdict === 'found');
  const only = (names: string[]) => piiVerdict(piiReport([names.join(' e ')], [names.map((name, index) => ({ kind: 'FULLNAME', start: names.slice(0, index).join(' e ').length + (index > 0 ? 3 : 0), end: names.slice(0, index).join(' e ').length + (index > 0 ? 3 : 0) + name.length, score: 0.9 }))], [], fragmentNamesOf([{ value: names.join(' e '), label: 'L1', source: 'message:1' }], wornSeriesNames(corsia()))), [names.join(' e ')]);
  assert.deepEqual(only(['Carla', 'Dr. Cox']), { verdict: 'clean' });
  // The scanner finds «Cox» alone in «il Dr. Cox» (measured on Rizzo-PII): the form counts too.
  assert.deepEqual(only(['Cox', 'Elliot', 'Turk']), { verdict: 'clean' });
  assert.equal(only(['Carla Bianchi']).verdict, 'found');
  assert.equal(only(['Pam']).verdict, 'found');
  // Without a theme nobody is worn: Carla is a person again.
  assert.equal(check([]).verdict, 'found');
});

test('a key of [characters] or of the theme without a loaded agent counts for nothing, in who is who and for the gateway (D-217)', () => {
  const stale = corsia({ characters: { cancellato: 'serie/pam' } });
  assert.doesNotMatch(rosterPart(stale, 'god')?.text ?? '', /Pam|Cancellato/);
  assert.ok(!wornSeriesNames(stale).includes('Pam'));
  // Nothing loaded (main.ts has not told the tail yet): nobody in who is who, no name worn.
  const none = corsia({ agentsNow: () => ({ official: [], user: [] }) });
  assert.equal(rosterPart(none, 'god'), undefined);
  assert.deepEqual(wornSeriesNames(none), []);
});

test('a name the user wrote that looks like personal data or holds a value of the vault stays out of who is who (D-217)', () => {
  const named = corsia({ personas: { coder: { tone: 'equilibrato', address: 'tu', displayName: 'Bruno Zqfinto' } } });
  assert.match(userNamesPart(named, 'god', 'L1')?.text ?? '', /Bruno Zqfinto/);
  assert.equal(userNamesPart(named, 'god', 'L1', secretMatcher([{ ref: 'vault://nome-finto', value: 'Bruno Zqfinto' }])), undefined);
});

test('the piece of the names the user wrote passes the second scanner with its own names, only there (D-217)', () => {
  const named = corsia({ personas: { coder: { tone: 'equilibrato', address: 'tu', displayName: 'Bruno' } } });
  const piece = userNamesPart(named, 'god', 'L1');
  assert.ok(piece !== undefined);
  const [own, other] = fragmentNamesOf(
    [
      { value: piece.text, label: piece.label, source: piece.source },
      { value: 'Scrivi a Bruno.', label: 'L1', source: 'message:1' },
    ],
    [],
  );
  assert.deepEqual(own, ['Coder', 'Bruno']);
  assert.equal(other, undefined);
});

test('the gateway reads the names worn from main.ts when not given (configureWornNames)', () => {
  configureWornNames(() => ['Carla']);
  try {
    assert.deepEqual(fragmentNamesOf([{ value: 'Ciao Carla', label: 'L1', source: 'message:1' }]), [['Carla']]);
  } finally {
    configureWornNames(() => []);
  }
  assert.deepEqual(fragmentNamesOf([{ value: 'Ciao Carla', label: 'L1', source: 'message:1' }]), [undefined]);
});
