import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { createContext, isAtMost, labelForKbPage, maxLabel, spendAllowed, type Label, type LabelRules } from '@arianna/policy';
import type { LocalModel } from '@arianna/executors';

import { cleanChildEnv } from './child-env.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { passGateway } from './gateway.ts';
import { completeJob, createJobQueue, enqueueJob, failJob, type Job } from './jobs.ts';
import { machineBusy } from './model-evals.ts';
import { checkNotePath, headerFields, MAX_NOTE_BYTES, noteLabel, NoteError, readNoteFile, replaceNote, sha256 } from './notes.ts';
import type { Kb } from './orchestrator/kb.ts';
import { captureOf, ORGANIZE_MAX_ATTEMPTS, ORGANIZE_MODEL, organizeRetryDelayMs } from './organize.ts';
import { composeVideoNote, MAX_VIDEO_NOTE_BYTES, relatedUsable, summarizeVideo, type SummaryFailure, type VideoFacts } from './video-note.ts';
import { startVideoProxy, type VideoProxy, type VideoProxyOptions } from './video-proxy.ts';
import { chooseTrack, MAX_VTT_BYTES, parseVtt, readSpoken, toSegments, type Line, type Segment, type TranscriptSource } from './video-transcript.ts';
import { videoUrl, youtubeVideoId } from './video-url.ts';

/**
 * «Riassumi il video» (D-273, tappa A): a job of the `note.video` queue, only
 * after the user approved it for that one video in the chat. One job at a
 * time, giving way to a call and to the steps of a task as the organizer of
 * notes does (D-086): preempted, it goes back to the queue and starts again.
 *
 * 1. The normalized address passes the gateway (`link-video`): one row in
 *    gateway_log, the address never written.
 * 2. The proxy of the core opens (`video-proxy.ts`) and apps/voice runs
 *    yt-dlp through it: the metadata, then the subtitles (by hand in the
 *    language of the video, then automatic, then Italian or English); only
 *    without any, the audio (at most 300 MB) into the private folder of the
 *    job. The proxy closes.
 * 3. Only for the audio: apps/voice converts it with ffmpeg and hears it with
 *    Parakeet in a process without network; the folder goes in `finally`,
 *    whatever happens, and what a crash left is removed at start.
 * 4. The local model summarizes in two passes (`video-note.ts`); the note is
 *    rewritten with its header, sections and the closed transcript.
 *
 * Events are L0 with codes only: `note.video_fetched {source, minutes}` and
 * `note.video_failed {reason}`. A failure of the download is never tried
 * again (D-197: «forse yt-dlp va aggiornato»); only a model not answering is.
 */
export const VIDEO_QUEUE = 'note.video';
/** A longer video is refused with its reason (choice of the user, 2026-10-21). */
export const VIDEO_MAX_SECONDS = 2 * 60 * 60;
export const VIDEO_MAX_AUDIO_BYTES = 300 * 1024 * 1024;
/** One step of yt-dlp at most this long; the proxy closes at 20 minutes anyway. */
export const VIDEO_STEP_TIMEOUT_MS = 20 * 60_000;
/** The transcription of 2 hours of audio at most this long. */
export const VIDEO_TRANSCRIBE_TIMEOUT_MS = 40 * 60_000;
/** Bytes of the answer of one step of apps/voice read at most (2 hours of sentences are about 200 KB). */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/** Why a video was not summarized: a closed list, safe for an event or the chat. */
export const VIDEO_FAILURES = [
  'not-found',
  'not-a-video',
  'above-clearance',
  'blocked',
  'not-installed',
  'live',
  'no-duration',
  'too-long',
  'unavailable',
  'bot-check',
  'network',
  'too-large',
  'timeout',
  'needs-deno',
  'no-ffmpeg',
  'no-stt',
  'download-failed',
  'transcribe-failed',
  'empty',
  'model-error',
  'unavailable-model',
  'model-timeout',
  'truncated',
  'bad-response',
  'changed',
  'interrupted',
  'note-too-large',
  'error',
] as const;
export type VideoFailure = (typeof VIDEO_FAILURES)[number];

export function isVideoFailure(value: unknown): value is VideoFailure {
  return VIDEO_FAILURES.some((failure) => failure === value);
}

