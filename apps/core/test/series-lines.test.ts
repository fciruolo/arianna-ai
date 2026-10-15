// The archive of real lines of the people of the series (D-224): collected by
// Claude a hundred at a time from the names alone, numbered and without
// doubles, drawn by the core at each answer, named lines in private steps only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { seriesLinesBlock, seriesLinesSource, seriesNamesOfSource, seriesPersonaBlock, SERIES_PERSONAS } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import { secretMatcher } from '@arianna/policy';

import type { CloudTextRequest } from '../src/cloud-text.ts';
import { CloudTextError } from '../src/cloud-text.ts';
import { fragmentNamesOf } from '../src/gateway.ts';
import { characterPart, linesPart, tailParts, type LinesSource, type TailConfig } from '../src/prompt-tail.ts';
import { createSeriesLines, lineKey, lineText, linesPrompt, MAX_SERIES_LINES, namesSomeone, parseLines, SERIES_LINES_DIR } from '../src/series-lines.ts';

const HOME = resolveHome({});
const root = join(HOME, 'data', 'test-tmp', randomUUID());
mkdirSync(root, { recursive: true });
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const noSecrets = secretMatcher([]);
const answerOf = (lines: readonly { text: string; episode?: string; names?: string[] }[]): string => `Ecco:\n${JSON.stringify(lines)}`;

