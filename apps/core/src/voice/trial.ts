import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { ModelCatalog, Roles } from '@arianna/config';

/**
 * The voice trial page (D-066): the candidates of the catalog for hearing
 * (`stt`) and speaking (`tts`), which of them are on disk and which hold the
 * role now. The request checks are pure: the page sends only audio, text and
 * a model id; the core picks the models and the reference voice.
 */
export const STT_FAMILIES = ['parakeet', 'whisper'] as const;
export const TTS_FAMILIES = ['kokoro', 'chatterbox'] as const;
export type TrialKind = 'stt' | 'tts';

export interface TrialModel {
  id: string;
  family: string;
  kind: TrialKind;
  /** Every file of the catalog entry is in data/models with the right size. */
  present: boolean;
  /** Assigned to the role in [roles] of arianna.toml. */
  assigned: boolean;
  sizeBytes: number;
  /** Kokoro: the voices among its files. */
  voices: string[];
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

const VOICE_FILE = /^voices\/([a-z]{2}_[a-z0-9]{1,32})\.safetensors$/;

export function trialModels(catalog: ModelCatalog, roles: Roles, modelsDir: string, size: FileSize = fileSize): TrialModel[] {
  const out: TrialModel[] = [];
  for (const entry of catalog.models) {
    const kind = entry.roles.includes('stt') ? 'stt' : entry.roles.includes('tts') ? 'tts' : undefined;
    if (kind === undefined) continue;
    const families: readonly string[] = kind === 'stt' ? STT_FAMILIES : TTS_FAMILIES;
    // Only the families apps/voice knows how to run.
    if (!families.includes(entry.family)) continue;
    out.push({
      id: entry.id,
      family: entry.family,
      kind,
      present: entry.files.every((file) => size(join(modelsDir, entry.id, file.path)) === file.sizeBytes),
      assigned: roles[kind] === entry.id,
      sizeBytes: entry.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      voices: entry.files.flatMap((file) => VOICE_FILE.exec(file.path)?.[1] ?? []),
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
  model: { id: string; family: string };
  voice: string;
  reference?: { id: string; family: string };
}

/** One candidate speaks; Chatterbox clones the chosen Kokoro voice. */
export function speakCall(body: Record<string, unknown>, models: readonly TrialModel[]): SpeakCall {
  only(body, ['text', 'model', 'voice']);
  const { text, model: id, voice } = body;
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TRIAL_TEXT) throw new TrialError(`text: 1 to ${String(MAX_TRIAL_TEXT)} characters`);
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new TrialError('text: control characters are not allowed');
  const model = models.find((candidate) => candidate.kind === 'tts' && candidate.id === id);
  if (model === undefined) throw new TrialError('model: not a text-to-speech candidate of the catalog');
  if (!model.present) throw new TrialError('model: not on disk: pnpm arianna:models pull --trial');
  const kokoro = models.find((candidate) => candidate.family === 'kokoro' && candidate.present);
  if (typeof voice !== 'string' || kokoro === undefined || !kokoro.voices.includes(voice)) throw new TrialError('voice: one of the Kokoro voices on disk');
  const call: SpeakCall = { text: text.trim(), model: { id: model.id, family: model.family }, voice };
  if (model.family === 'chatterbox') call.reference = { id: kokoro.id, family: kokoro.family };
  return call;
}