/** The reasons in Italian, as the chat says them. */
export const VIDEO_FAILURE_TEXT: Record<VideoFailure, string> = {
  'not-found': 'il pensiero non c’è più',
  'not-a-video': 'il link non è un video di YouTube',
  'above-clearance': 'il pensiero è sopra Privato',
  blocked: 'il gateway ha fermato l’indirizzo',
  'not-installed': 'manca l’ambiente della voce: lancia pnpm voice:sync',
  live: 'è una diretta: si riassume solo un video finito',
  'no-duration': 'YouTube non dice quanto dura il video',
  'too-long': 'il video dura più di 2 ore',
  unavailable: 'il video non è disponibile (privato, rimosso, per soli membri o con limite d’età)',
  'bot-check': 'YouTube chiede di confermare che non sei un robot: riprova più tardi',
  network: 'errore di rete verso YouTube',
  'too-large': 'l’audio supera il tetto di 300 MB (o lo scaricamento i 400 MB)',
  timeout: 'lo scaricamento ha superato i 20 minuti',
  'needs-deno': 'il video non ha sottotitoli e serve Deno per l’audio (brew install deno)',
  'no-ffmpeg': 'il video non ha sottotitoli e per l’audio serve ffmpeg (brew install ffmpeg)',
  'no-stt': 'il video non ha sottotitoli e per l’audio serve Parakeet (ruolo stt, pnpm arianna:models pull)',
  'download-failed': 'scaricamento non riuscito: forse yt-dlp va aggiornato',
  'transcribe-failed': 'la trascrizione dell’audio non è riuscita',
  empty: 'nel video non c’è niente da trascrivere',
  'model-error': 'il modello locale ha dato un errore',
  'unavailable-model': 'il modello locale non risponde',
  'model-timeout': 'il modello locale non ha risposto in tempo',
  truncated: 'la risposta del modello locale è stata tagliata',
  'bad-response': 'la risposta del modello locale non è leggibile',
  changed: 'il pensiero è cambiato mentre lo riassumevo',
  interrupted: 'lavoro interrotto',
  'note-too-large': 'il testo del pensiero è troppo lungo per aggiungergli il riassunto del video',
  error: 'errore interno',
};

/** What the chat shows of a job at work. */
export type VideoStage = 'queued' | 'metadata' | 'subtitles' | 'audio' | 'transcribing' | 'summarizing';

export interface VideoJobState {
  state: 'queued' | 'running' | 'failed' | 'done';
  stage?: VideoStage;
  reason?: VideoFailure;
}

// --- apps/voice, step by step ----------------------------------------------------

export type FetchStep = 'meta' | 'subs' | 'audio';

export interface FetchStepEnv {
  url: string;
  proxy: string;
  folder: string;
  deno?: string;
  lang?: string;
  auto?: boolean;
  maxAudio?: number;
}

export interface TranscribeEnv {
  folder: string;
  audio: string;
  ffmpeg: string;
  model: string;
  maxSeconds: number;
}

/** The answer of a step: `{ok: true, …}` or `{ok: false, error}` with a code of apps/voice. */
export type StepAnswer = { ok: true; [key: string]: unknown } | { ok: false; error: string };

/** How the core runs apps/voice; tests give fakes, never yt-dlp, Deno, ffmpeg or Parakeet. */
export interface VideoRunner {
  fetch(step: FetchStep, env: FetchStepEnv, signal: AbortSignal): Promise<StepAnswer>;
  transcribe(env: TranscribeEnv, signal: AbortSignal): Promise<StepAnswer>;
}

