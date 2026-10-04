import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, loadCatalog, resolveHome, voicePaths, type ModelCatalog } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { createVoiceService, voiceEnv, type VoiceService } from '../src/voice/service.ts';
import { speakCall, transcribeCall, trialModels, type TrialModel } from '../src/voice/trial.ts';

const HOME = resolveHome({});
const CATALOG: ModelCatalog = loadCatalog(HOME);
const MODELS = join(HOME, DATA_DIR, 'models');
/** Every voice file of the catalog is "on disk". */
const allPresent = (path: string): number | undefined => {
  for (const entry of CATALOG.models) {
    for (const file of entry.files) if (join(MODELS, entry.id, file.path) === path) return file.sizeBytes;
  }
  return undefined;
};
const pcm = (seconds: number): string => Buffer.alloc(Math.round(seconds * 16_000) * 2).toString('base64');

test('trialModels: the stt and tts candidates of the catalog, on disk or not, and who holds the role', () => {
  const models = trialModels(CATALOG, { stt: 'parakeet-tdt-0.6b-v3-mlx' }, MODELS, allPresent);
  assert.deepEqual(
    models.map(({ id, kind, present, assigned }) => [id, kind, present, assigned]),
    [
      ['parakeet-tdt-0.6b-v3-mlx', 'stt', true, true],
      ['whisper-large-v3-turbo-mlx', 'stt', true, false],
      ['kokoro-82m-bf16-mlx', 'tts', true, false],
      ['chatterbox-multilingual-v3-mlx', 'tts', true, false],
    ],
  );
  assert.deepEqual(models.find((model) => model.family === 'kokoro')?.voices, ['if_sara', 'im_nicola']);
  // A file with the wrong size is not "present"; the orchestrator models are not candidates.
  const absent = trialModels(CATALOG, {}, MODELS, (path) => (path.endsWith('model.safetensors') ? 1 : allPresent(path)));
  assert.equal(absent.find((model) => model.family === 'parakeet')?.present, false);
  assert.equal(absent.find((model) => model.family === 'kokoro')?.present, true);
  assert.ok(!absent.some((model) => model.id.startsWith('qwen')));
});

test('transcribeCall: audio between 0.3 and 30 s goes to every present stt model; anything else is refused', () => {
  const models = trialModels(CATALOG, {}, MODELS, allPresent);
  const call = transcribeCall({ pcm16: pcm(1) }, models);
  assert.deepEqual(call.models.map(({ family }) => family), ['parakeet', 'whisper']);
  assert.equal(call.rate, 16_000);
  for (const body of [{}, { pcm16: pcm(0.1) }, { pcm16: pcm(31) }, { pcm16: 'not base64!' }, { pcm16: 'QUJD' }, { pcm16: pcm(1), models: [] }, { pcm16: 1 }]) {
    assert.throws(() => transcribeCall(body, models), { name: 'TrialError' }, JSON.stringify(body).slice(0, 40));
  }
  assert.throws(() => transcribeCall({ pcm16: pcm(1) }, trialModels(CATALOG, {}, MODELS, () => undefined)), /pull --trial/);
});

test('speakCall: one present tts candidate with a Kokoro voice; Chatterbox gets Kokoro as its reference', () => {
  const models = trialModels(CATALOG, {}, MODELS, allPresent);
  assert.deepEqual(speakCall({ text: ' Ciao ', model: 'kokoro-82m-bf16-mlx', voice: 'if_sara' }, models), {
    text: 'Ciao',
    model: { id: 'kokoro-82m-bf16-mlx', family: 'kokoro' },
    voice: 'if_sara',
  });
  assert.deepEqual(speakCall({ text: 'Ciao', model: 'chatterbox-multilingual-v3-mlx', voice: 'im_nicola' }, models).reference, {
    id: 'kokoro-82m-bf16-mlx',
    family: 'kokoro',
  });
  const bad = [
    { text: '', model: 'kokoro-82m-bf16-mlx', voice: 'if_sara' },
    { text: 'x'.repeat(401), model: 'kokoro-82m-bf16-mlx', voice: 'if_sara' },
    { text: 'a\u0000b', model: 'kokoro-82m-bf16-mlx', voice: 'if_sara' },
    { text: 'Ciao', model: 'parakeet-tdt-0.6b-v3-mlx', voice: 'if_sara' },
    { text: 'Ciao', model: 'qwen3-4b-instruct-2507-4bit', voice: 'if_sara' },
    { text: 'Ciao', model: 'kokoro-82m-bf16-mlx', voice: 'af_heart' },
    { text: 'Ciao', model: 'kokoro-82m-bf16-mlx', voice: 'if_sara', reference: 'x' },
  ];
  for (const body of bad) assert.throws(() => speakCall(body, models), { name: 'TrialError' }, JSON.stringify(body).slice(0, 60));
  // Chatterbox without Kokoro on disk has no voice to clone.
  const noKokoro = models.map((model) => (model.family === 'kokoro' ? { ...model, present: false } : model));
  assert.throws(() => speakCall({ text: 'Ciao', model: 'chatterbox-multilingual-v3-mlx', voice: 'if_sara' }, noKokoro), { name: 'TrialError' });
});

