import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canFetch } from '../src/lib/thoughts.ts';
import { canSummarizeVideo, clock, plainLine, seconds, timedLine, videoAt, videoFacts, videoJobText, videoSections, youtubeVideoId } from '../src/lib/video.ts';

const ID = 'dQw4w9WgXcQ';

test('the video of a link, as the core reads it; a playlist or another site is not one (D-273)', () => {
  for (const form of [`https://www.youtube.com/watch?v=${ID}&t=4`, `https://youtu.be/${ID}?si=x`, `https://m.youtube.com/shorts/${ID}`, `https://www.youtube.com/live/${ID}`]) assert.equal(youtubeVideoId(form), ID, form);
  for (const other of ['https://www.youtube.com/playlist?list=PL1', `https://youtube.com.evil.example/watch?v=${ID}`, 'https://x.com/a/status/1', `https://youtu.be/${ID}/x`]) assert.equal(youtubeVideoId(other), undefined, other);
});

test('«Riassumi il video» for a video not summarized yet; never «Scarica e riassumi» for a video', () => {
  const video = `https://youtu.be/${ID}`;
  assert.equal(canSummarizeVideo({ url: video, video: null }), true);
  assert.equal(canSummarizeVideo({ url: video }), true);
  assert.equal(canSummarizeVideo({ url: video, video: { id: ID, channel: null, duration: 60, transcriptSource: 'audio' } }), false);
  assert.equal(canSummarizeVideo({ url: 'https://x.com/a/status/1', video: null }), false);
  assert.equal(canSummarizeVideo(null), false);
  assert.equal(canFetch({ url: video, fetchedAt: null }), false);
  assert.equal(canFetch({ url: 'https://example.org/a', fetchedAt: null }), true);
});

test('minutes: written and read back, and the second of the video they open', () => {
  assert.equal(clock(754), '12:34');
  assert.equal(clock(3723), '1:02:03');
  assert.equal(seconds('12:34'), 754);
  assert.equal(seconds('1:02:03'), 3723);
  for (const bad of ['12:60', '1:2:3', 'ab:cd', '123:00']) assert.equal(seconds(bad), undefined, bad);
  assert.equal(videoAt(ID, 754.9), `https://www.youtube.com/watch?v=${ID}&t=754s`);
  assert.deepEqual(timedLine('- [12:34] Un punto.', '- '), { at: 754, clock: '12:34', text: 'Un punto.' });
  assert.equal(timedLine('- [non è un minuto] x', '- '), undefined);
  assert.equal(timedLine('> [12:34] x', '- '), undefined);
});

const BODY = `## Riassunto

Il video presenta un progetto inventato.

## Punti principali

- [00:01] Il progetto è presentato.
- [16:40] \\# non un titolo

## Capitoli

- [00:00] Inizio

## Contesto

Nessun collegamento.

## Video

Titolo: Video inventato

## Trascrizione

> [!note]- Trascrizione (2 parti)
> [00:01] Buongiorno a tutti, https[://]example.org.
> [02:00] Seconda parte.
> Trascrizione tagliata: il video è più lungo di quanto una nota tiene.

## Testo originale

https://youtu.be/${ID} da vedere
`;

test('the note of a video in its sections: points and chapters with minutes, the transcript apart', () => {
  const sections = videoSections(BODY);
  assert.deepEqual(
    sections.map((section) => (section.kind === 'text' ? section.heading : section.kind === 'timed' ? section.heading : 'transcript')),
    ['Riassunto', 'Punti principali', 'Capitoli', 'Contesto', 'Video', 'transcript', 'Testo originale'],
  );
  const points = sections[1];
  assert.ok(points?.kind === 'timed');
  assert.deepEqual(points.lines.map((line) => [line.at, plainLine(line.text)]), [[1, 'Il progetto è presentato.'], [1000, '# non un titolo']]);
  const transcript = sections[5];
  assert.ok(transcript?.kind === 'transcript');
  assert.equal(transcript.lines.length, 2);
  assert.equal(plainLine(transcript.lines[0]?.text ?? ''), 'Buongiorno a tutti, https://example.org.');
  assert.match(transcript.note ?? '', /tagliata/);
});

test('the line of the panel: facts of the video and the state of its job', () => {
  assert.equal(videoFacts({ id: ID, channel: 'Canale finto', duration: 754, transcriptSource: 'automatic' }), '13 min · Canale finto · dai sottotitoli automatici');
  assert.equal(videoFacts({ id: ID, channel: null, duration: 4000, transcriptSource: null }), '1:06:40');
  assert.equal(videoJobText(null), null);
  assert.equal(videoJobText({ state: 'done' }), null);
  assert.match(videoJobText({ state: 'queued' }) ?? '', /In coda/);
  assert.match(videoJobText({ state: 'running', stage: 'transcribing' }) ?? '', /senza rete/);
  assert.equal(videoJobText({ state: 'failed', reason: 'too-long', reasonText: 'il video dura più di 2 ore' }), 'Video non riassunto: il video dura più di 2 ore.');
});