function archive(answers: (string | Error)[], dir = join(root, randomUUID())) {
  const asked: CloudTextRequest[] = [];
  const events: string[] = [];
  const lines = createSeriesLines({
    dir,
    secrets: noSecrets,
    random: () => 0.5,
    onEvent: (kind) => events.push(kind),
    ask: (request) => {
      asked.push(request);
      const next = answers.shift();
      if (next === undefined) return Promise.reject(new CloudTextError('failed', 'nessuna risposta finta'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  });
  return { lines, asked, events, dir };
}

test('lineText and lineKey: one line within the limit, no fences; the same line written a little differently is one', () => {
  assert.equal(lineText('  Che vuoi,\n pivello?  '), 'Che vuoi, pivello?');
  assert.equal(lineText(''), undefined);
  // A name alone, or a word alone, is not a line (seen in the first trial: «Jordan.», «Bobbo.»).
  assert.equal(lineText('Jordan.'), undefined);
  assert.equal(lineText('Straordinariamente!'), undefined);
  assert.equal(lineText('Ciao, novellino.'), 'Ciao, novellino.');
  assert.equal(lineText('a <b> c'), undefined);
  assert.equal(lineText('x'.repeat(201)), undefined);
  assert.equal(lineText(42), undefined);
  assert.equal(lineText('Ciao‮mondo'), undefined);
  assert.equal(lineKey('Sbagliato! Riprova.'), lineKey('sbagliato, riprova'));
  assert.equal(lineKey('Perché'), lineKey('perche'));
  assert.notEqual(lineKey('Sbagliato!'), lineKey('Giusto!'));
});

test('namesSomeone: another person of the series, or a capital word inside a sentence; the own name and the first word are not', () => {
  assert.equal(namesSomeone('cox', 'Sbagliato! Riprova.'), false);
  assert.equal(namesSomeone('cox', 'Sono il Dr. Cox, e tu no.'), false);
  assert.equal(namesSomeone('cox', 'Ascolta bene, Newbie.'), true);
  assert.equal(namesSomeone('cox', 'Odio Kelso più di ogni cosa.'), true);
  assert.equal(namesSomeone('cox', 'Carla ha ragione.'), true);
  assert.equal(namesSomeone('jd', 'Momento fantasia… ok, sono tornato.'), false);
  assert.equal(namesSomeone('dwight', 'Domanda. Perché me lo chiedi?'), false);
  // A first word called out with a comma: a name; the own name or an exclamation is not.
  assert.equal(namesSomeone('cox', 'Toby, vattene.'), true);
  assert.equal(namesSomeone('cox', 'Cox, ti prego.'), false);
  assert.equal(namesSomeone('cox', 'Ciao, novellino.'), false);
  assert.equal(namesSomeone('cox', 'No, no, no, no, no!'), false);
  assert.equal(namesSomeone('cox', 'Ciao, Barbie.'), true);
  assert.equal(namesSomeone('cox', 'Sbagliato! Riprova.'), false);
});

test('linesPrompt: only the names of the character and of the series, and the lines already kept', () => {
  const prompt = linesPrompt('Dr. Cox', 'Scrubs', 1);
  assert.match(prompt, /character "Dr\. Cox" of the TV series "Scrubs"/);
  assert.match(prompt, /They must be real lines of the series, not invented in its style/);
  assert.match(prompt, /never a name or a nickname alone, never a single word/);
  assert.match(prompt, /Italian dub when you know them, else a faithful translation/);
  assert.match(prompt, /none of the 1 lines already collected, in the JSON array of the next part/);
  assert.doesNotMatch(linesPrompt('Dr. Cox', 'Scrubs', 0), /already collected/);
});

test('parseLines: a JSON array of objects anywhere in the answer; what is not a line is left out', () => {
  assert.deepEqual(parseLines('nessun elenco'), undefined);
  assert.deepEqual(parseLines('[{"text": "a",'), undefined);
  assert.deepEqual(parseLines('{"text": "a"}'), undefined);
  assert.deepEqual(parseLines('Ecco [{"text":"Sbagliato! Riprova.","episode":"1x01","names":[]},{"text":""},{"text":"Bobbo."},{"x":1},"testo",{"text":"Kelso, vieni qui!","names":["Kelso"],"episode":""}]'), [
    { text: 'Sbagliato! Riprova.', episode: '1x01', names: [] },
    { text: 'Kelso, vieni qui!', names: ['Kelso'] },
  ]);
  assert.deepEqual(parseLines('[{"text":"Va bene, va bene.","episode":"<b>"}]'), [{ text: 'Va bene, va bene.', names: [] }]);
});

test('generate: Claude collects in the background from the names alone; numbered, doubles out, named lines marked, kept in data/characters/serie-lines', async () => {
  const { lines, asked, events, dir } = archive([
    answerOf([
      { text: 'Sbagliato! Riprova.', episode: '1x01' },
      { text: 'sbagliato, riprova' },
      { text: 'Ascolta bene, Newbie.', names: ['J.D.'] },
      { text: 'Odio il mio lavoro.' },
    ]),
    answerOf([{ text: 'Odio il mio lavoro!' }, { text: 'Fammi indovinare.' }]),
  ]);
  const started = lines.generate('cox');
  assert.equal(started.running, true);
  // A second click while it runs starts nothing.
  assert.equal(lines.generate('cox').running, true);
  await lines.idle();
  assert.equal(asked.length, 1);
  const [part, ...rest] = asked[0]?.parts ?? [];
  assert.deepEqual(rest, [], 'nothing kept yet: only our instructions');
  assert.equal(part?.label, undefined, 'L0, ours');
  assert.match(part?.text ?? '', /"Dr\. Cox" of the TV series "Scrubs"/);
  assert.doesNotMatch(asked[0]?.purpose ?? '', /Cox|Scrubs/);
  let status = lines.status('cox');
  assert.deepEqual(
    status.lines.map((line) => [line.n, line.text, line.episode ?? '', line.named]),
    [
      [1, 'Sbagliato! Riprova.', '1x01', false],
      [2, 'Ascolta bene, Newbie.', '', true],
      [3, 'Odio il mio lavoro.', '', false],
    ],
  );
  assert.deepEqual([status.running, status.stopped, status.added, status.max], [false, null, 3, MAX_SERIES_LINES]);
  assert.deepEqual(events, ['series.lines_added']);
  const file = JSON.parse(readFileSync(join(dir, SERIES_LINES_DIR, 'cox.json'), 'utf8')) as { next: number; lines: unknown[]; note: string };
  assert.equal(file.next, 4);
  assert.match(file.note, /Dr\. Cox \(Scrubs\)/);

  // «Togli»: the number is never given again; the next batch knows what is kept.
  status = lines.remove('cox', 3);
  assert.deepEqual(status.lines.map((line) => line.n), [1, 2]);
  lines.generate('cox');
  await lines.idle();
  // The lines kept leave apart, Interno: the file may hold lines written by hand.
  assert.deepEqual(asked[1]?.parts.at(1), { text: '["Sbagliato! Riprova.","Ascolta bene, Newbie."]', source: 'series-lines:cox', label: 'L1' });
  assert.deepEqual(
    lines.status('cox').lines.map((line) => [line.n, line.text]),
    [
      [1, 'Sbagliato! Riprova.'],
      [2, 'Ascolta bene, Newbie.'],
      [4, 'Odio il mio lavoro!'],
      [5, 'Fammi indovinare.'],
    ],
  );
  assert.throws(() => lines.remove('cox', 3), /nessuna citazione numero 3/);
  assert.throws(() => lines.status('nessuno'), /nessun personaggio/);
  assert.throws(() => lines.generate('constructor'), /nessun personaggio/);
});

test('generate: an unreadable answer or a Claude without quota stops it with a reason, and nothing is written', async () => {
  const { lines, events, dir } = archive(['non è JSON', new CloudTextError('quota', 'Claude è senza quota: riprova dopo il reset')]);
  lines.generate('jim');
  await lines.idle();
  assert.deepEqual([lines.status('jim').stopped, lines.status('jim').lines.length], ['la risposta di Claude non si legge: riprova', 0]);
  assert.deepEqual(events, ['series.lines_unreadable']);
  lines.generate('jim');
  await lines.idle();
  assert.equal(lines.status('jim').stopped, 'Claude è senza quota: riprova dopo il reset');
  assert.throws(() => readFileSync(join(dir, SERIES_LINES_DIR, 'jim.json')));
});

test('generate: never past MAX_SERIES_LINES; a full archive refuses another batch', async () => {
  const dir = join(root, randomUUID());
  mkdirSync(join(dir, SERIES_LINES_DIR), { recursive: true });
  const kept = Array.from({ length: MAX_SERIES_LINES - 1 }, (_, index) => ({ n: index + 1, text: `Questa è la battuta ${String(index + 1)}.`, named: false }));
  writeFileSync(join(dir, SERIES_LINES_DIR, 'pam.json'), JSON.stringify({ next: MAX_SERIES_LINES, lines: kept }));
  const { lines } = archive([answerOf([{ text: 'Questa è la prima.' }, { text: 'Questa è la seconda.' }])], dir);
  lines.generate('pam');
  await lines.idle();
  assert.equal(lines.status('pam').lines.length, MAX_SERIES_LINES);
  assert.equal(lines.status('pam').added, 1);
  assert.throws(() => lines.generate('pam'), /già 1000 citazioni/);
});

test('the file written by hand: a line with personal data or a vault value, a bad number or a double number is left out', () => {
  const dir = join(root, randomUUID());
  mkdirSync(join(dir, SERIES_LINES_DIR), { recursive: true });
  writeFileSync(
    join(dir, SERIES_LINES_DIR, 'dwight.json'),
    JSON.stringify({
      lines: [
        { n: 1, text: 'Fatto: ho ragione io.' },
        { n: 2, text: 'Paga su IT60X0542811101000000123456' },
        { n: 3, text: 'La parola è barbabietola-segreta-42.' },
        { n: 1, text: 'Questa ha un numero doppio.' },
        { n: 0, text: 'Questa ha il numero zero.' },
        { n: 8, text: 'Corta.' },
        { n: 7, text: 'Domanda: perché me lo chiedi?', episode: '2x03' },
      ],
    }),
  );
  const lines = createSeriesLines({ dir, ask: () => Promise.reject(new Error('no')), secrets: secretMatcher([{ ref: 'vault:prova', value: 'barbabietola-segreta-42' }]) });
  assert.deepEqual(
    lines.status('dwight').lines.map((line) => [line.n, line.text, line.episode ?? '']),
    [
      [1, 'Fatto: ho ragione io.', ''],
      [7, 'Domanda: perché me lo chiedi?', '2x03'],
    ],
  );
  // An unreadable file: no lines, never an error.
  writeFileSync(join(dir, SERIES_LINES_DIR, 'pam.json'), '{non json');
  assert.deepEqual(lines.status('pam').lines, []);
});

test('draw: a few at a time, not drawn lately in the same conversation; named lines only where admitted', () => {
  const dir = join(root, randomUUID());
  mkdirSync(join(dir, SERIES_LINES_DIR), { recursive: true });
  const kept = Array.from({ length: 12 }, (_, index) => ({ n: index + 1, text: `Questa è la battuta ${String(index + 1)}.`, named: index >= 10 }));
  writeFileSync(join(dir, SERIES_LINES_DIR, 'cox.json'), JSON.stringify({ next: 13, lines: kept }));
  let seed = 0;
  const lines = createSeriesLines({ dir, ask: () => Promise.reject(new Error('no')), secrets: noSecrets, random: () => ((seed = (seed * 9301 + 49297) % 233280) / 233280) });
  const first = lines.draw('cox', { conversation: 'a', named: false });
  const second = lines.draw('cox', { conversation: 'a', named: false });
  assert.equal(first.length, 5);
  assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second]).size, 10, 'none of the first five again while others are left');
  assert.ok([...first, ...second].every((line) => !/battuta 1[12]\./.test(line)), 'named lines out of a work step');
  // Past the fresh ones the others come back, never fewer than asked.
  assert.equal(lines.draw('cox', { conversation: 'a', named: false }).length, 5);
  // Another conversation remembers nothing of this one; a private step may draw the named ones.
  const everything = new Set<string>();
  for (let round = 0; round < 5; round += 1) for (const line of lines.draw('cox', { conversation: 'b', named: true })) everything.add(line);
  assert.ok(everything.has('Questa è la battuta 11.') && everything.has('Questa è la battuta 12.'));
  assert.deepEqual([lines.has('cox', false), lines.has('jim', true), lines.has('constructor', true)], [true, false, false]);
  assert.deepEqual(lines.draw('jim', { conversation: 'a', named: true }), []);
});

