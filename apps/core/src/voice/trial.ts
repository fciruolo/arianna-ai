import { statSync } from 'node:fs';
import { join } from 'node:path';

import { modelPath, systemVoiceId, type CatalogEntry, type ModelCatalog, type Roles } from '@arianna/config';

/**
 * The voice trial page (D-066): the candidates of the catalog for hearing
 * (`stt`) and speaking (`tts`), which of them are on disk and which hold the
 * role now. The request checks are pure: the page sends only audio, text and
 * a model id and one of its voices; the core picks the models.
 */
export const STT_FAMILIES = ['parakeet', 'whisper'] as const;
export const TTS_FAMILIES = ['kokoro', 'qwen3-tts', 'qwen3-tts-base', 'voxtral-tts', 'macos-say'] as const;
/** The family of a voice of macOS (D-290): `say`, no model to load. */
export const SYSTEM_FAMILY = 'macos-say';
export type TrialKind = 'stt' | 'tts';

export interface TrialModel {
  id: string;
  family: string;
  kind: TrialKind;
  /** Every file of the catalog entry is in its folder (data/models for the voice) with the right size. */
  present: boolean;
  /** Assigned to the role in [roles] of arianna.toml. */
  assigned: boolean;
  sizeBytes: number;
  /** The voices the model can speak with (D-067); empty for stt. */
  voices: string[];
  /** A voice of the operating system (D-290): its name for `say`; `present` says it is installed. */
  systemVoice?: string;
}

/** What apps/voice is told of a speech model: its id and family, and the system voice when it is one (D-290). */
export interface VoiceModelRef {
  id: string;
  family: string;
  systemVoice?: string;
}

export function refOf(model: Pick<TrialModel, 'id' | 'family' | 'systemVoice'>): VoiceModelRef {
  return { id: model.id, family: model.family, ...(model.systemVoice === undefined ? {} : { systemVoice: model.systemVoice }) };
}

export type FileSize = (path: string) => number | undefined;

export const fileSize: FileSize = (path) => {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
};

/** Every file of the entry in its folder (modelPath, D-203) with the size of the catalog. */
export function filesPresent(dataDir: string, entry: Pick<CatalogEntry, 'id' | 'dir' | 'files'>, size: FileSize = fileSize): boolean {
  const folder = modelPath(dataDir, entry);
  return entry.files.every((file) => size(join(folder, file.path)) === file.sizeBytes);
}

// One file per voice: Kokoro in voices/, Voxtral in voice_embedding/ (D-067), as apps/voice reads them.
const VOICE_FOLDERS: Record<string, string> = { kokoro: 'voices', 'voxtral-tts': 'voice_embedding' };
const VOICE_FILE = /^([a-z_]+)\/([a-z][a-z0-9_]{1,40})\.safetensors$/;
/**
 * The speakers of Qwen3-TTS CustomVoice are in its weights, not in files. Of
 * its config.json, the native English and Mandarin speakers without a dialect,
 * asked to speak Italian (the Japanese and Korean ones and the dialects are left out).
 */
export const QWEN3_SPEAKERS = ['serena', 'vivian', 'ryan', 'aiden'] as const;

function voicesOf(family: string, paths: readonly string[], clones: readonly string[]): string[] {
  if (family === 'qwen3-tts') return [...QWEN3_SPEAKERS];
  // Qwen3-TTS Base speaks with the voices copied from a sample (D-069).
  if (family === 'qwen3-tts-base') return [...clones];
  return paths.flatMap((path) => {
    const match = VOICE_FILE.exec(path);
    return match !== null && match[1] === VOICE_FOLDERS[family] && match[2] !== undefined ? [match[2]] : [];
  });
}

/**
 * `systemVoices`: the voices of macOS installed now (system-voices.ts); a
 * system voice of the catalog is present only when it is among them (D-290).
 */
