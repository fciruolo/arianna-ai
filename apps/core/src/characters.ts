import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CHARACTER_ID, ORIGINAL_PACK, type CharacterChoices } from '@arianna/config';

import { decodePng, encodePng, PngError } from './png.ts';

/**
 * The pixel characters of the web chat (D-060). A pack is a folder: the
 * originals in git (`apps/hud/characters/originali`) and the ones the user
 * copies into `data/characters/<pack>/`, each a pack.json and PNG sheets in
 * the format of pixel-agents (112×96, or 112×128 with Arianna's fourth row).
 * The core only reads them, and checks every file before serving it: a
 * folder or a file that does not pass is left out, never half-used.
 */
export interface CharacterDirs {
  /** The pack of the originals, in git. */
  original: string;
  /** `data/characters`: may be missing. */
  data: string;
}

export interface CharacterInfo {
  id: string;
  name: string;
  /** 3 rows (down, up, right) or 4 with think, wait and pause. */
  rows: 3 | 4;
}

export interface CharacterPack {
  id: string;
  name: string;
  /** Free text from pack.json: where the user got it. */
  source: string;
  original: boolean;
  characters: CharacterInfo[];
}

export interface PackListing {
  packs: CharacterPack[];
  /** Folders of data/characters left out, with the reason (no content). */
  refused: { pack: string; reason: string }[];
}

const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_SHEET_BYTES = 256 * 1024;
const MAX_CHARACTERS = 32;
const MAX_PACKS = 64;
const SHEET_WIDTH = 112;
const SHEET_HEIGHTS: Readonly<Record<number, 3 | 4>> = { 96: 3, 128: 4 };
const FILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class PackError extends Error {
  override name = 'PackError';
}

/**
 * Reads a regular file up to `max` bytes; longer is an error. Never through a
 * link: O_NOFOLLOW refuses one at open, and the checks are made on the open
 * handle, so a file swapped for a link after a check is not followed.
 */
async function readSmall(path: string, max: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOOP') throw new PackError('not a regular file');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new PackError('not a regular file');
    if (info.size > max) throw new PackError('file too large');
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, max + 1, 0);
    if (bytesRead > max) throw new PackError('file too large');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The number of rows of a sheet, from its PNG header; throws when it is not a sheet. */
export function sheetRows(png: Buffer): 3 | 4 {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new PackError('not a PNG');
  }
  const width = png.readUInt32BE(16);
  const rows = SHEET_HEIGHTS[png.readUInt32BE(20)];
  if (width !== SHEET_WIDTH || rows === undefined) throw new PackError('a sheet is 112×96 or 112×128');
  return rows;
}

function text(value: unknown, max: number, where: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new PackError(`${where}: text of 1-${String(max)} characters`);
  return value.trim();
}

interface Manifest {
  name: string;
  source: string;
  characters: { id: string; name: string; file: string }[];
}

function parseManifest(raw: Buffer): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PackError('pack.json is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PackError('pack.json: expected an object');
  const record = value as Record<string, unknown>;
  const list = record.characters;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CHARACTERS) {
    throw new PackError(`pack.json: characters is a list of 1-${String(MAX_CHARACTERS)}`);
  }
  const characters = list.map((item: unknown, index) => {
    const where = `characters[${String(index)}]`;
    if (typeof item !== 'object' || item === null) throw new PackError(`${where}: expected an object`);
    const { id, name, file } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !CHARACTER_ID.test(id)) throw new PackError(`${where}.id: lowercase letters, digits, - and _`);
    if (typeof file !== 'string' || !FILE_NAME.test(file)) throw new PackError(`${where}.file: a .png name in the pack folder`);
    return { id, name: text(name, 40, `${where}.name`), file };
  });
  if (new Set(characters.map(({ id }) => id)).size !== characters.length) throw new PackError('pack.json: an id is listed twice');
  return {
    name: text(record.name, 60, 'name'),
    source: record.source === undefined ? '' : text(record.source, 300, 'source'),
    characters,
  };
}

/**
 * The real folder of a pack. A folder of data/characters must be a folder
 * right there, never a link, and its real path must be the expected one: the
 * files are then opened inside that real path.
 */
async function packDir(dirs: CharacterDirs, id: string): Promise<string> {
  if (id === ORIGINAL_PACK) return realpath(dirs.original);
  const dir = join(dirs.data, id);
  if (!(await lstat(dir)).isDirectory()) throw new PackError('not a folder');
  const real = await realpath(dir);
  if (real !== join(await realpath(dirs.data), id)) throw new PackError('not a folder');
  return real;
}

async function readManifest(dir: string): Promise<Manifest> {
  return parseManifest(await readSmall(join(dir, 'pack.json'), MAX_MANIFEST_BYTES));
}

async function readPack(dirs: CharacterDirs, id: string): Promise<CharacterPack> {
  const dir = await packDir(dirs, id);
  const manifest = await readManifest(dir);
  const characters: CharacterInfo[] = [];
  for (const entry of manifest.characters) {
    characters.push({ id: entry.id, name: entry.name, rows: sheetRows(await readSmall(join(dir, entry.file), MAX_SHEET_BYTES)) });
  }
  return { id, name: manifest.name, source: manifest.source, original: id === ORIGINAL_PACK, characters };
}

