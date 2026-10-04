import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Voices copied from a sample (D-069): data/voice/voices/<id>/ holds
 * reference.wav (16 kHz mono), reference.txt (what the sample says) and
 * voice.json (the name shown, when, the consent). A voice sample is biometric
 * data: L2, never in git, never to the cloud or the log. Qwen3-TTS Base speaks
 * with it; the request checks are pure.
 */
export const CLONE_FAMILY = 'qwen3-tts-base';
const CLONE_ID = /^[a-z][a-z0-9_]{1,40}$/;
const RATE = 16_000;
export const MIN_CLONE_SECONDS = 5;
export const MAX_CLONE_SECONDS = 30;
const MAX_NAME = 40;
const MAX_TEXT = 600;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** The body of a new voice: 30 s of base64 audio plus the JSON around it. */
export const MAX_CLONE_BODY = Math.ceil((MAX_CLONE_SECONDS * RATE * 2 * 4) / 3) + 4096;

export class CloneError extends Error {
  override name = 'CloneError';
}

export interface Clone {
  id: string;
  name: string;
  createdAt: string;
  seconds: number;
}

export interface NewClone {
  name: string;
  text: string;
  pcm16: Buffer;
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function cleanText(value: unknown, where: string, max: number, newlines: boolean): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new CloneError(`${where}: 1 to ${String(max)} characters`);
  if (CONTROL.test(value) || (!newlines && /[\n\t]/.test(value))) throw new CloneError(`${where}: control characters are not allowed`);
  return value.trim();
}

/** The request of the page: a name, the text the sample says, 5-30 s of 16 kHz samples and the consent. */
export function parseClone(body: Record<string, unknown>): NewClone {
  const unknown = Object.keys(body).filter((key) => !['name', 'text', 'pcm16', 'consent'].includes(key));
  if (unknown.length > 0) throw new CloneError(`unknown field(s): ${unknown.join(', ')}`);
  // The person of the voice agreed: the page asks, the core refuses without it.
  if (body.consent !== true) throw new CloneError('consent: the person of this voice must agree');
  const name = cleanText(body.name, 'name', MAX_NAME, false);
  const text = cleanText(body.text, 'text', MAX_TEXT, true);
  const { pcm16 } = body;
  if (typeof pcm16 !== 'string' || pcm16.length % 4 !== 0 || !BASE64.test(pcm16)) throw new CloneError('pcm16: base64 of 16 kHz 16-bit mono samples');
  const bytes = Buffer.from(pcm16, 'base64');
  const seconds = bytes.length / 2 / RATE;
  if (bytes.length % 2 !== 0 || seconds < MIN_CLONE_SECONDS || seconds > MAX_CLONE_SECONDS) {
    throw new CloneError(`pcm16: between ${String(MIN_CLONE_SECONDS)} and ${String(MAX_CLONE_SECONDS)} seconds`);
  }
  return { name, text, pcm16: bytes };
}

/** An id from the name: lower case letters, digits and underscores, free in `taken`. */
export function cloneId(name: string, taken: readonly string[]): string {
  const ascii = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 30)
    .replace(/_+$/, '');
  const base = ascii.length >= 2 ? ascii : 'voce';
  for (let index = 1; ; index++) {
    const id = index === 1 ? base : `${base}_${String(index)}`;
    if (!taken.includes(id)) return id;
  }
}

/** A 16-bit mono PCM WAV. */
export function encodeWav(pcm16: Buffer, rate: number = RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
}

/** A real folder, never a link: what lstat says. */
function isFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The copied voices on disk, by name; a folder that is not complete is left out. */
export function listClones(dir: string): Clone[] {
  if (!isFolder(dir)) return [];
  const out: Clone[] = [];
  for (const id of readdirSync(dir)) {
    const folder = join(dir, id);
    if (!CLONE_ID.test(id) || !isFolder(folder)) continue;
    try {
      for (const file of ['reference.wav', 'reference.txt', 'voice.json']) if (!lstatSync(join(folder, file)).isFile()) throw new Error('not a file');
      const meta = JSON.parse(readFileSync(join(folder, 'voice.json'), 'utf8')) as Record<string, unknown>;
      if (typeof meta.name !== 'string' || typeof meta.createdAt !== 'string' || typeof meta.seconds !== 'number') continue;
      out.push({ id, name: meta.name, createdAt: meta.createdAt, seconds: meta.seconds });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'it'));
}

/**
 * Removes the half-written voices a crash left (.new-*): samples nobody sees
 * or can delete from the page. Real folders only, never what a link points to.
 */
export function removeLeftovers(dir: string): number {
  if (!isFolder(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.new-') && isFolder(join(dir, name))) {
      rmSync(join(dir, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** Writes a new voice in a private folder, whole or not at all. */
export function saveClone(dir: string, clone: NewClone, now: Date = new Date()): Clone {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // listClones never reads through a link: a voice saved there would never show.
  if (!isFolder(dir)) throw new CloneError('voices folder: not a real folder');
  removeLeftovers(dir);
  const taken = readdirSync(dir);
  const id = cloneId(clone.name, taken);
  const temporary = join(dir, `.new-${id}-${String(process.pid)}`);
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { mode: 0o700 });
  const seconds = Math.round((clone.pcm16.length / 2 / RATE) * 10) / 10;
  const saved: Clone = { id, name: clone.name, createdAt: now.toISOString(), seconds };
  try {
    writeFileSync(join(temporary, 'reference.wav'), encodeWav(clone.pcm16), { mode: 0o600, flag: 'wx' });
    writeFileSync(join(temporary, 'reference.txt'), `${clone.text}\n`, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(temporary, 'voice.json'), `${JSON.stringify({ ...saved, consent: true, label: 'L2' })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(dir, id));
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return saved;
}

/** Removes a voice and its sample from the disk; false when there is none. */
export function deleteClone(dir: string, id: string): boolean {
  if (!CLONE_ID.test(id)) throw new CloneError('id: not a voice');
  const folder = join(dir, id);
  if (!isFolder(folder)) return false;
  rmSync(folder, { recursive: true, force: true });
  return true;
}
