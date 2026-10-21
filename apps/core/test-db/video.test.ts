// «Riassumi il video» (D-273, tappa A): the gateway row, the proxy, the steps
// of apps/voice, the two passes of the model, the note and the events. yt-dlp,
// Deno, ffmpeg, Parakeet and the model are fakes: no network, no oMLX.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { captureNote } from '../src/capture.ts';
import { headerFields } from '../src/notes.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { PART_PROMPT } from '../src/video-note.ts';
import { createVideoWorker, summarizeVideoNote, VIDEO_QUEUE, type FetchStep, type FetchStepEnv, type StepAnswer, type TranscribeEnv, type VideoEnv, type VideoRunner } from '../src/video-job.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const scratch = join(resolveHome({}), 'data', 'test-tmp', `video-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const ID = 'dQw4w9WgXcQ';
const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Buongiorno, oggi parliamo di un progetto inventato.

00:02:00.000 --> 00:02:04.000
Ecco la seconda parte del discorso.
`;

function setup(url = `https://youtu.be/${ID}?si=abc`) {
  const home = join(scratch, randomUUID());
  mkdirSync(join(home, 'kb', 'inbox'), { recursive: true });
  const note = captureNote({ home, rules: RULES, text: `${url} da vedere`, kind: 'link', url, source: { channel: 'hud', id: 'test' }, now: new Date(2026, 9, 21, 9, 0, 0) });
  return { home, path: note.path, video: join(home, 'data', 'voice', 'tmp', 'video') };
}

interface Calls {
  fetch: { step: FetchStep; env: FetchStepEnv }[];
  transcribe: TranscribeEnv[];
}

interface Script {
  meta?: StepAnswer;
  subs?: 'none' | 'file' | StepAnswer;
  audio?: StepAnswer | 'file';
  transcribe?: StepAnswer;
}

function fakeRunner(calls: Calls, script: Script = {}): VideoRunner {
  return {
    fetch(step, env) {
      calls.fetch.push({ step, env });
      if (step === 'meta') {
        return Promise.resolve(script.meta ?? { ok: true, meta: { id: ID, title: 'Video inventato', channel: 'Canale finto', duration: 754, live: false, language: 'it', chapters: [{ start: 0, title: 'Inizio' }], subtitles: ['it'], automatic: [] } });
      }
      if (step === 'subs') {
        if (script.subs === 'none') return Promise.resolve({ ok: false, error: 'no-subtitles' });
        if (script.subs !== undefined && script.subs !== 'file') return Promise.resolve(script.subs);
        writeFileSync(join(env.folder, 'subs.it.vtt'), VTT);
        return Promise.resolve({ ok: true, file: 'subs.it.vtt' });
      }
      if (script.audio !== undefined && script.audio !== 'file') return Promise.resolve(script.audio);
      writeFileSync(join(env.folder, 'audio.m4a'), 'fake audio');
      return Promise.resolve({ ok: true, file: 'audio.m4a', bytes: 10 });
    },
    transcribe(env) {
      calls.transcribe.push(env);
      // The audio is still there while it is heard.
      assert.equal(existsSync(join(env.folder, env.audio)), true);
      return Promise.resolve(script.transcribe ?? { ok: true, segments: [{ start: 0.5, text: 'Frase sentita dal Mac.' }, { start: 65, text: 'Seconda frase.' }] });
    },
  };
}

