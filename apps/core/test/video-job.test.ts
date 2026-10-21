import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { DEAD_PROXY } from '../src/child-env.ts';
import { fetchStepEnv, findTool, isVideoFailure, readMeta, removeLeftovers, runVoiceStep, transcribeEnv, VIDEO_FAILURE_TEXT, VIDEO_FAILURES } from '../src/video-job.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', `video-job-${randomUUID()}`);
mkdirSync(scratch, { recursive: true });
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const PROXY = `http://arianna:${'a'.repeat(32)}@127.0.0.1:5555`;
const PARENT = { PATH: '/usr/bin:/bin', HOME: '/somewhere', PGPASSWORD: 'fake-db-password', SOPS_AGE_KEY: 'fake-age-key', LANG: 'it_IT.UTF-8' };

test('every reason has its sentence in Italian; codes only', () => {
  for (const failure of VIDEO_FAILURES) assert.ok(VIDEO_FAILURE_TEXT[failure].length > 5, failure);
  assert.equal(isVideoFailure('too-long'), true);
  assert.equal(isVideoFailure('Titolo del video'), false);
  assert.match(VIDEO_FAILURE_TEXT['download-failed'], /forse yt-dlp va aggiornato/);
  assert.match(VIDEO_FAILURE_TEXT['needs-deno'], /serve Deno per l’audio/);
});

test('a step of yt-dlp: the proxy of the job, HOME of the job, nothing of the core', () => {
  const env = fetchStepEnv(PARENT, 'apps/voice/src', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', proxy: PROXY, folder: '/data/voice/tmp/video/job-1', deno: '/opt/homebrew/bin/deno', lang: 'it', auto: true });
  assert.equal(env.HOME, join('/data/voice/tmp/video/job-1', 'home'));
  assert.equal(env.DENO_DIR, join('/data/voice/tmp/video/job-1', 'home', 'deno'));
  assert.equal(env.DENO_NO_UPDATE_CHECK, '1');
  assert.equal(env.HTTPS_PROXY, PROXY);
  assert.equal(env.ARIANNA_VIDEO_SUB_AUTO, '1');
  assert.equal(env.ARIANNA_DENO, '/opt/homebrew/bin/deno');
  assert.equal(env.NO_PROXY, undefined);
  assert.equal(env.PGPASSWORD, undefined);
  assert.equal(env.SOPS_AGE_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(env), /somewhere/);
});

test('the transcription has no network: the dead proxy and Hugging Face offline, never the proxy of the job', () => {
  const env = transcribeEnv(PARENT, 'apps/voice/src', { folder: '/data/voice/tmp/video/job-1', audio: 'audio.m4a', ffmpeg: '/opt/homebrew/bin/ffmpeg', model: '/data/models/parakeet', maxSeconds: 7200 });
  assert.equal(env.HTTPS_PROXY, DEAD_PROXY);
  assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.ARIANNA_VIDEO_MAX_SECONDS, '7200');
  assert.equal(env.ARIANNA_VIDEO_PROXY, undefined);
  assert.equal(env.PGPASSWORD, undefined);
});

test('the metadata of apps/voice are checked again: the id must be the one asked, limits kept', () => {
  const meta = readMeta({ id: 'dQw4w9WgXcQ', title: 'Titolo', channel: 'Canale', duration: 754, live: false, language: 'it', chapters: [{ start: 0, title: 'Inizio' }, { start: -1, title: 'no' }, 'x'], subtitles: ['it', 'bad lang'], automatic: ['it-orig'] }, 'dQw4w9WgXcQ');
  assert.deepEqual(meta, {
    facts: { id: 'dQw4w9WgXcQ', title: 'Titolo', channel: 'Canale', duration: 754, chapters: [{ start: 0, title: 'Inizio' }] },
    live: false,
    language: 'it',
    subtitles: ['it'],
    automatic: ['it-orig'],
  });
  assert.equal(readMeta({ id: 'other_video' }, 'dQw4w9WgXcQ'), undefined);
  assert.equal(readMeta('x', 'dQw4w9WgXcQ'), undefined);
  assert.equal(readMeta({ id: 'dQw4w9WgXcQ' }, 'dQw4w9WgXcQ')?.facts.duration, -1);
});

function fakePython(name: string, body: string): string {
  const file = join(scratch, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

test('a step answers with its last JSON line; stderr is dropped, a crash or rubbish is a code', async () => {
  const signal = new AbortController().signal;
  const good = fakePython('good.sh', 'echo "Titolo segreto" 1>&2\necho \'{"ok": true, "file": "subs.it.vtt"}\'');
  assert.deepEqual(await runVoiceStep(good, scratch, 'subs', {}, signal, 5_000), { ok: true, file: 'subs.it.vtt' });
  const failed = fakePython('failed.sh', 'echo \'{"ok": false, "error": "unavailable"}\'');
  assert.deepEqual(await runVoiceStep(failed, scratch, 'meta', {}, signal, 5_000), { ok: false, error: 'unavailable' });
  const rubbish = fakePython('rubbish.sh', 'echo "not json"\nexit 3');
  assert.deepEqual(await runVoiceStep(rubbish, scratch, 'meta', {}, signal, 5_000), { ok: false, error: 'bad-answer' });
  assert.deepEqual(await runVoiceStep(join(scratch, 'missing'), scratch, 'meta', {}, signal, 5_000), { ok: false, error: 'not-installed' });
  const slow = fakePython('slow.sh', 'sleep 5');
  assert.deepEqual(await runVoiceStep(slow, scratch, 'meta', {}, signal, 100), { ok: false, error: 'timeout' });
  const stop = new AbortController();
  const pending = runVoiceStep(slow, scratch, 'meta', {}, stop.signal, 5_000);
  stop.abort();
  assert.deepEqual(await pending, { ok: false, error: 'interrupted' });
});

test('tools are found in PATH by name, executable files only', () => {
  const bin = join(scratch, 'bin');
  mkdirSync(bin, { recursive: true });
  const deno = join(bin, 'deno-fake');
  writeFileSync(deno, '#!/bin/sh\n');
  chmodSync(deno, 0o755);
  writeFileSync(join(bin, 'not-executable'), '');
  assert.equal(findTool('deno-fake', bin), deno);
  assert.equal(findTool('not-executable', bin), undefined);
  assert.equal(findTool('no-such-tool-anywhere', bin), undefined);
});

test('leftovers of a crash go at start: only the folders of jobs, never a link', () => {
  const tmp = join(scratch, 'video');
  mkdirSync(join(tmp, 'job-1-abc', 'home'), { recursive: true });
  writeFileSync(join(tmp, 'job-1-abc', 'audio.m4a'), 'x');
  mkdirSync(join(tmp, 'other'));
  const outside = join(scratch, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'x');
  symlinkSync(outside, join(tmp, 'job-2-link'));
  assert.equal(removeLeftovers(tmp), 1);
  assert.equal(existsSync(join(tmp, 'job-1-abc')), false);
  assert.equal(existsSync(join(tmp, 'other')), true);
  assert.equal(existsSync(join(outside, 'keep')), true);
  assert.equal(removeLeftovers(join(scratch, 'none')), 0);
});