test('voiceEnv: built from nothing; no secret of the core, Hugging Face offline', () => {
  const paths = voicePaths(HOME, join(HOME, DATA_DIR));
  const env = voiceEnv(
    { PATH: '/usr/bin', HOME: '/h', ARIANNA_DB_PASSWORD: 'x', SOPS_AGE_KEY: 'x', SOPS_AGE_KEY_FILE: 'x', HTTPS_PROXY: 'x', NODE_OPTIONS: 'x', HF_TOKEN: 'x' },
    paths,
    7421,
    'token',
  );
  assert.deepEqual(Object.keys(env).sort(), [
    'ARIANNA_MODELS_DIR',
    'ARIANNA_VOICE_PORT',
    'ARIANNA_VOICE_TMP',
    'ARIANNA_VOICE_TOKEN',
    'HF_HOME',
    'HF_HUB_DISABLE_TELEMETRY',
    'HF_HUB_OFFLINE',
    'HOME',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'NUMBA_CACHE_DIR',
    'PATH',
    'PYTHONDONTWRITEBYTECODE',
    'PYTHONPATH',
    'PYTHONUNBUFFERED',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]);
  assert.equal(env.HF_HUB_OFFLINE, '1');
  // The real proxy of the shell is replaced by a closed port: no way out but loopback.
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9');
  for (const key of ['XDG_CACHE_HOME', 'NUMBA_CACHE_DIR', 'HF_HOME', 'TMPDIR']) assert.ok(env[key]?.startsWith(join(HOME, DATA_DIR)), key);
  assert.ok(env.ARIANNA_VOICE_TMP?.startsWith(join(HOME, DATA_DIR)));
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => { resolve(); }));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

// The service and the API, with the fake voice in place of Python.
const tmpRoot = join(HOME, DATA_DIR, 'test-tmp', randomUUID());
let service: VoiceService;
let server: ApiServer;
let origin: string;
let models: TrialModel[] = trialModels(CATALOG, {}, MODELS, allPresent);

before(async () => {
  mkdirSync(tmpRoot, { recursive: true });
  const paths = { ...voicePaths(HOME, join(HOME, DATA_DIR)), tmp: tmpRoot };
  service = createVoiceService({
    paths,
    port: await freePort(),
    command: [process.execPath, fileURLToPath(new URL('support/fake-voice.ts', import.meta.url))],
    env: { PATH: process.env.PATH ?? '', HOME: tmpRoot, SOPS_AGE_KEY: 'secret' },
    timing: { intervalMs: 100, startupTimeoutMs: 10_000, backoffMs: 50, stopGraceMs: 1_000 },
  });
  await service.start();
  // The routes of the voice never touch the database or the live feed.
  server = await startApiServer({
    sql: {} as Sql,
    live: {} as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    voice: { service, voice: 'if_sara', models: () => models },
  });
  origin = `http://127.0.0.1:${String(server.port)}`;
});

after(async () => {
  await server.close();
  await service.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown): Promise<{ status: number; type: string; cache: string | undefined; body: Buffer }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      {
        method,
        agent: false,
        headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }), ...(method === 'GET' ? {} : { origin }) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, type: String(response.headers['content-type']), cache: response.headers['cache-control'], body: Buffer.concat(chunks) });
        });
      },
    );
    request.on('error', (error: NodeJS.ErrnoException) => {
      // The server may close before the whole of an oversized body is sent.
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') resolve({ status: 413, type: '', cache: undefined, body: Buffer.alloc(0) });
      else reject(error);
    });
    request.end(payload);
  });
}