/** The environment of a step of yt-dlp: built from nothing, HOME the folder of the job, no cookie, no config. */
export function fetchStepEnv(from: NodeJS.ProcessEnv, src: string, step: FetchStepEnv): Record<string, string> {
  const home = join(step.folder, 'home');
  const base = cleanChildEnv(from, ['PATH', 'LANG']);
  // The proxy of the job for everything yt-dlp and its libraries ask; none of the dead proxy's exceptions.
  delete base.NO_PROXY;
  delete base.no_proxy;
  return {
    ...base,
    HTTP_PROXY: step.proxy,
    HTTPS_PROXY: step.proxy,
    http_proxy: step.proxy,
    https_proxy: step.proxy,
    HOME: home,
    TMPDIR: join(step.folder, 'tmp'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_CONFIG_HOME: join(home, 'config'),
    DENO_DIR: join(home, 'deno'),
    DENO_NO_UPDATE_CHECK: '1',
    DENO_NO_PROMPT: '1',
    PYTHONPATH: src,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    ARIANNA_VIDEO_DIR: step.folder,
    ARIANNA_VIDEO_URL: step.url,
    ARIANNA_VIDEO_PROXY: step.proxy,
    ...(step.deno === undefined ? {} : { ARIANNA_DENO: step.deno }),
    ...(step.lang === undefined ? {} : { ARIANNA_VIDEO_SUB_LANG: step.lang, ARIANNA_VIDEO_SUB_AUTO: step.auto === true ? '1' : '0' }),
    ...(step.maxAudio === undefined ? {} : { ARIANNA_VIDEO_MAX_AUDIO: String(step.maxAudio) }),
  };
}

/** The environment of the transcription: no network (the dead proxy of cleanChildEnv, Hugging Face offline). */
export function transcribeEnv(from: NodeJS.ProcessEnv, src: string, step: TranscribeEnv): Record<string, string> {
  const home = join(step.folder, 'home');
  return {
    ...cleanChildEnv(from, ['PATH', 'LANG']),
    HOME: home,
    TMPDIR: join(step.folder, 'tmp'),
    XDG_CACHE_HOME: join(home, 'cache'),
    HF_HOME: join(home, 'hf'),
    NUMBA_CACHE_DIR: join(home, 'numba'),
    PYTHONPATH: src,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    ARIANNA_VIDEO_DIR: step.folder,
    ARIANNA_VIDEO_AUDIO: step.audio,
    ARIANNA_FFMPEG: step.ffmpeg,
    ARIANNA_STT_MODEL: step.model,
    ARIANNA_VIDEO_MAX_SECONDS: String(step.maxSeconds),
  };
}

/** Runs `python -m arianna_voice.video <step>`: stdout is the answer, stderr is dropped (it may hold the title). */
export function runVoiceStep(python: string, project: string, step: string, env: Record<string, string>, signal: AbortSignal, timeoutMs: number): Promise<StepAnswer> {
  return new Promise((resolve) => {
    const child = spawn(python, ['-m', 'arianna_voice.video', step], { cwd: project, env, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (answer: StepAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve(answer);
    };
    const stop = (): void => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'interrupted' });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'timeout' });
    }, timeoutMs);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_ANSWER_BYTES) {
        child.kill('SIGKILL');
        finish({ ok: false, error: 'bad-answer' });
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => { finish({ ok: false, error: 'not-installed' }); });
    child.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      const last = text.slice(text.lastIndexOf('\n') + 1);
      try {
        const parsed: unknown = JSON.parse(last);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && typeof (parsed as { ok?: unknown }).ok === 'boolean') {
          const answer = parsed as StepAnswer;
          finish(answer.ok || typeof answer.error === 'string' ? answer : { ok: false, error: 'bad-answer' });
          return;
        }
      } catch {
        // Not an answer: the process died before writing one.
      }
      finish({ ok: false, error: 'bad-answer' });
    });
  });
}

/** apps/voice in its venv, as the core runs it. */
export function voiceRunner(paths: { python: string; project: string; src: string }, from: NodeJS.ProcessEnv = process.env): VideoRunner {
  return {
    fetch: (step, env, signal) => runVoiceStep(paths.python, paths.project, step, fetchStepEnv(from, paths.src, env), signal, VIDEO_STEP_TIMEOUT_MS),
    transcribe: (env, signal) => runVoiceStep(paths.python, paths.project, 'transcribe', transcribeEnv(from, paths.src, env), signal, VIDEO_TRANSCRIBE_TIMEOUT_MS),
  };
}