/** The theme Corsia (the GOD wears Dr. Cox) with fake packs and a fake archive. */
const LOADED = { official: ['arianna', 'coder', 'god', 'designer', 'finanze', 'reviewer'], user: [] };
function fakeLines(named: readonly string[], plain: readonly string[]): LinesSource & { asked: { character: string; conversation: string; named: boolean }[] } {
  const asked: { character: string; conversation: string; named: boolean }[] = [];
  return {
    asked,
    has: (character, withNamed) => character === 'cox' && (plain.length > 0 || (withNamed && named.length > 0)),
    draw: (character, options) => {
      asked.push({ character, ...options });
      return options.named ? [...plain, ...named] : [...plain];
    },
  };
}
const corsia = (extra: Partial<TailConfig> = {}): TailConfig => ({ personas: {}, appearance: { theme: 'corsia' }, home: HOME, paths: { data: root }, agentsNow: () => LOADED, ...extra });

test('linesPart: the lines drawn for the answer as their own piece, Interno; the block of the character then leaves its fixed catchphrases out', () => {
  const source = fakeLines(['Ascolta bene, Newbie.'], ['Sbagliato! Riprova.']);
  const config = corsia({ lines: source });
  const work = linesPart(config, 'god', 'L1', 'conv-1');
  assert.ok(work !== undefined);
  assert.deepEqual([work.label, work.source], ['L1', 'character:serie/cox#lines']);
  // An L0 step never reads them: the fixed catchphrases stay.
  assert.equal(linesPart(config, 'god', 'L0', 'conv-0'), undefined);
  assert.match(characterPart(config, 'god', 'L0', true)?.text ?? '', /Che vuoi, pivello\?/);
  assert.equal(work.text, seriesLinesBlock(['Sbagliato! Riprova.']));
  assert.match(work.text, /^<character_lines>\nReal lines of the character from the series, drawn by Arianna for this answer \(not written by the user\)[^\n]*Use at most one[^\n]*\n- Sbagliato! Riprova\.\n<\/character_lines>$/);
  const play = linesPart(config, 'god', 'L2', 'conv-1');
  assert.match(play?.text ?? '', /- Ascolta bene, Newbie\./);
  assert.deepEqual(source.asked, [
    { character: 'cox', conversation: 'conv-1', named: false },
    { character: 'cox', conversation: 'conv-1', named: true },
  ]);
  // With lines the fixed catchphrases stay out of the block; without the option (a call, a brief to the cloud) they stay.
  assert.doesNotMatch(characterPart(config, 'god', 'L2', true)?.text ?? '', /Che vuoi, pivello\?/);
  assert.match(characterPart(config, 'god', 'L2')?.text ?? '', /Che vuoi, pivello\?/);
  assert.doesNotMatch(tailParts(config, 'god', 'L1', { lines: true })[0]?.text ?? '', /Che vuoi, pivello\?/);
  assert.match(tailParts(config, 'god', 'L1')[0]?.text ?? '', /Che vuoi, pivello\?/);
});