test('the core starts the voice with its token and a clean environment', async () => {
  assert.equal(service.state, 'up');
  const health = await service.request('GET', '/health');
  const keys = (JSON.parse(health.body.toString('utf8')) as { env: string[] }).env;
  assert.ok(!keys.includes('SOPS_AGE_KEY'));
  assert.ok(keys.includes('ARIANNA_VOICE_TOKEN'));
});

test('trial API: candidates, transcription by every present model, speech as WAV', async () => {
  const listed = await call('GET', '/api/voice/trial');
  assert.equal(listed.status, 200);
  const trial = JSON.parse(listed.body.toString('utf8')) as { state: string; voice: string; models: TrialModel[] };
  assert.equal(trial.state, 'up');
  assert.equal(trial.voice, 'if_sara');
  assert.equal(trial.models.length, 4);

  const written = await call('POST', '/api/voice/trial/transcribe', { pcm16: pcm(2) });
  assert.equal(written.status, 200);
  const results = (JSON.parse(written.body.toString('utf8')) as { results: { family: string; text: string }[] }).results;
  assert.deepEqual(results.map(({ family, text }) => [family, text]), [['parakeet', 'ciao'], ['whisper', 'ciao']]);

  const spoken = await call('POST', '/api/voice/trial/speak', { text: 'Ciao', model: 'chatterbox-multilingual-v3-mlx', voice: 'if_sara' });
  assert.equal(spoken.status, 200);
  assert.equal(spoken.type, 'audio/wav');
  assert.equal(spoken.cache, 'no-store');
  assert.equal(spoken.body.subarray(0, 4).toString(), 'RIFF');
  // What the core sent the voice: the model and Kokoro as the reference, chosen by the core.
  assert.deepEqual(JSON.parse(spoken.body.subarray(4).toString()), {
    text: 'Ciao',
    model: { id: 'chatterbox-multilingual-v3-mlx', family: 'chatterbox' },
    voice: 'if_sara',
    reference: { id: 'kokoro-82m-bf16-mlx', family: 'kokoro' },
  });
});

test('trial API: bad requests, errors of the voice and missing models are reported with a code', async () => {
  assert.equal((await call('POST', '/api/voice/trial/speak', { text: 'Ciao', model: '../x', voice: 'if_sara' })).status, 400);
  assert.equal((await call('POST', '/api/voice/trial/transcribe', { pcm16: pcm(0.1) })).status, 400);
  const broken = await call('POST', '/api/voice/trial/speak', { text: 'rompi', model: 'kokoro-82m-bf16-mlx', voice: 'if_sara' });
  assert.equal(broken.status, 502);
  assert.deepEqual(JSON.parse(broken.body.toString('utf8')), { error: 'voice: inference' });
  models = trialModels(CATALOG, {}, MODELS, () => undefined);
  const missing = await call('POST', '/api/voice/trial/transcribe', { pcm16: pcm(1) });
  assert.equal(missing.status, 400);
  assert.match(missing.body.toString('utf8'), /pull --trial/);
  models = trialModels(CATALOG, {}, MODELS, allPresent);
  // 30 s of audio fits the larger limit of this route, more does not.
  assert.equal((await call('POST', '/api/voice/trial/transcribe', { pcm16: pcm(30) })).status, 200);
  assert.equal((await call('POST', '/api/voice/trial/transcribe', { pcm16: pcm(40) })).status, 413);
});

test('without [voice] the trial says off and every action is refused', async () => {
  const off = await startApiServer({ sql: {} as Sql, live: {} as LiveFeed, host: '127.0.0.1', port: 0 });
  try {
    const saved = origin;
    origin = `http://127.0.0.1:${String(off.port)}`;
    const listed = await call('GET', '/api/voice/trial');
    assert.deepEqual(JSON.parse(listed.body.toString('utf8')), { state: 'off', voice: null, models: [] });
    assert.equal((await call('POST', '/api/voice/trial/speak', { text: 'Ciao', model: 'kokoro-82m-bf16-mlx', voice: 'if_sara' })).status, 503);
    origin = saved;
  } finally {
    await off.close();
  }
});