/** The first executable named `name` in PATH or in the usual folders of Homebrew; undefined when there is none. */
export function findTool(name: string, path = process.env.PATH ?? ''): string | undefined {
  const folders = [...path.split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'].filter((folder) => folder.startsWith('/'));
  for (const folder of new Set(folders)) {
    const file = join(folder, name);
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK);
        return file;
      }
    } catch {
      // Not here.
    }
  }
  return undefined;
}

// --- The work of one video ---------------------------------------------------------

export interface VideoTools {
  runner: VideoRunner;
  /** apps/voice is installed (its venv exists). */
  installed: () => boolean;
  deno: () => string | undefined;
  ffmpeg: () => string | undefined;
  /** The folder of Parakeet, the model of the role stt, when it is on disk. */
  stt: () => string | undefined;
}

export interface VideoEnv {
  sql: Sql;
  home: string;
  rules: LabelRules;
  kb: Pick<Kb, 'search'>;
  model: () => LocalModel;
  tools: VideoTools;
  /** data/voice/tmp/video: one private folder per job inside. */
  scratch: string;
  now?: () => Date;
  timeoutMs?: number;
  /** Tests only: the proxy runs with these options (a fake resolver, a local port). */
  proxy?: VideoProxyOptions;
  onStage?: (stage: VideoStage) => void;
}

export interface Transcript {
  facts: VideoFacts;
  segments: Segment[];
}

export type VideoOutcome =
  | { ok: true; source: TranscriptSource; minutes: number }
  | { ok: false; reason: VideoFailure }
  /** Already a note of a video: nothing to do. */
  | { ok: false; reason: 'done' };

type Failed = { reason: VideoFailure };

const STEP_ERRORS: Record<string, VideoFailure> = {
  'not-installed': 'not-installed',
  unavailable: 'unavailable',
  'bot-check': 'bot-check',
  network: 'network',
  'too-large': 'too-large',
  'no-ffmpeg': 'no-ffmpeg',
  'transcribe-failed': 'transcribe-failed',
  empty: 'empty',
  timeout: 'timeout',
  interrupted: 'interrupted',
};

function stepFailure(answer: { error: string }, fallback: VideoFailure): VideoFailure {
  return STEP_ERRORS[answer.error] ?? fallback;
}

/** The metadata of apps/voice checked again: shapes and limits. */
export function readMeta(value: unknown, id: string): { facts: Omit<VideoFacts, 'source' | 'lang'>; live: boolean; language: string | null; subtitles: string[]; automatic: string[] } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const meta = value as Record<string, unknown>;
  const text = (item: unknown): string | null => (typeof item === 'string' && item.trim() !== '' ? item.slice(0, 300) : null);
  const langs = (item: unknown): string[] => (Array.isArray(item) ? item.filter((lang): lang is string => typeof lang === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(lang)).slice(0, 400) : []);
  if (meta.id !== id) return undefined;
  const chapters = Array.isArray(meta.chapters)
    ? meta.chapters
        .filter((chapter): chapter is { start: number; title: string } => typeof chapter === 'object' && chapter !== null && typeof (chapter as { start?: unknown }).start === 'number' && typeof (chapter as { title?: unknown }).title === 'string')
        .filter((chapter) => Number.isFinite(chapter.start) && chapter.start >= 0)
        .slice(0, 100)
        .map((chapter) => ({ start: chapter.start, title: chapter.title.slice(0, 200) }))
    : [];
  const duration = typeof meta.duration === 'number' && Number.isFinite(meta.duration) && meta.duration >= 0 ? meta.duration : -1;
  return {
    facts: { id, title: text(meta.title), channel: text(meta.channel), duration, chapters },
    live: meta.live === true,
    language: typeof meta.language === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(meta.language) ? meta.language : null,
    subtitles: langs(meta.subtitles),
    automatic: langs(meta.automatic),
  };
}