test('linesPart: none without lines for the step, for an agent without a person of the series, or when the user’s personality or catchphrases win', () => {
  const onlyNamed = corsia({ lines: fakeLines(['Ascolta bene, Newbie.'], []) });
  assert.equal(linesPart(onlyNamed, 'god', 'L1', 'c'), undefined);
  assert.match(characterPart(onlyNamed, 'god', 'L1', true)?.text ?? '', /Che vuoi, pivello\?/, 'the fixed ones stay when nothing is drawn');
  const lines = fakeLines([], ['Sbagliato!']);
  assert.equal(linesPart(corsia({ lines }), 'designer', 'L2', 'c'), undefined);
  assert.equal(linesPart(corsia({ lines, appearance: { theme: 'base' } }), 'god', 'L2', 'c'), undefined);
  assert.equal(linesPart(corsia({ lines, personas: { god: { tone: 'caloroso', address: 'tu', traits: 'Gentile.' } } }), 'god', 'L2', 'c'), undefined);
  const ownQuotes = corsia({ lines, series: { cox: { quotes: ['Una mia.', 'Due mie.', 'Tre mie.'] } } });
  assert.equal(linesPart(ownQuotes, 'god', 'L2', 'c'), undefined);
  assert.match(characterPart(ownQuotes, 'god', 'L2', true)?.text ?? '', /- Una mia\./);
  // Without an archive configured: nothing, the fixed catchphrases stay.
  assert.equal(linesPart(corsia(), 'god', 'L2', 'c'), undefined);
});

test('the piece of the lines: the names of the series are no person for the second scanner there, as in the block of the character', () => {
  assert.equal(seriesLinesSource('cox'), 'character:serie/cox#lines');
  assert.ok(seriesNamesOfSource('character:serie/cox#lines')?.includes('J.D.'));
  assert.equal(seriesNamesOfSource('character:serie/nessuno#lines'), undefined);
  assert.equal(seriesNamesOfSource('character:serie/cox#own#lines'), undefined);
  const text = seriesLinesBlock(['Ascolta bene, J.D.']);
  assert.ok(fragmentNamesOf([{ value: text, label: 'L0', source: seriesLinesSource('cox') }], [])[0]?.includes('J.D.'));
  assert.equal(seriesLinesBlock([]), '');
  // The block option alone: no catchphrases.
  const cox = SERIES_PERSONAS.cox;
  assert.ok(cox !== undefined);
  assert.doesNotMatch(seriesPersonaBlock(cox, { withName: true, withTraits: true, lines: true }), /Lines of the character, examples/);
});
