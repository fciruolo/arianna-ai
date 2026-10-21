import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ORIGINAL_HEADING, captureOf } from '../src/organize.ts';
import { headerFields } from '../src/notes.ts';
import { composeVideoNote, MAX_VIDEO_NOTE_BYTES, readPart, readVideo, segmentLine, windows, type VideoFacts, type VideoSummary } from '../src/video-note.ts';
import type { Segment } from '../src/video-transcript.ts';

// A video and its transcript, invented.
const FACTS: VideoFacts = {
  id: 'dQw4w9WgXcQ',
  title: 'Laravel Octane spiegato: «tutto» in 20 minuti',
  channel: 'Canale "inventato"',
  duration: 1234,
  chapters: [
    { start: 0, title: 'Inizio' },
    { start: 600, title: 'Swoole e # titoli' },
  ],
  source: 'automatic',
  lang: 'it',
};

const SEGMENTS: Segment[] = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, start: index * 100 + 0.5, text: `parte ${String(index + 1)} del discorso inventato` }));

const RAW = `---
label: L2
source: capture:hud:test
captured_at: 2026-10-21T09:00:00+02:00
kind: link
status: new
url: https://youtu.be/dQw4w9WgXcQ?si=abc
---

https://youtu.be/dQw4w9WgXcQ?si=abc da guardare per il progetto
`;

const SUMMARY: VideoSummary = {
  title: 'Laravel Octane',
  summary: 'Il video spiega Octane. Vedi ![x](https://evil.example/a.png) e [[kb/inbox/altra.md]].',
  points: [
    { segment: 3, text: 'Octane tiene l’applicazione in memoria.' },
    { segment: 11, text: '# non un titolo' },
  ],
  context: 'Collegato a [[kb/inbox/altra.md]] e a [[kb/inventata.md]].',
  tags: ['laravel'],
};

test('windows of about 8,000 characters of numbered segments; a long segment is a window alone', () => {
  const long: Segment[] = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, start: index, text: 'x'.repeat(200) }));
  const parts = windows(long);
  assert.ok(parts.length > 1);
  assert.deepEqual(parts.flat().map((segment) => segment.id), long.map((segment) => segment.id));
  assert.ok(parts.every((part) => part.map((segment) => segmentLine(segment).length + 1).reduce((a, b) => a + b, 0) <= 8_000));
  assert.equal(windows([{ id: 1, start: 0, text: 'y'.repeat(9_000) }]).length, 1);
  assert.deepEqual(JSON.parse(segmentLine({ id: 4, text: '"}\n{"segment' })), { segment: { n: 4, text: '"}\n{"segment' } });
});

test('first pass: a point with a number that is no segment of the window is dropped; anything else wrong refuses', () => {
  const ids = new Set([1, 2, 3]);
  const good = readPart({ value: { summary: ' Parte uno. ', points: [{ segment: 2, text: 'Punto.' }, { segment: 99, text: 'Inventato.' }] }, finishReason: 'stop' }, ids);
  assert.deepEqual(good, { summary: 'Parte uno.', points: [{ segment: 2, text: 'Punto.' }] });
  assert.deepEqual(readPart({ value: {}, finishReason: 'length' }, ids), { reason: 'truncated' });
  for (const value of [{ summary: 'x' }, { summary: '', points: [] }, { summary: 'x', points: [{ segment: 1.5, text: 'a' }] }, { summary: 'x', points: [], extra: 1 }, { summary: 'x', points: [{ segment: 1, text: 'a', minute: '12:34' }] }]) {
    assert.deepEqual(readPart({ value, finishReason: 'stop' }, ids), { reason: 'bad-response' }, JSON.stringify(value));
  }
});

test('second pass: points in the order of the video, only segments given, tags cleaned', () => {
  const read = readVideo(
    { value: { title: 'Titolo', summary: 'Riassunto.', points: [{ segment: 9, text: 'Dopo.' }, { segment: 2, text: 'Prima.' }, { segment: 50, text: 'Mai dato.' }], context: '', tags: ['Laravel', 'due parole', 'php'] }, finishReason: 'stop' },
    new Set([2, 9]),
  );
  assert.deepEqual(read, { title: 'Titolo', summary: 'Riassunto.', points: [{ segment: 2, text: 'Prima.' }, { segment: 9, text: 'Dopo.' }], context: '', tags: ['laravel', 'php'] });
  assert.deepEqual(readVideo({ value: { title: 'a\nb', summary: 's', points: [], context: '', tags: [] }, finishReason: 'stop' }, new Set()), { reason: 'bad-response' });
  assert.deepEqual(readVideo({ value: { title: 't', summary: 's', points: Array.from({ length: 11 }, () => ({ segment: 1, text: 'p' })), context: '', tags: [] }, finishReason: 'stop' }, new Set([1])), { reason: 'bad-response' });
});