function reasonOf(error: unknown): string {
  if (error instanceof PackError) return error.message;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return code === 'ENOENT' ? 'pack.json or a sheet is missing' : 'unreadable';
}

/** Every pack that passes the checks; read again at each call, since the user copies folders by hand. */
export async function listPacks(dirs: CharacterDirs): Promise<PackListing> {
  const refused: PackListing['refused'] = [];
  const packs: CharacterPack[] = [];
  // The originals are in git: if they cannot be read the packs of data/ are still listed.
  try {
    packs.push(await readPack(dirs, ORIGINAL_PACK));
  } catch (error) {
    refused.push({ pack: ORIGINAL_PACK, reason: reasonOf(error) });
  }

  let names: string[] = [];
  try {
    const entries = await readdir(dirs.data, { withFileTypes: true });
    names = entries.filter((entry) => !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  } catch {
    // No data/characters yet: the originals only.
  }
  for (const name of names.slice(0, MAX_PACKS)) {
    if (!CHARACTER_ID.test(name) || name === ORIGINAL_PACK) {
      refused.push({ pack: name, reason: name === ORIGINAL_PACK ? 'the name of the originals is taken' : 'folder name: lowercase letters, digits, - and _' });
      continue;
    }
    try {
      packs.push(await readPack(dirs, name));
    } catch (error) {
      refused.push({ pack: name, reason: reasonOf(error) });
    }
  }
  if (names.length > MAX_PACKS) refused.push({ pack: names.slice(MAX_PACKS).join(', '), reason: `more than ${String(MAX_PACKS)} packs` });
  return { packs, refused };
}

/**
 * The PNG of one character, checked again: the pack folder, its pack.json
 * and that sheet only. Undefined when the pack or the character is not served.
 */
export async function readSheet(dirs: CharacterDirs, pack: string, character: string): Promise<Buffer | undefined> {
  if (!CHARACTER_ID.test(pack) || !CHARACTER_ID.test(character)) return undefined;
  try {
    const dir = await packDir(dirs, pack);
    const entry = (await readManifest(dir)).characters.find((item) => item.id === character);
    if (entry === undefined) return undefined;
    const png = await readSmall(join(dir, entry.file), MAX_SHEET_BYTES);
    sheetRows(png);
    return png;
  } catch {
    return undefined;
  }
}

/**
 * The character each agent wears: the user's choice when its pack and
 * character are served, otherwise the original of the same name, otherwise
 * the Coder's.
 */
export function assignCharacters(
  agents: readonly string[],
  choices: CharacterChoices,
  packs: readonly CharacterPack[],
): Record<string, { pack: string; character: string; rows: 3 | 4 }> {
  const find = (pack: string, character: string) =>
    packs.find((entry) => entry.id === pack)?.characters.find((entry) => entry.id === character);
  const result: Record<string, { pack: string; character: string; rows: 3 | 4 }> = {};
  for (const agent of agents) {
    const [pack = '', character = ''] = (choices[agent] ?? '').split('/');
    const candidates: [string, string][] = [[pack, character], [ORIGINAL_PACK, agent], [ORIGINAL_PACK, 'coder']];
    for (const [packId, characterId] of candidates) {
      const found = find(packId, characterId);
      if (found !== undefined) {
        result[agent] = { pack: packId, character: characterId, rows: found.rows };
        break;
      }
    }
  }
  return result;
}

/** The pack of data/characters where the sheets uploaded from the chat go (D-118); never `originali`. */
export const USER_PACK = 'miei';
const USER_PACK_MANIFEST = { name: 'Miei', source: 'Caricati dalla pagina Agenti (D-118)' };
const MAX_NAME = 40;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** The JSON body of an upload: a sheet in base64 plus the name. */
export const MAX_UPLOAD_BODY = Math.ceil((MAX_SHEET_BYTES * 4) / 3) + 4096;

export class UploadError extends Error {
  override name = 'UploadError';
  readonly code: 'invalid' | 'conflict' | 'pack' | 'full' | 'taken';
  /** The character of the same id already in the pack: the page asks before replacing it. */
  readonly existing: { id: string; name: string } | undefined;

  constructor(code: UploadError['code'], message: string, existing?: { id: string; name: string }) {
    super(message);
    this.code = code;
    this.existing = existing;
  }
}

export interface UploadRequest {
  name: string;
  /** The file as uploaded: decoded, checked and written again before it is saved. */
  png: Buffer;
  /** Replace a character of the same id: only after the user confirmed it. */
  replace: boolean;
}

export interface UploadResult {
  pack: string;
  character: string;
  name: string;
  rows: 3 | 4;
  replaced: boolean;
}

/** The id of a character from its name: lower case ascii letters, digits and dashes. */
export function characterId(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_NAME)
    .replace(/-+$/, '');
}

