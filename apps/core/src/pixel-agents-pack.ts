// The characters of pixel-agents as a pack of data/characters (D-206): only the
// PNG sheets of its characters and its licence, read from the public API of
// GitHub when the user presses the button of the Agenti page or runs the
// command. Each sheet is decoded and written again from its pixels (as an
// upload, D-118); nothing else of the repository is read or run. The drawings
// are based on JIK-A-4's Metro City: for personal use only, never in git
// (data/ is out of it), to be removed before the folder is shared.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanSheet, MAX_CHARACTERS, MAX_SHEET_BYTES, UploadError, type CharacterDirs } from './characters.ts';
import type { GithubGet } from './github-api.ts';

/** One request to the API of GitHub for each sheet, 60 an hour without an account: a download never asks more than this (D-244). */
const MAX_PIXEL_AGENTS_SHEETS = 50;

export const PIXEL_AGENTS_PACK = 'pixel-agents';
export const PIXEL_AGENTS_REPOSITORY = 'pixel-agents-hq/pixel-agents';
const SHEETS_PATH = 'webview-ui/public/assets/characters';
// No leading zero: char_7 and char_07 would make the same id.
const SHEET_FILE = /^char_(0|[1-9]\d?)\.png$/;
const MAX_LISTING_BYTES = 64 * 1024;
const MAX_LICENSE_BYTES = 32 * 1024;
/** A file of the contents API is its bytes in base64 plus a few fields. */
const MAX_FILE_ANSWER = Math.ceil((MAX_SHEET_BYTES * 4) / 3) + 16 * 1024;
const PACK_SOURCE = `github.com/${PIXEL_AGENTS_REPOSITORY} (licenza nel file LICENSE); disegni basati su JIK-A-4, Metro City: solo per uso personale, da togliere prima di condividere la cartella`;

export class PixelAgentsError extends Error {
  override name = 'PixelAgentsError';
}

export interface PixelAgentsOptions {
  dirs: CharacterDirs;
  get: GithubGet;
  /** The address that leaves, checked by the policy of the gateway (L0); rejects to stop. */
  gateway: (address: string) => Promise<void>;
}

export interface PixelAgentsResult {
  pack: string;
  characters: number;
  /** True when a pack of the same name was there and has been replaced. */
  replaced: boolean;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PixelAgentsError(`${where}: unexpected answer`);
  return value as Record<string, unknown>;
}

/** The bytes of a file of the contents API: base64 with line breaks. */
function fileBytes(value: unknown, max: number, where: string): Buffer {
  const { encoding, content } = record(value, where);
  if (encoding !== 'base64' || typeof content !== 'string') throw new PixelAgentsError(`${where}: unexpected answer`);
  const bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
  if (bytes.length === 0 || bytes.length > max) throw new PixelAgentsError(`${where}: at most ${String(max / 1024)} KiB`);
  return bytes;
}

/** The sheets of the repository, by number: `char_0.png` … */
async function sheetNames(get: GithubGet): Promise<{ name: string; number: number }[]> {
  const listing = await get(`/repos/${PIXEL_AGENTS_REPOSITORY}/contents/${SHEETS_PATH}`, MAX_LISTING_BYTES);
  if (!Array.isArray(listing)) throw new PixelAgentsError('the folder of the characters: unexpected answer');
  const names = listing
    .map((item: unknown) => record(item, 'the folder of the characters'))
    .filter((item) => item.type === 'file' && typeof item.name === 'string' && SHEET_FILE.test(item.name))
    .map((item) => {
      const name = item.name as string;
      return { name, number: Number(SHEET_FILE.exec(name)?.[1]) };
    })
    .sort((a, b) => a.number - b.number);
  if (names.length === 0) throw new PixelAgentsError('no character found in the repository');
  return names.slice(0, Math.min(MAX_CHARACTERS, MAX_PIXEL_AGENTS_SHEETS));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** One download at a time: two at once would swap the same folder. */
let downloads: Promise<unknown> = Promise.resolve();

/**
 * A swap cut in the middle (the core stopped between the two renames) leaves
 * the pack as a hidden `.old` folder: it is put back, then every other hidden
 * folder of a download is removed.
 */
async function recover(data: string, target: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(data);
  } catch {
    return;
  }
  const leftovers = names.filter((name) => name.startsWith(`.${PIXEL_AGENTS_PACK}.`) && (name.endsWith('.tmp') || name.endsWith('.old')));
  const old = leftovers.find((name) => name.endsWith('.old'));
  if (old !== undefined && !(await exists(target))) await rename(join(data, old), target);
  for (const name of leftovers) await rm(join(data, name), { recursive: true, force: true });
}