/** A file the Python step named, inside the folder of the job, plain, at most `max` bytes; undefined otherwise. */
function jobFile(folder: string, name: unknown, max: number): string | undefined {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) return undefined;
  const file = join(folder, name);
  try {
    const stat = lstatSync(file);
    return stat.isFile() && stat.size <= max ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The transcript of the video: the address through the gateway, then
 * yt-dlp through the proxy, then (only without subtitles) Parakeet without
 * network. The folder of the job goes whatever happens.
 */
export async function fetchTranscript(env: VideoEnv, path: string, id: string, label: Label, jobId: string, signal: AbortSignal): Promise<Transcript | Failed> {
  const { runner } = env.tools;
  if (!env.tools.installed()) return { reason: 'not-installed' };
  const address = videoUrl(id);
  // The one address that leaves, with the consent of the user for this video (D-273).
  const decision = await passGateway(env.sql, [{ value: address, label, source: `link:${path}` }], createContext('L2', label), { kind: 'link', consent: 'video' });
  if (decision.decision !== 'allow') return { reason: 'blocked' };
  const spent = spendAllowed(decision);
  if (spent?.target.kind !== 'link' || spent.texts[0] !== address) return { reason: 'blocked' };

  const folder = join(env.scratch, `job-${jobId.replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(env.scratch, { recursive: true, mode: 0o700 });
  mkdirSync(folder, { mode: 0o700 });
  for (const inner of ['home', 'tmp']) mkdirSync(join(folder, inner), { mode: 0o700 });
  let proxy: VideoProxy | undefined;
  try {
    proxy = await startVideoProxy(env.proxy);
    const deno = env.tools.deno();
    const base = { url: address, proxy: proxy.url, folder, ...(deno === undefined ? {} : { deno }) };
    const closed = (fallback: VideoFailure): VideoFailure => proxy?.stopped ?? fallback;

    env.onStage?.('metadata');
    const metaAnswer = await runner.fetch('meta', base, signal);
    if (aborted(signal)) return { reason: 'interrupted' };
    if (!metaAnswer.ok) return { reason: closed(stepFailure(metaAnswer, 'download-failed')) };
    const meta = readMeta(metaAnswer.meta, id);
    if (meta === undefined) return { reason: 'download-failed' };
    if (meta.live) return { reason: 'live' };
    if (meta.facts.duration < 0) return { reason: 'no-duration' };
    if (meta.facts.duration > VIDEO_MAX_SECONDS) return { reason: 'too-long' };

    // Subtitles first: by hand in the language of the video, then automatic, then Italian or English.
    let lines: Line[] = [];
    let source: TranscriptSource = 'audio';
    let lang: string | null = null;
    const track = chooseTrack(meta);
    if (track !== undefined) {
      env.onStage?.('subtitles');
      const subs = await runner.fetch('subs', { ...base, lang: track.lang, auto: track.auto }, signal);
      if (aborted(signal)) return { reason: 'interrupted' };
      if (proxy.stopped !== undefined) return { reason: proxy.stopped };
      // Only subtitles that are not there send the job to the audio: any other failure ends it with its reason.
      if (!subs.ok && subs.error !== 'no-subtitles') return { reason: closed(stepFailure(subs, 'download-failed')) };
      const file = subs.ok ? jobFile(folder, subs.file, MAX_VTT_BYTES) : undefined;
      if (file !== undefined) {
        lines = parseVtt(readFileSync(file, 'utf8'), track.auto);
        source = track.auto ? 'automatic' : 'subtitles';
        lang = track.lang.replace(/-orig$/, '');
      }
    }

    if (lines.length === 0) {
      // Only now the audio: it needs Deno (the challenges of YouTube), ffmpeg and Parakeet.
      if (deno === undefined) return { reason: 'needs-deno' };
      const ffmpeg = env.tools.ffmpeg();
      if (ffmpeg === undefined) return { reason: 'no-ffmpeg' };
      const model = env.tools.stt();
      if (model === undefined) return { reason: 'no-stt' };
      env.onStage?.('audio');
      const audio = await runner.fetch('audio', { ...base, maxAudio: VIDEO_MAX_AUDIO_BYTES }, signal);
      if (aborted(signal)) return { reason: 'interrupted' };
      if (!audio.ok) return { reason: closed(stepFailure(audio, 'download-failed')) };
      const file = jobFile(folder, audio.file, VIDEO_MAX_AUDIO_BYTES);
      if (file === undefined || typeof audio.file !== 'string') return { reason: 'download-failed' };
      // The network is over before the audio is heard.
      await proxy.stop();
      env.onStage?.('transcribing');
      const heard = await runner.transcribe({ folder, audio: audio.file, ffmpeg, model, maxSeconds: VIDEO_MAX_SECONDS }, signal);
      if (aborted(signal)) return { reason: 'interrupted' };
      if (!heard.ok) return { reason: stepFailure(heard, 'transcribe-failed') };
      const spoken = readSpoken(heard.segments);
      if (spoken === undefined) return { reason: 'transcribe-failed' };
      lines = spoken;
      source = 'audio';
    }
    const segments = toSegments(lines);
    if (segments.length === 0) return { reason: 'empty' };
    return { facts: { ...meta.facts, source, lang }, segments };
  } finally {
    await proxy?.stop();
    // The audio and every file of the job go, whatever happened (D-197).
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Read through a call: the signal changes while the steps run. */
function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

const SUMMARY_FAILURES: Record<SummaryFailure, VideoFailure> = {
  blocked: 'blocked',
  'model-error': 'model-error',
  unavailable: 'unavailable-model',
  timeout: 'model-timeout',
  truncated: 'truncated',
  'bad-response': 'bad-response',
  interrupted: 'interrupted',
};

/** Whether the note is already the note of a video. */
export function isVideoNote(raw: string): boolean {
  return headerFields(raw).get('media') === 'youtube';
}

/**
 * Summarizes the video of one note of kb/inbox. `kept` is the transcript an
 * earlier attempt of the same job fetched: once fetched, the video does not
 * leave again for that job. A job that gives way to a call while it fetches
 * (metadata, subtitles, audio, transcription) starts again from the gateway:
 * a second `link-video` row and a second download.
 */
export async function summarizeVideoNote(
  env: VideoEnv,
  path: string,
  jobId: string,
  signal: AbortSignal,
  kept?: Transcript,
  onTranscript?: (transcript: Transcript) => void,
): Promise<VideoOutcome> {
  let raw: string;
  try {
    raw = readNoteFile(env.home, checkNotePath(path));
  } catch (error) {
    if (error instanceof NoteError) return { ok: false, reason: 'not-found' };
    throw error;
  }
  if (isVideoNote(raw)) return { ok: false, reason: 'done' };
  const view = captureOf(raw);
  if (view === undefined) return { ok: false, reason: 'changed' };
  const id = view.kept.url === undefined ? undefined : youtubeVideoId(view.kept.url);
  if (id === undefined) return { ok: false, reason: 'not-a-video' };
  const ownLabel = maxLabel('L2', noteLabel(env.rules, path, raw), labelForKbPage(env.rules, path, undefined));
  if (!isAtMost(ownLabel, 'L2')) return { ok: false, reason: 'above-clearance' };

  let transcript = kept;
  if (transcript === undefined) {
    const fetched = await fetchTranscript(env, path, id, ownLabel, jobId, signal);
    if ('reason' in fetched) return { ok: false, reason: fetched.reason };
    transcript = fetched;
    onTranscript?.(transcript);
  }

  env.onStage?.('summarizing');
  const query = `${transcript.facts.title ?? ''} ${transcript.segments.slice(0, 4).map((segment) => segment.text).join(' ')}`.slice(0, 1_000);
  const hits = env.kb
    .search(query, createContext('L2'), 6, 'kb')
    .hits.filter((hit) => relatedUsable(hit, path))
    .slice(0, 5);
  const label = maxLabel(ownLabel, ...hits.map((hit) => hit.label));
  const summary = await summarizeVideo(
    { sql: env.sql, model: env.model, ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }) },
    { path, label, facts: transcript.facts, segments: transcript.segments, note: view.original, related: hits },
    signal,
  );
  if ('reason' in summary) return { ok: false, reason: SUMMARY_FAILURES[summary.reason] };
  if (signal.aborted) return { ok: false, reason: 'interrupted' };

  // The organizer may have rewritten the note meanwhile: composed again once from the new file.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      try {
        raw = readNoteFile(env.home, path);
      } catch {
        return { ok: false, reason: 'changed' };
      }
      if (isVideoNote(raw)) return { ok: false, reason: 'done' };
    }
    let content: string;
    try {
      content = composeVideoNote({ raw, label, facts: transcript.facts, summary, segments: transcript.segments, related: hits.map((hit) => hit.path), model: ORGANIZE_MODEL, now: env.now?.() ?? new Date() }).content;
    } catch (error) {
      if (error instanceof NoteError) return { ok: false, reason: 'changed' };
      throw error;
    }
    // The note of a video stays under 150 KB (a note over MAX_NOTE_BYTES is no longer listed nor read):
    // the transcript is cut first; a capture too long by itself leaves the note as it was.
    if (Buffer.byteLength(content, 'utf8') > Math.min(MAX_VIDEO_NOTE_BYTES, MAX_NOTE_BYTES)) return { ok: false, reason: 'note-too-large' };
    try {
      replaceNote(env.home, path, content, sha256(raw));
      return { ok: true, source: transcript.facts.source, minutes: Math.round(transcript.facts.duration / 60) };
    } catch (error) {
      if (!(error instanceof NoteError)) throw error;
      if (error.code !== 'changed') return { ok: false, reason: 'error' };
    }
  }
  return { ok: false, reason: 'changed' };
}

// --- The queue ---------------------------------------------------------------------

/** Queues «Riassumi il video» for a note; false when it is already queued or running. */
export async function enqueueVideo(sql: Queryable, path: string): Promise<boolean> {
  checkNotePath(path);
  const id = await enqueueJob(sql, VIDEO_QUEUE, { path }, { key: `note-video:${path}`, maxAttempts: ORGANIZE_MAX_ATTEMPTS });
  return id !== undefined;
}

/** The last job of a note, as the chat shows it; undefined when there was none. */
export async function videoJobState(sql: Queryable, path: string, stage?: VideoStage): Promise<VideoJobState | undefined> {
  const [row] = await sql<{ status: string; lastError: string | null }[]>`
    SELECT status, last_error AS "lastError" FROM jobs
    WHERE queue = ${VIDEO_QUEUE} AND key = ${`note-video:${path}`}
    ORDER BY id DESC LIMIT 1`;
  if (row === undefined) return undefined;
  if (row.status === 'queued') return { state: 'queued' };
  if (row.status === 'running') return { state: 'running', ...(stage === undefined ? {} : { stage }) };
  if (row.status === 'failed') return { state: 'failed', reason: isVideoFailure(row.lastError) ? row.lastError : 'error' };
  return { state: 'done' };
}

/** Removes what a job left in the scratch folder (a crash, a stop): only the folders of jobs, never a link. */
export function removeLeftovers(scratch: string): number {
  if (!existsSync(scratch)) return 0;
  let removed = 0;
  for (const name of readdirSync(scratch)) {
    if (!name.startsWith('job-')) continue;
    const entry = join(scratch, name);
    try {
      if (lstatSync(entry).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    rmSync(entry, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export interface VideoWorkerOptions extends VideoEnv {
  busy?: () => Promise<boolean>;
  modelReady?: () => boolean;
  workerId?: string;
  lockTimeoutMs?: number;
  pollMs?: number;
  watchMs?: number;
  stopGraceMs?: number;
  onError?: (error: unknown) => void;
  /** The Archivist (D-195): proposes where the note of a video goes, as for any note organized. */
  archive?: (tx: Queryable, path: string) => Promise<boolean>;
  /** The Wiki (D-280): after every video summarized, the local model proposes what it adds to the wiki. */
  wiki?: (tx: Queryable, path: string) => Promise<boolean>;
}

export interface VideoWorker {
  enqueue(path: string): Promise<boolean>;
  /** The job of a note now, with the stage of the one at work. */
  state(path: string): Promise<VideoJobState | undefined>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

export function createVideoWorker(options: VideoWorkerOptions): VideoWorker {
  const { sql } = options;
  const queue = createJobQueue(sql);
  const worker = options.workerId ?? `video-${randomUUID()}`;
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 2_000;
  const busy = options.busy ?? (() => machineBusy(sql));
  const modelReady = options.modelReady ?? (() => true);
  const onError = options.onError ?? (() => undefined);
  const controller = new AbortController();
  let loop: Promise<void> | undefined;
  // What a job fetched, kept for its next attempts (a model not answering, a call during the summary): not fetched again.
  const transcripts = new Map<string, Transcript>();
  // The stage of the job at work, by path.
  const stages = new Map<string, VideoStage>();

  async function handle(job: Job): Promise<void> {
    const path = typeof job.payload.path === 'string' ? job.payload.path : '';
    const lost = new AbortController();
    const preempted = new AbortController();
    let lastBeat = Date.now();
    const beat = setInterval(() => {
      if (Date.now() - lastBeat > lockTimeoutMs) lost.abort();
      queue
        .heartbeat(job.id, worker)
        .then((held) => {
          if (held) lastBeat = Date.now();
          else lost.abort();
        })
        .catch(onError);
    }, Math.max(10, Math.floor(lockTimeoutMs / 3)));
    // A call or a task step comes first: the video goes back to the queue (D-086).
    const watch = setInterval(() => {
      busy()
        .then((taken) => {
          if (taken) preempted.abort();
        })
        .catch(onError);
    }, options.watchMs ?? 2_000);
    let outcome: VideoOutcome;
    try {
      checkNotePath(path);
      stages.set(path, 'metadata');
      outcome = await summarizeVideoNote(
        {
          ...options,
          onStage: (stage) => {
            stages.set(path, stage);
          },
        },
        path,
        job.id,
        AbortSignal.any([controller.signal, lost.signal, preempted.signal]),
        transcripts.get(job.id),
        (transcript) => {
          transcripts.set(job.id, transcript);
          while (transcripts.size > 10) transcripts.delete(transcripts.keys().next().value as string);
        },
      );
    } catch (error) {
      if (!(error instanceof NoteError)) onError(error);
      outcome = { ok: false, reason: error instanceof NoteError ? 'not-found' : 'error' };
    } finally {
      clearInterval(beat);
      clearInterval(watch);
      stages.delete(path);
    }
    const yielded = (controller.signal.aborted || preempted.signal.aborted) && !lost.signal.aborted;
    if (!outcome.ok && outcome.reason === 'interrupted' && yielded) {
      await queue.release(job.id, worker);
      return;
    }
    // Tried again later only when the model was not answering, with the transcript kept.
    if (outcome.ok || outcome.reason !== 'unavailable-model') transcripts.delete(job.id);
    await sql.begin(async (tx) => {
      if (outcome.ok) {
        await completeJob(tx, job.id, worker);
        // Codes only: never the address, the title or the channel.
        await appendEvent(tx, { kind: 'note.video_fetched', label: 'L0', payload: { jobId: job.id, source: outcome.source, minutes: outcome.minutes } });
        if (options.archive !== undefined) await options.archive(tx, path);
        if (options.wiki !== undefined) await options.wiki(tx, path);
      } else if (outcome.reason === 'done') {
        await completeJob(tx, job.id, worker);
      } else {
        const result = await failJob(tx, job.id, worker, outcome.reason, outcome.reason === 'unavailable-model' ? organizeRetryDelayMs(job.attempts) : null);
        if (result === 'lost') return;
        await appendEvent(tx, { kind: 'note.video_failed', label: 'L0', payload: { jobId: job.id, reason: outcome.reason, ...(result === 'retry' ? { retry: true } : {}) } });
      }
    });
  }

  async function run(): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        if (!modelReady() || (await busy())) {
          await sleep(pollMs, controller.signal);
          continue;
        }
        const job = await queue.claim(VIDEO_QUEUE, worker);
        if (job === undefined) {
          await sleep(pollMs, controller.signal);
          continue;
        }
        await handle(job);
      } catch (error) {
        onError(error);
        await sleep(pollMs, controller.signal);
      }
    }
  }

  return {
    enqueue: (path) => enqueueVideo(sql, path),
    state: (path) => videoJobState(sql, path, stages.get(path)),
    async start() {
      // One worker per core: a job left running belongs to a previous run, and so does its folder.
      await sql`
        UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = 'interrupted'
        WHERE queue = ${VIDEO_QUEUE} AND status = 'running'`;
      removeLeftovers(options.scratch);
      loop = run();
    },
    async stop() {
      controller.abort();
      const grace = new Promise<void>((resolve) => setTimeout(resolve, options.stopGraceMs ?? 10_000).unref());
      await Promise.race([loop, grace]);
    },
  };
}
