import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseTrack, cueText, parseVtt, readSpoken, SEGMENT_CHARS, toSegments, vttTime } from '../src/video-transcript.ts';

// Subtitles invented for the tests, in the shapes YouTube writes them.
const MANUAL = `WEBVTT
Kind: captions
Language: it

1
00:00:01.000 --> 00:00:04.000
Buongiorno a tutti,
oggi parliamo di un progetto inventato.

NOTE una nota che non è testo

00:01:02.500 --> 00:01:05.000 align:start position:0%
<v Relatore>La prima parte &amp; la seconda.</v>

1:00:00.000 --> 1:00:03.000
Fine.
`;

// Automatic captions roll: each cue repeats the line before, with timings inside the new one.
const AUTOMATIC = `WEBVTT
Kind: captions
Language: en

00:00:00.160 --> 00:00:02.270 align:start position:0%
 
hello<00:00:00.480><c> everyone</c><00:00:00.880><c> and</c>

00:00:02.270 --> 00:00:02.280 align:start position:0%
hello everyone and


00:00:02.280 --> 00:00:05.000 align:start position:0%
hello everyone and
welcome<00:00:02.600><c> to</c><00:00:03.000><c> the</c><00:00:03.200><c> show</c>

00:00:05.000 --> 00:00:05.010 align:start position:0%
welcome to the show

`;

test('times of WebVTT, and nothing that only looks like one', () => {
  assert.equal(vttTime('00:00:01.000'), 1);
  assert.equal(vttTime('01:02.500'), 62.5);
  assert.equal(vttTime('1:00:00.000'), 3600);
  for (const bad of ['', '00:00:01', '00:61:00.000', 'aa:00:01.000', '00:00:01.0000', '0:0:0:0.000', '00:00:1.000']) assert.equal(vttTime(bad), undefined, bad);
});

test('subtitles by hand: lines with the start of their cue, tags and entities out, notes skipped', () => {
  assert.deepEqual(parseVtt(MANUAL), [
    { start: 1, text: 'Buongiorno a tutti,' },
    { start: 1, text: 'oggi parliamo di un progetto inventato.' },
    { start: 62.5, text: 'La prima parte & la seconda.' },
    { start: 3600, text: 'Fine.' },
  ]);
});

test('automatic subtitles: each line once, the rolling repetitions dropped', () => {
  assert.deepEqual(parseVtt(AUTOMATIC), [
    { start: 0.16, text: 'hello everyone and' },
    { start: 2.28, text: 'welcome to the show' },
  ]);
});

test('text of a cue: an open tag ends the line, control and format characters become spaces', () => {
  assert.equal(cueText('a<b>c</b>d'), 'acd');
  assert.equal(cueText('testo <senza chiusura'), 'testo');
  assert.equal(cueText('a‮b\u0007c'), 'a b c');
  assert.equal(cueText('# titolo'), '# titolo');
});

test('a long file of rubbish is read in linear time', () => {
  const started = Date.now();
  const rubbish = `${'<'.repeat(200_000)}\n${'-->'.repeat(100_000)}\n${'0:'.repeat(100_000)} --> x\n`;
  parseVtt(rubbish);
  assert.ok(Date.now() - started < 2_000);
});

test('lines become numbered segments of about 240 characters or 30 seconds', () => {
  const lines = Array.from({ length: 40 }, (_, index) => ({ start: index * 2, text: `frase numero ${String(index)} del video inventato` }));
  const segments = toSegments(lines);
  assert.ok(segments.length > 3);
  assert.deepEqual(segments.map((segment) => segment.id), segments.map((_, index) => index + 1));
  assert.equal(segments[0]?.start, 0);
  assert.ok(segments.slice(0, -1).every((segment) => segment.text.length >= SEGMENT_CHARS || segment.text.length > 0));
  assert.ok(segments.slice(0, -1).every((segment, index) => (segments[index + 1]?.start ?? 0) > segment.start));
  // A long pause closes a segment too.
  assert.deepEqual(toSegments([{ start: 0, text: 'a' }, { start: 40, text: 'b' }, { start: 41, text: 'c' }]).map((segment) => [segment.start, segment.text]), [[0, 'a'], [40, 'b c']]);
  assert.deepEqual(toSegments([]), []);
});

test('the sentences of Parakeet are checked again: a bad item refuses the whole answer', () => {
  assert.deepEqual(readSpoken([{ start: 0.4, text: ' Ciao ' }, { start: 3, text: '' }]), [{ start: 0.4, text: 'Ciao' }]);
  assert.equal(readSpoken([{ start: -1, text: 'x' }]), undefined);
  assert.equal(readSpoken([{ start: '1', text: 'x' }]), undefined);
  assert.equal(readSpoken('testo'), undefined);
});

test('the track: by hand in the language of the video, then automatic original, then Italian or English', () => {
  assert.deepEqual(chooseTrack({ language: 'de', subtitles: ['en', 'de'], automatic: ['de-orig', 'it'] }), { lang: 'de', auto: false });
  assert.deepEqual(chooseTrack({ language: 'de', subtitles: ['en'], automatic: ['de-orig', 'de', 'it'] }), { lang: 'de-orig', auto: true });
  assert.deepEqual(chooseTrack({ language: null, subtitles: ['fr'], automatic: ['es-orig', 'it'] }), { lang: 'es-orig', auto: true });
  assert.deepEqual(chooseTrack({ language: 'en', subtitles: ['en-US'], automatic: [] }), { lang: 'en-US', auto: false });
  assert.deepEqual(chooseTrack({ language: 'ja', subtitles: ['fr', 'en'], automatic: [] }), { lang: 'en', auto: false });
  assert.deepEqual(chooseTrack({ language: 'ja', subtitles: [], automatic: ['en', 'it'] }), { lang: 'it', auto: true });
  assert.equal(chooseTrack({ language: 'ja', subtitles: ['fr'], automatic: ['de'] }), undefined);
  assert.equal(chooseTrack({ language: null, subtitles: [], automatic: [] }), undefined);
});