function fakeModel(requests: ChatRequest[]): LocalModel {
  return {
    chat(request) {
      requests.push(request);
      const part = request.messages[0]?.content === PART_PROMPT;
      const segment = (JSON.parse(String(request.messages[1]?.content).split('\n').find((line) => line.includes('"segment"') || line.includes('"part"')) ?? '{}') as { segment?: { n: number } }).segment?.n ?? 1;
      const value = part
        ? { summary: 'Una parte del video inventato.', points: [{ segment, text: 'Si parla del progetto.' }] }
        : { title: 'Progetto inventato', summary: 'Il video presenta un progetto inventato.', points: [{ segment: 1, text: 'Il progetto è presentato.' }, { segment: 77, text: 'Minuto inventato.' }], context: '', tags: ['progetto'] };
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

function env(home: string, runner: VideoRunner, requests: ChatRequest[], tools: Partial<VideoEnv['tools']> = {}): VideoEnv {
  return {
    sql: db().sql,
    home,
    rules: RULES,
    kb: createKb({ home, rules: RULES }),
    model: () => fakeModel(requests),
    scratch: join(home, 'data', 'voice', 'tmp', 'video'),
    tools: { runner, installed: () => true, deno: () => undefined, ffmpeg: () => '/fake/ffmpeg', stt: () => '/fake/parakeet', ...tools },
  };
}

async function logRows(): Promise<{ target: string; decision: string; summary: string | null }[]> {
  return db().sql`SELECT target, decision, summary FROM gateway_log WHERE target_kind = 'link' ORDER BY id`;
}

test('with subtitles: one link-video row, the proxy of the job, the note with its minutes, nothing left on disk', async () => {
  const { home, path, video } = setup();
  const calls: Calls = { fetch: [], transcribe: [] };
  const requests: ChatRequest[] = [];
  const before = (await logRows()).length;
  const outcome = await summarizeVideoNote(env(home, fakeRunner(calls), requests), path, '1', new AbortController().signal);
  assert.deepEqual(outcome, { ok: true, source: 'subtitles', minutes: 13 });
  const rows = (await logRows()).slice(before);
  assert.deepEqual(rows, [{ target: 'link-video', decision: 'allow', summary: null }]);
  assert.deepEqual(calls.fetch.map((call) => call.step), ['meta', 'subs']);
  for (const call of calls.fetch) {
    assert.equal(call.env.url, `https://www.youtube.com/watch?v=${ID}`);
    assert.match(call.env.proxy, /^http:\/\/arianna:[^@]+@127\.0\.0\.1:\d+$/);
    assert.equal(call.env.deno, undefined);
  }
  const subs = calls.fetch[1];
  assert.ok(subs !== undefined);
  assert.equal(subs.env.lang, 'it');
  assert.equal(subs.env.auto, false);
  assert.deepEqual(calls.transcribe, []);
  // Two passes of the model, both through the gateway towards the local executor.
  assert.equal(requests.length, 2);
  const note = readFileSync(join(home, path), 'utf8');
  const fields = headerFields(note);
  assert.equal(fields.get('media'), 'youtube');
  assert.equal(fields.get('video_id'), ID);
  assert.equal(fields.get('transcript_source'), 'subtitles');
  // Segment 1 starts at 1 s: the code wrote the minute; segment 77 does not exist and its point is gone.
  assert.match(note, /## Punti principali\n\n- \[00:01\] Il progetto è presentato\.\n\n/);
  assert.doesNotMatch(note, /Minuto inventato/);
  assert.match(note, /> \[02:00\] Ecco la seconda parte del discorso\./);
  assert.deepEqual(readdirSync(video), []);
  const [changes] = await db().sql<{ count: string }[]>`SELECT count(*)::text AS count FROM label_changes`;
  assert.equal(changes?.count, '0');
  // Already the note of a video: nothing leaves again.
  assert.deepEqual(await summarizeVideoNote(env(home, fakeRunner(calls), requests), path, '2', new AbortController().signal), { ok: false, reason: 'done' });
  assert.equal(calls.fetch.length, 2);
});

test('without subtitles and without Deno: «serve Deno per l’audio», no audio asked', async () => {
  const { home, path, video } = setup();
  const calls: Calls = { fetch: [], transcribe: [] };
  const outcome = await summarizeVideoNote(env(home, fakeRunner(calls, { subs: 'none' }), []), path, '3', new AbortController().signal);
  assert.deepEqual(outcome, { ok: false, reason: 'needs-deno' });
  assert.deepEqual(calls.fetch.map((call) => call.step), ['meta', 'subs']);
  assert.deepEqual(readdirSync(video), []);
  assert.equal(headerFields(readFileSync(join(home, path), 'utf8')).get('status'), 'new');
});

test('without any subtitles: the audio with Deno, heard without the proxy, deleted afterwards', async () => {
  const { home, path, video } = setup();
  const calls: Calls = { fetch: [], transcribe: [] };
  const meta: StepAnswer = { ok: true, meta: { id: ID, title: 'Senza sottotitoli', channel: null, duration: 120, live: false, language: null, chapters: [], subtitles: [], automatic: [] } };
  const outcome = await summarizeVideoNote(env(home, fakeRunner(calls, { meta }), [], { deno: () => '/fake/deno' }), path, '4', new AbortController().signal);
  assert.deepEqual(outcome, { ok: true, source: 'audio', minutes: 2 });
  assert.deepEqual(calls.fetch.map((call) => call.step), ['meta', 'audio']);
  const audio = calls.fetch[1];
  assert.ok(audio !== undefined);
  assert.equal(audio.env.maxAudio, 300 * 1024 * 1024);
  assert.equal(audio.env.deno, '/fake/deno');
  assert.deepEqual(calls.transcribe.map((call) => ({ audio: call.audio, ffmpeg: call.ffmpeg, model: call.model, maxSeconds: call.maxSeconds })), [{ audio: 'audio.m4a', ffmpeg: '/fake/ffmpeg', model: '/fake/parakeet', maxSeconds: 7200 }]);
  assert.deepEqual(readdirSync(video), []);
  const note = readFileSync(join(home, path), 'utf8');
  assert.equal(headerFields(note).get('transcript_source'), 'audio');
  assert.match(note, /> \[01:05\] Seconda frase\./);
});

test('refused before any download: a live, a video over 2 hours, a failure of yt-dlp; none is tried again', async () => {
  for (const [meta, reason] of [
    [{ ok: true, meta: { id: ID, duration: 7_300, live: false, subtitles: ['it'], automatic: [] } }, 'too-long'],
    [{ ok: true, meta: { id: ID, duration: 100, live: true, subtitles: ['it'], automatic: [] } }, 'live'],
    [{ ok: true, meta: { id: 'otherVideo1', duration: 100, live: false, subtitles: [], automatic: [] } }, 'download-failed'],
    [{ ok: false, error: 'download-failed' }, 'download-failed'],
    [{ ok: false, error: 'unavailable' }, 'unavailable'],
  ] as const) {
    const { home, path, video } = setup();
    const calls: Calls = { fetch: [], transcribe: [] };
    assert.deepEqual(await summarizeVideoNote(env(home, fakeRunner(calls, { meta }), []), path, '5', new AbortController().signal), { ok: false, reason }, reason);
    assert.deepEqual(calls.fetch.map((call) => call.step), ['meta']);
    assert.deepEqual(readdirSync(video), []);
  }
});

test('a failure of the subtitles other than «none» ends the job with its reason: no audio', async () => {
  const { home, path, video } = setup();
  const calls: Calls = { fetch: [], transcribe: [] };
  const outcome = await summarizeVideoNote(env(home, fakeRunner(calls, { subs: { ok: false, error: 'bot-check' } }), [], { deno: () => '/fake/deno' }), path, '7', new AbortController().signal);
  assert.deepEqual(outcome, { ok: false, reason: 'bot-check' });
  assert.deepEqual(calls.fetch.map((call) => call.step), ['meta', 'subs']);
  assert.deepEqual(readdirSync(video), []);
});

test('a note above Privato is never sent; a thought too long for the summary is left as it was', async () => {
  const rules = parseLabelRules('[[folder]]\npath = "kb/inbox"\nlabel = "L3"\n');
  const { home, path } = setup();
  const calls: Calls = { fetch: [], transcribe: [] };
  const before = (await logRows()).length;
  assert.deepEqual(await summarizeVideoNote({ ...env(home, fakeRunner(calls), []), rules }, path, '8', new AbortController().signal), { ok: false, reason: 'above-clearance' });
  assert.equal((await logRows()).length, before);
  assert.deepEqual(calls.fetch, []);

  const long = setup(`https://youtu.be/${ID}`);
  const file = join(long.home, long.path);
  writeFileSync(file, `${readFileSync(file, 'utf8')}${'parola '.repeat(27_000)}\n`);
  const raw = readFileSync(file, 'utf8');
  assert.deepEqual(await summarizeVideoNote(env(long.home, fakeRunner(calls), []), long.path, '9', new AbortController().signal), { ok: false, reason: 'note-too-large' });
  assert.equal(readFileSync(file, 'utf8'), raw);
});

test('a note that is no video is never sent; nothing in gateway_log', async () => {
  const { home, path } = setup('https://www.youtube.com/playlist?list=PL1234567890');
  const calls: Calls = { fetch: [], transcribe: [] };
  const before = (await logRows()).length;
  assert.deepEqual(await summarizeVideoNote(env(home, fakeRunner(calls), []), path, '6', new AbortController().signal), { ok: false, reason: 'not-a-video' });
  assert.equal((await logRows()).length, before);
  assert.deepEqual(calls.fetch, []);
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('the worker: one job per note, events with codes only, the failure kept for the chat', async () => {
  const { sql } = db();
  const { home, path } = setup();
  const calls: Calls = { fetch: [], transcribe: [] };
  const archived: string[] = [];
  const worker = createVideoWorker({
    ...env(home, fakeRunner(calls), []),
    busy: () => Promise.resolve(false),
    pollMs: 20,
    archive: (_tx, item) => {
      archived.push(item);
      return Promise.resolve(true);
    },
  });
  try {
    await worker.start();
    assert.equal(await worker.enqueue(path), true);
    await waitFor(async () => (await sql`SELECT 1 FROM events WHERE kind = 'note.video_fetched'`).length === 1);
    assert.deepEqual(await worker.state(path), { state: 'done' });
    const [event] = await sql<{ label: string; payload: Record<string, unknown> }[]>`SELECT label, payload FROM events WHERE kind = 'note.video_fetched'`;
    assert.ok(event !== undefined);
    assert.equal(event.label, 'L0');
    assert.deepEqual(Object.keys(event.payload).sort(), ['jobId', 'minutes', 'source']);
    assert.doesNotMatch(JSON.stringify(event.payload), /youtube|inventato|inbox/);
    assert.deepEqual(archived, [path]);

    // A video over 2 hours: failed at once, with its code.
    const long = setup();
    const longWorker = createVideoWorker({ ...env(long.home, fakeRunner(calls, { meta: { ok: true, meta: { id: ID, duration: 9_000, live: false, subtitles: [], automatic: [] } } }), []), busy: () => Promise.resolve(false), pollMs: 20 });
    await worker.stop();
    await longWorker.start();
    try {
      await longWorker.enqueue(long.path);
      await waitFor(async () => (await sql`SELECT 1 FROM events WHERE kind = 'note.video_failed'`).length === 1);
      assert.deepEqual(await longWorker.state(long.path), { state: 'failed', reason: 'too-long' });
      const [failed] = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'note.video_failed'`;
      assert.equal(failed?.payload.reason, 'too-long');
      const [job] = await sql<{ attempts: number }[]>`SELECT attempts FROM jobs WHERE queue = ${VIDEO_QUEUE} AND key = ${`note-video:${long.path}`}`;
      assert.equal(job?.attempts, 1);
    } finally {
      await longWorker.stop();
    }
  } finally {
    await worker.stop();
  }
});

test('a call takes the machine: the video waits in the queue and starts after it', async () => {
  const { sql } = db();
  const { home, path } = setup();
  const calls: Calls = { fetch: [], transcribe: [] };
  let busy = true;
  const worker = createVideoWorker({ ...env(home, fakeRunner(calls), []), busy: () => Promise.resolve(busy), pollMs: 20, watchMs: 10 });
  try {
    await worker.start();
    await worker.enqueue(path);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(calls.fetch, []);
    assert.deepEqual(await worker.state(path), { state: 'queued' });
    busy = false;
    await waitFor(async () => (await sql`SELECT 1 FROM jobs WHERE queue = ${VIDEO_QUEUE} AND key = ${`note-video:${path}`} AND status = 'done'`).length === 1);
  } finally {
    await worker.stop();
  }
});