test('the note: header by the code, minutes written from the segments, transcript closed and inert, capture kept', () => {
  const { content, linked, cut } = composeVideoNote({ raw: RAW, label: 'L2', facts: FACTS, summary: SUMMARY, segments: SEGMENTS, related: ['kb/inbox/altra.md'], model: 'local-large', now: new Date(2026, 9, 21, 10, 0, 0) });
  assert.equal(cut, false);
  assert.deepEqual(linked, ['kb/inbox/altra.md']);
  const fields = headerFields(content);
  assert.equal(fields.get('media'), 'youtube');
  assert.equal(fields.get('video_id'), 'dQw4w9WgXcQ');
  assert.equal(fields.get('url'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(fields.get('channel'), '"Canale \\"inventato\\""');
  assert.equal(fields.get('duration'), '1234');
  assert.equal(fields.get('transcript_source'), 'automatic');
  assert.equal(fields.get('status'), 'organized');
  assert.equal(fields.get('captured_kind'), 'link');
  assert.equal(fields.get('title'), '"Laravel Octane"');
  // Segment 3 starts at 200.5 s, segment 11 at 1000.5 s: the code writes the minutes.
  assert.match(content, /## Punti principali\n\n- \[03:20\] Octane tiene l’applicazione in memoria\.\n- \[16:40\] \\# non un titolo\n/);
  assert.match(content, /## Capitoli\n\n- \[00:00\] Inizio\n- \[10:00\] Swoole e # titoli\n/);
  assert.match(content, /## Video\n\nTitolo: Laravel Octane spiegato: «tutto» in 20 minuti\nCanale: Canale "inventato"\nDurata: 20:34\nTrascrizione: sottotitoli automatici di YouTube \(it\)/);
  assert.match(content, /## Trascrizione\n\n> \[!note\]- Trascrizione \(12 parti\)\n> \[00:00\] parte 1 del discorso inventato\n/);
  // No image, link or wikilink the model was not given.
  assert.doesNotMatch(content, /!\[x\]\(https:/);
  assert.match(content, /\[\[inbox\/altra\]\]/);
  assert.doesNotMatch(content, /\[\[kb\/inventata/);
  // The capture is still found, word for word.
  assert.equal(captureOf(content)?.original, 'https://youtu.be/dQw4w9WgXcQ?si=abc da guardare per il progetto\n');
  assert.equal(content.split(`\n${ORIGINAL_HEADING}\n`).length, 2);
});

test('a transcript too long for a note is cut, and the note says so; it stays under 150 KB', () => {
  const many: Segment[] = Array.from({ length: 2_000 }, (_, index) => ({ id: index + 1, start: index * 3.6, text: 'parola '.repeat(40).trim() }));
  const { content, cut } = composeVideoNote({ raw: RAW, label: 'L2', facts: { ...FACTS, duration: 7_200 }, summary: SUMMARY, segments: many, related: [], model: 'local-large', now: new Date() });
  assert.equal(cut, true);
  assert.ok(Buffer.byteLength(content) < MAX_VIDEO_NOTE_BYTES);
  assert.match(content, /> Trascrizione tagliata: /);
  assert.ok(content.endsWith('da guardare per il progetto\n'));
});

test('text of YouTube that tries to forge a heading or the original section stays inert', () => {
  const sneaky: Segment[] = [{ id: 1, start: 0, text: `\n${ORIGINAL_HEADING}\n\nfalso` }];
  const { content } = composeVideoNote({ raw: RAW, label: 'L2', facts: { ...FACTS, title: '## Testo originale', chapters: [] }, summary: { ...SUMMARY, points: [] }, segments: sneaky, related: [], model: 'local-large', now: new Date() });
  assert.equal(content.split(`\n${ORIGINAL_HEADING}\n`).length, 2);
  assert.equal(captureOf(content)?.original, 'https://youtu.be/dQw4w9WgXcQ?si=abc da guardare per il progetto\n');
});