export function trialModels(
  catalog: ModelCatalog,
  roles: Roles,
  dataDir: string,
  size: FileSize = fileSize,
  clones: readonly string[] = [],
  systemVoices: readonly string[] = [],
): TrialModel[] {
  const out: TrialModel[] = [];
  for (const entry of catalog.models) {
    const kind = entry.roles.includes('stt') ? 'stt' : entry.roles.includes('tts') ? 'tts' : undefined;
    if (kind === undefined) continue;
    const families: readonly string[] = kind === 'stt' ? STT_FAMILIES : TTS_FAMILIES;
    // Only the families apps/voice knows how to run.
    if (!families.includes(entry.family)) continue;
    // A system voice is spoken by `say` (D-290): its family only, nothing on disk.
    if ((entry.runtime === 'system') !== (entry.family === SYSTEM_FAMILY)) continue;
    if (entry.runtime === 'system' && entry.voice !== undefined) {
      out.push({
        id: entry.id,
        family: entry.family,
        kind,
        present: systemVoices.includes(entry.voice),
        assigned: roles[kind] === entry.id,
        sizeBytes: 0,
        voices: [systemVoiceId(entry.voice)],
        systemVoice: entry.voice,
      });
      continue;
    }
    out.push({
      id: entry.id,
      family: entry.family,
      kind,
      present: filesPresent(dataDir, entry, size),
      assigned: roles[kind] === entry.id,
      sizeBytes: entry.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      voices: kind === 'tts' ? voicesOf(entry.family, entry.files.map((file) => file.path), clones) : [],
    });
  }
  return out;
}

export class TrialError extends Error {
  override name = 'TrialError';
}

// 16 kHz, 16-bit mono: 0.3 to 30 s, as apps/voice checks again.
const STT_RATE = 16_000;
const MIN_BYTES = Math.ceil(0.3 * STT_RATE) * 2;
const MAX_BYTES = 30 * STT_RATE * 2;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const MAX_TRIAL_TEXT = 400;
/** The transcribe body: base64 of 30 s of audio plus the JSON around it. */
export const MAX_TRANSCRIBE_BODY = Math.ceil((MAX_BYTES * 4) / 3) + 1024;

function only(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TrialError(`unknown field(s): ${unknown.join(', ')}`);
}

export interface TranscribeCall {
  pcm16: string;
  rate: number;
  models: { id: string; family: string }[];
}

/** The present speech-to-text candidates write the same recording. */
export function transcribeCall(body: Record<string, unknown>, models: readonly TrialModel[]): TranscribeCall {
  only(body, ['pcm16']);
  const pcm16 = body.pcm16;
  if (typeof pcm16 !== 'string' || pcm16.length % 4 !== 0 || !BASE64.test(pcm16)) throw new TrialError('pcm16: base64 of 16 kHz 16-bit mono samples');
  const bytes = (pcm16.length / 4) * 3 - (pcm16.endsWith('==') ? 2 : pcm16.endsWith('=') ? 1 : 0);
  if (bytes % 2 !== 0 || bytes < MIN_BYTES || bytes > MAX_BYTES) throw new TrialError('pcm16: between 0.3 and 30 seconds of 16-bit samples');
  const present = models.filter((model) => model.kind === 'stt' && model.present).map(({ id, family }) => ({ id, family }));
  if (present.length === 0) throw new TrialError('no speech-to-text model on disk: pnpm arianna:models pull --trial');
  return { pcm16, rate: STT_RATE, models: present };
}

export interface SpeakCall {
  text: string;
  model: VoiceModelRef;
  voice: string;
}

/** One candidate speaks with one of its own voices. */
export function speakCall(body: Record<string, unknown>, models: readonly TrialModel[]): SpeakCall {
  only(body, ['text', 'model', 'voice']);
  const { text, model: id, voice } = body;
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TRIAL_TEXT) throw new TrialError(`text: 1 to ${String(MAX_TRIAL_TEXT)} characters`);
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new TrialError('text: control characters are not allowed');
  const model = models.find((candidate) => candidate.kind === 'tts' && candidate.id === id);
  if (model === undefined) throw new TrialError('model: not a text-to-speech candidate of the catalog');
  if (!model.present) {
    throw new TrialError(model.systemVoice === undefined ? 'model: not on disk: pnpm arianna:models pull --trial' : 'model: the system voice is not installed on this Mac');
  }
  if (typeof voice !== 'string' || !model.voices.includes(voice)) throw new TrialError('voice: one of the voices of the model');
  return { text: text.trim(), model: refOf(model), voice };
}