/** `{ name, png, replace? }`, `png` in base64: checked here, the image itself in `uploadSheet`. */
export function parseUpload(body: Record<string, unknown>): UploadRequest {
  const unknown = Object.keys(body).filter((key) => !['name', 'png', 'replace'].includes(key));
  if (unknown.length > 0) throw new UploadError('invalid', `unknown field(s): ${unknown.join(', ')}`);
  const { name, png, replace } = body;
  if (typeof name !== 'string' || name.trim() === '' || name.trim().length > MAX_NAME || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new UploadError('invalid', `name: one line of 1-${String(MAX_NAME)} characters`);
  }
  if (characterId(name) === '') throw new UploadError('invalid', 'name: at least a letter or a digit');
  if (replace !== undefined && typeof replace !== 'boolean') throw new UploadError('invalid', 'replace: true or false');
  if (typeof png !== 'string' || png.length === 0 || png.length % 4 !== 0 || !BASE64.test(png)) throw new UploadError('invalid', 'png: the file in base64');
  const bytes = Buffer.from(png, 'base64');
  if (bytes.length > MAX_SHEET_BYTES) throw new UploadError('invalid', `png: at most ${String(MAX_SHEET_BYTES / 1024)} KiB`);
  return { name: name.trim(), png: bytes, replace: replace === true };
}

/**
 * The sheet decoded and written again from its pixels only (D-118): a PNG of
 * 112×96 or 112×128 and nothing else of the file, no metadata, no chunk the
 * standard does not know. Throws UploadError with the reason.
 */
export function cleanSheet(png: Buffer): { png: Buffer; rows: 3 | 4 } {
  let image;
  try {
    image = decodePng(png, 128);
  } catch (error) {
    if (error instanceof PngError) throw new UploadError('invalid', error.message.includes('pixels per side') ? 'a sheet is 112×96 or 112×128' : error.message);
    throw error;
  }
  const rows = SHEET_HEIGHTS[image.height];
  if (image.width !== SHEET_WIDTH || rows === undefined) throw new UploadError('invalid', 'a sheet is 112×96 or 112×128');
  return { png: encodePng(image), rows };
}

/** Writes `content` next to `target` under a hidden name, then renames it over: a reader never sees half a file. */
async function writeAtomically(dir: string, file: string, content: Buffer | string): Promise<void> {
  const temporary = join(dir, `.${file}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(dir, file));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The folder of the user's pack, made when missing; never through a link. */
async function userPackDir(dirs: CharacterDirs): Promise<string> {
  await mkdir(dirs.data, { recursive: true, mode: 0o700 });
  try {
    await mkdir(join(dirs.data, USER_PACK), { mode: 0o700 });
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  try {
    return await packDir(dirs, USER_PACK);
  } catch (error) {
    throw new UploadError('pack', `data/characters/${USER_PACK} ${reasonOf(error)}`);
  }
}

/** One upload at a time: two at once would both read pack.json and one would lose its line. */
let uploads: Promise<unknown> = Promise.resolve();

/**
 * Saves an uploaded sheet in the pack `miei` of data/characters (D-118), with
 * an id made from the name. A character of the same id is replaced only with
 * `replace`; otherwise UploadError `conflict` names it, and the page asks.
 */
export function uploadSheet(dirs: CharacterDirs, request: UploadRequest): Promise<UploadResult> {
  const run = async (): Promise<UploadResult> => {
    const { png, rows } = cleanSheet(request.png);
    const id = characterId(request.name);
    const dir = await userPackDir(dirs);
    let manifest: Manifest;
    try {
      manifest = await readManifest(dir);
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
        throw new UploadError('pack', `data/characters/${USER_PACK}: ${reasonOf(error)}; fix it or move it away`);
      }
      manifest = { ...USER_PACK_MANIFEST, characters: [] };
    }
    const existing = manifest.characters.find((entry) => entry.id === id);
    // A replacement writes over the file the pack names: no sheet left behind.
    const file = existing?.file ?? `${id}.png`;
    if (existing !== undefined && !request.replace) {
      throw new UploadError('conflict', `a character "${existing.name}" (${id}) is already in the pack ${USER_PACK}`, { id, name: existing.name });
    }
    if (manifest.characters.some((entry) => entry.id !== id && entry.file === file)) throw new UploadError('taken', `${file} belongs to another character of the pack`);
    if (existing === undefined && manifest.characters.length >= MAX_CHARACTERS) throw new UploadError('full', `the pack ${USER_PACK} holds at most ${String(MAX_CHARACTERS)} characters`);

    const entry = { id, name: request.name, file };
    const characters = existing === undefined ? [...manifest.characters, entry] : manifest.characters.map((item) => (item.id === id ? entry : item));
    await writeAtomically(dir, file, png);
    await writeAtomically(dir, 'pack.json', `${JSON.stringify({ name: manifest.name, source: manifest.source === '' ? undefined : manifest.source, characters }, null, 2)}\n`);
    return { pack: USER_PACK, character: id, name: request.name, rows, replaced: existing !== undefined };
  };
  const next = uploads.then(run, run);
  uploads = next.catch(() => undefined);
  return next;
}
