import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clock, isYoutubeVideo, normalizeVideoUrl, videoAt, youtubeVideoId } from '../src/video-url.ts';

const ID = 'dQw4w9WgXcQ';
const NORMAL = `https://www.youtube.com/watch?v=${ID}`;

test('every form of a YouTube video becomes the same address, without t, si or list (D-273)', () => {
  for (const form of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s`,
    `http://m.youtube.com/watch?feature=share&v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&list=PL1234567890&index=3`,
    `https://youtu.be/${ID}?si=abcdef&t=10`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?si=x`,
    `https://www.youtube.com/embed/${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `  https://WWW.YOUTUBE.COM/watch?v=${ID}  `,
  ]) {
    assert.equal(normalizeVideoUrl(form), NORMAL, form);
    assert.equal(isYoutubeVideo(form), true, form);
  }
});

test('playlists, channels, other pages and lookalike sites are no video', () => {
  for (const other of [
    'https://www.youtube.com/playlist?list=PL1234567890',
    'https://www.youtube.com/@canale',
    'https://www.youtube.com/channel/UC1234567890',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    `https://www.youtube.com/watch?v=${ID}&v=${ID}`,
    `https://www.youtube.com/watch/extra?v=${ID}`,
    `https://youtu.be/${ID}/extra`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://user:pass@www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:8443/watch?v=${ID}`,
    `ftp://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/shorts/${ID}x`,
    'non è un indirizzo',
  ]) {
    assert.equal(youtubeVideoId(other), undefined, other);
    assert.equal(isYoutubeVideo(other), false, other);
  }
});

test('a minute is written by the code: mm:ss under one hour, h:mm:ss above, and its address', () => {
  assert.equal(clock(0), '00:00');
  assert.equal(clock(754.9), '12:34');
  assert.equal(clock(3600), '1:00:00');
  assert.equal(clock(7199), '1:59:59');
  assert.equal(clock(-5), '00:00');
  assert.equal(videoAt(ID, 754.9), `${NORMAL}&t=754s`);
  assert.throws(() => videoAt('../x', 1));
});