/**
 * Downloads the sheets and the licence into a hidden folder of
 * data/characters, then swaps it with `pixel-agents`: the page never lists
 * half a pack, and a failed download leaves the previous one as it was.
 * Up to 34 requests to GitHub, which allows 60 an hour without an account.
 */
export function downloadPixelAgents(options: PixelAgentsOptions): Promise<PixelAgentsResult> {
  const run = async (): Promise<PixelAgentsResult> => {
    const { dirs, get, gateway } = options;
    await gateway(`https://github.com/${PIXEL_AGENTS_REPOSITORY}`);
    const names = await sheetNames(get);
    const sheets: { id: string; name: string; file: string; png: Buffer }[] = [];
    for (const { name, number } of names) {
      const raw = fileBytes(await get(`/repos/${PIXEL_AGENTS_REPOSITORY}/contents/${SHEETS_PATH}/${name}`, MAX_FILE_ANSWER), MAX_SHEET_BYTES, name);
      let png: Buffer;
      try {
        ({ png } = cleanSheet(raw));
      } catch (error) {
        if (error instanceof UploadError) throw new PixelAgentsError(`${name}: ${error.message}`);
        throw error;
      }
      sheets.push({ id: `char-${String(number)}`, name: `Personaggio ${String(number + 1)}`, file: `char-${String(number)}.png`, png });
    }
    const license = fileBytes(await get(`/repos/${PIXEL_AGENTS_REPOSITORY}/license`, Math.ceil((MAX_LICENSE_BYTES * 4) / 3) + 16 * 1024), MAX_LICENSE_BYTES, 'LICENSE');

    await mkdir(dirs.data, { recursive: true, mode: 0o700 });
    const target = join(dirs.data, PIXEL_AGENTS_PACK);
    await recover(dirs.data, target);
    const next = join(dirs.data, `.${PIXEL_AGENTS_PACK}.${randomUUID()}.tmp`);
    const old = join(dirs.data, `.${PIXEL_AGENTS_PACK}.${randomUUID()}.old`);
    let replaced: boolean;
    try {
      await mkdir(next, { mode: 0o700 });
      for (const sheet of sheets) await writeFile(join(next, sheet.file), sheet.png, { flag: 'wx', mode: 0o600 });
      await writeFile(join(next, 'LICENSE'), license, { flag: 'wx', mode: 0o600 });
      const manifest = { name: 'pixel-agents', source: PACK_SOURCE, characters: sheets.map(({ id, name, file }) => ({ id, name, file })) };
      await writeFile(join(next, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      replaced = await exists(target);
      if (replaced) await rename(target, old);
      try {
        await rename(next, target);
      } catch (error) {
        // Put the previous pack back; if even that fails, the next download recovers it.
        if (replaced) await rename(old, target).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(next, { recursive: true, force: true }).catch(() => undefined);
    }
    // The pack is in place: a leftover is removed by the next download, never an error now.
    await rm(old, { recursive: true, force: true }).catch(() => undefined);
    return { pack: PIXEL_AGENTS_PACK, characters: sheets.length, replaced };
  };
  const next = downloads.then(run, run);
  downloads = next.catch(() => undefined);
  return next;
}
