import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Project } from '@arianna/config';
import { DeckError, parseDeck, writePptx, type Deck } from '@arianna/pptx';
import { knownSecrets } from '@arianna/vault';

import { approvedRoot, DelegationFileError, isSecretPath, readProjectBytesAt, shownText } from './delegation-view.ts';
import type { NewEvent } from './events.ts';

/**
 * The Studio of design (I-19, D-184): the mockups of an approved project, read,
 * changed in place and exported as PowerPoint. Contract in docs/STUDIO-API.md.
 * Only `.html` files directly inside the mockup folder of the project, with
 * the checks of the delegation files (D-082, D-117, D-135): no hidden file, no
 * link, no `.git`, no secret path, no value of the vault, 2 MiB at most.
 * Events carry project, path, sha256, sizes and counts: never the text.
 */

/** Largest mockup the Studio reads or writes. */
export const MAX_MOCKUP_BYTES = 2 * 1024 * 1024;
/** Mockups listed at most: each is read to give its sha256. */
export const MAX_MOCKUPS = 300;

export type StudioErrorCode = 'invalid' | 'refused' | 'not-found' | 'changed' | 'too-large';

export class StudioError extends Error {
  override name = 'StudioError';
  readonly code: StudioErrorCode;
  /** The current sha256 of the file, with `changed`. */
  readonly sha256: string | undefined;

  constructor(code: StudioErrorCode, message: string, sha256?: string) {
    super(message);
    this.code = code;
    this.sha256 = sha256;
  }
}

export const STUDIO_STATUS: Readonly<Record<StudioErrorCode, number>> = { invalid: 400, refused: 403, 'not-found': 404, changed: 409, 'too-large': 413 };

export interface Mockup {
  path: string;
  name: string;
  group: string;
  variant: number | null;
  bytes: number;
  /** ISO 8601. */
  modified: string;
  sha256: string;
  /** Style and skills of the Designer's run that wrote it, from the register next to the mockups (D-185); absent: not known. */
  design?: VariantDesign;
}

/** The style (a slug of Open Design, or null: none) and the skills a variant was written with. */
export interface VariantDesign {
  style: string | null;
  skills: string[];
  /** ISO 8601: when the run that wrote it ended. */
  at: string;
}

/** How a checked deck is read and written: `@arianna/pptx`, a fake in the tests. */
export interface PptxCodec {
  parse(raw: unknown): Deck;
  write(deck: Deck): Buffer | Uint8Array | Promise<Buffer | Uint8Array>;
}

export const PPTX_CODEC: PptxCodec = { parse: parseDeck, write: writePptx };

export const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export interface StudioDeps {
  /** The approved projects (D-058), read at each call. */
  projects: () => readonly Project[];
  /** Writes an event in the log (events.ts). */
  record: (event: NewEvent) => Promise<unknown>;
  pptx?: PptxCodec;
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A DelegationFileError said with the codes of the contract. */
function asStudioError(error: unknown): unknown {
  if (!(error instanceof DelegationFileError)) return error;
  switch (error.code) {
    case 'not-found':
    case 'deleted':
    case 'not-approved':
      return new StudioError('not-found', error.message);
    case 'too-large':
      return new StudioError('too-large', 'the mockup is larger than 2 MiB');
    case 'binary':
      return new StudioError('invalid', error.message);
    default:
      return new StudioError('refused', error.message);
  }
}

async function studied<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asStudioError(error);
  }
}

/** The folder and the label of an approved project: 404 when it is not one. */
async function projectRoot(deps: StudioDeps, name: string): Promise<{ root: string; project: Project }> {
  const projects = deps.projects();
  const project = projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new StudioError('not-found', 'no such project');
  return { root: await approvedRoot(projects, name), project };
}

const isDirectory = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined))?.isDirectory() === true;
const isFile = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined))?.isFile() === true;

/** `docs/mockups` in the repository of Arianna (docs/DECISIONS.md and apps/hud/), `mockups` elsewhere: as agents/designer.md. */
export async function mockupFolder(root: string): Promise<'docs/mockups' | 'mockups'> {
  return (await isFile(join(root, 'docs', 'DECISIONS.md'))) && (await isDirectory(join(root, 'apps', 'hud'))) ? 'docs/mockups' : 'mockups';
}

/** A file name the Studio reads: visible, `.html`, no separator, not a secret. */
function mockupName(name: string): boolean {
  return /^[^/\\\0]+\.html$/i.test(name) && !name.startsWith('.') && !isSecretPath(name);
}

/** `landing-2.html` → `landing`, 2; `landing.html` → `landing`, null. */
export function groupOf(name: string): { group: string; variant: number | null } {
  const base = name.replace(/\.html$/i, '');
  const match = /^(.*?[^\d\s_-])[\s_-]*(\d{1,9})$/.exec(base);
  if (match?.[1] === undefined || match[2] === undefined) return { group: base, variant: null };
  return { group: match[1], variant: Number(match[2]) };
}

/** The folder of the mockups as it is: undefined when it is not there; refused when it is a link. */
async function folderState(root: string, folder: string): Promise<'missing' | 'ok'> {
  const absolute = join(root, folder);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return 'missing';
  }
  if (real !== absolute || !(await isDirectory(absolute))) throw new StudioError('refused', 'the folder of the mockups is not a plain folder of the project');
  return 'ok';
}

/** A requested path, checked: `<folder>/<name>.html` and nothing else. */
function checkedPath(folder: string, path: unknown): { path: string; name: string } {
  if (typeof path !== 'string' || path.length > 1024) throw new StudioError('invalid', 'path must be a mockup of the folder');
  const prefix = `${folder}/`;
  if (!path.startsWith(prefix)) throw new StudioError('refused', 'only the mockups of the folder are read');
  const name = path.slice(prefix.length);
  if (!mockupName(name)) throw new StudioError('refused', 'only the .html files directly inside the folder are read');
  return { path, name };
}

/** The bytes of a mockup with every check: exactly that file, no link on the way. */
async function readMockupBytes(root: string, path: string): Promise<Buffer> {
  const { bytes, real } = await readProjectBytesAt(root, path, MAX_MOCKUP_BYTES, true);
  // A link, even one that stays in the project, is not a mockup: the Studio would write past it.
  if (real !== path) throw new StudioError('refused', 'a link is not a mockup');
  if (isSecretPath(real)) throw new StudioError('refused', 'a file that may hold a secret is not read');
  return bytes;
}

/**
 * The register of the variants (I-20, D-185, choice of the user): a JSON
 * file next to the mockups, written by the core (never by the model) when a
 * run of the Designer ends, with the style and skills of each variant it
 * wrote. It travels with the project; a variant without an entry is "not known".
 */
export const REGISTER_NAME = 'varianti.json';
/** Largest register read or written; entries kept at most (the oldest go first). */
export const MAX_REGISTER_BYTES = 256 * 1024;
export const MAX_REGISTER_ENTRIES = 2000;
const DESIGN_SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MAX_VARIANT_SKILLS = 10;

/** An entry of the register as the page may see it, or undefined: the file is the project's, anyone may have edited it. */
function checkedDesign(raw: unknown): VariantDesign | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { style, skills, at } = raw as Record<string, unknown>;
  if (style !== null && (typeof style !== 'string' || !DESIGN_SLUG.test(style))) return undefined;
  if (!Array.isArray(skills) || skills.length > MAX_VARIANT_SKILLS || !skills.every((skill) => typeof skill === 'string' && DESIGN_SLUG.test(skill))) return undefined;
  if (typeof at !== 'string' || at.length > 40 || Number.isNaN(Date.parse(at))) return undefined;
  return { style, skills: [...(skills as string[])], at };
}

/** The register of a folder of mockups: entries by file name; an empty map when it is missing, a link, too large or not ours. */
async function readRegister(root: string, folder: string): Promise<Map<string, VariantDesign> | undefined> {
  const path = join(root, folder, REGISTER_NAME);
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined) return new Map();
  if (!stats.isFile() || stats.size > MAX_REGISTER_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
  } catch {
    return undefined;
  }
  const variants = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).variants : undefined;
  if (typeof variants !== 'object' || variants === null || Array.isArray(variants)) return undefined;
  const entries = new Map<string, VariantDesign>();
  for (const [name, raw] of Object.entries(variants)) {
    const design = checkedDesign(raw);
    if (design !== undefined && mockupName(name)) entries.set(name, design);
  }
  return entries;
}

/**
 * Notes in the register the style and skills of the mockups a run of the
 * Designer wrote (I-20, D-185): the `.html` files directly inside the folder
 * of the mockups among `paths` (relative to `root`), changed since `since`.
 * Never throws: a register that cannot be read or written is left alone.
 */
export async function recordVariantDesign(root: string, paths: readonly string[], design: { style: string | null; skills: readonly string[] }, since: Date, now: Date = new Date()): Promise<string[]> {
  if (root === '') return [];
  try {
    const folder = await mockupFolder(root);
    if ((await folderState(root, folder)) !== 'ok') return [];
    const prefix = `${folder}/`;
    const written: string[] = [];
    for (const path of paths) {
      const name = path.startsWith(prefix) ? path.slice(prefix.length) : '';
      if (!mockupName(name)) continue;
      const stats = await lstat(join(root, path)).catch(() => undefined);
      // Only what this run wrote: a file the user changed before and the run left alone keeps its entry.
      if (stats?.isFile() === true && stats.mtimeMs >= since.getTime() - 1000) written.push(name);
    }
    if (written.length === 0) return [];
    const entry = checkedDesign({ style: design.style, skills: [...design.skills], at: now.toISOString() });
    if (entry === undefined) return [];
    const register = await readRegister(root, folder);
    // A register that is not ours (a link, a broken file) is not replaced.
    if (register === undefined) return [];
    for (const name of written) {
      register.delete(name);
      register.set(name, entry);
    }
    const kept = [...register.entries()].slice(-MAX_REGISTER_ENTRIES);
    const text = `${JSON.stringify({ note: 'Stile e skill di ogni variante, scritti da Arianna alla fine di un lavoro del Designer (D-185).', variants: Object.fromEntries(kept) }, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_REGISTER_BYTES) return [];
    const target = join(root, folder, REGISTER_NAME);
    const temporary = join(root, folder, `.${REGISTER_NAME}.${randomBytes(6).toString('hex')}.studio-tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const existing = await lstat(target).catch(() => undefined);
      if (existing !== undefined && !existing.isFile()) throw new Error('the register is not a plain file');
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return written.map((name) => `${prefix}${name}`);
  } catch {
    return [];
  }
}

/** Where a deleted mockup goes (D-184, choice of the user): a folder inside the mockups, which the list does not show. */
export const RETIRED_FOLDER = 'eliminati';

/** `landing-3.html` and `landing-3~1a2b3c4d.html` (a second deletion of the same name) → `landing`, 3. */
export function retiredGroupOf(name: string): { group: string; variant: number | null } {
  return groupOf(name.replace(/~[0-9a-f]{8}(\.html)$/i, '$1'));
}

/**
 * The highest number each group has ever had, deleted mockups included: a
 * number is never used twice (choice of the user), so a link to
 * `landing-3.html` in an old message never opens a newer page.
 */
async function highestVariants(root: string, folder: string, files: readonly Mockup[]): Promise<Record<string, number>> {
  const highest: Record<string, number> = {};
  const note = (group: string, variant: number | null): void => {
    if (variant !== null && variant > (highest[group] ?? 0)) highest[group] = variant;
  };
  for (const file of files) note(file.group, file.variant);
  const retired = join(root, folder, RETIRED_FOLDER);
  if ((await lstat(retired).catch(() => undefined))?.isDirectory() === true) {
    const entries = await readdir(retired, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 5000)) {
      if (entry.isFile() && mockupName(entry.name)) {
        const { group, variant } = retiredGroupOf(entry.name);
        note(group, variant);
      }
    }
  }
  return highest;
}

export async function listMockups(deps: StudioDeps, project: string): Promise<{ folder: string; files: Mockup[]; highest: Record<string, number> }> {
  return studied(async () => {
    const { root } = await projectRoot(deps, project);
    const folder = await mockupFolder(root);
    if ((await folderState(root, folder)) === 'missing') return { folder, files: [], highest: {} };
    const entries = await readdir(join(root, folder), { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && mockupName(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_MOCKUPS);
    const files: Mockup[] = [];
    for (const name of names) {
      const path = `${folder}/${name}`;
      let bytes: Buffer;
      try {
        bytes = await readMockupBytes(root, path);
      } catch {
        // Too large, swapped for a link, gone: not a mockup the Studio opens.
        continue;
      }
      const stats = await lstat(join(root, path)).catch(() => undefined);
      if (stats === undefined) continue;
      files.push({ path, name, ...groupOf(name), bytes: bytes.length, modified: stats.mtime.toISOString(), sha256: sha256Of(bytes) });
    }
    files.sort((a, b) => (a.group === b.group ? (a.variant ?? -1) - (b.variant ?? -1) || a.name.localeCompare(b.name) : a.group.localeCompare(b.group)));
    const register = (await readRegister(root, folder)) ?? new Map<string, VariantDesign>();
    for (const file of files) {
      const design = register.get(file.name);
      if (design !== undefined) file.design = design;
    }
    return { folder, files, highest: await highestVariants(root, folder, files) };
  });
}

/** A mockup of the project, checked, with its text shown (UTF-8, no value of the vault). */
async function loadMockup(deps: StudioDeps, project: string, rawPath: unknown): Promise<{ root: string; project: Project; path: string; name: string; bytes: Buffer }> {
  const { root, project: found } = await projectRoot(deps, project);
  const folder = await mockupFolder(root);
  const { path, name } = checkedPath(folder, rawPath);
  if ((await folderState(root, folder)) === 'missing') throw new StudioError('not-found', 'no such mockup');
  return { root, project: found, path, name, bytes: await readMockupBytes(root, path) };
}

export async function readMockup(deps: StudioDeps, project: string, rawPath: unknown): Promise<{ path: string; text: string; sha256: string }> {
  return studied(async () => {
    const { path, bytes } = await loadMockup(deps, project, rawPath);
    return { path, text: shownText(bytes), sha256: sha256Of(bytes) };
  });
}

// One write at a time per file, in this process: the second sees the first's sha256.
const writing = new Map<string, Promise<unknown>>();

function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writing.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => undefined);
  writing.set(key, settled);
  void settled.then(() => {
    if (writing.get(key) === settled) writing.delete(key);
  });
  return next;
}

/**
 * Rewrites a mockup that exists (D-184, O6) when its sha256 is still `base`:
 * a temporary file in the same folder, then `rename`. Event `studio.edit`.
 */
export async function writeMockup(deps: StudioDeps, project: string, body: { path: unknown; text: unknown; base: unknown }): Promise<{ path: string; sha256: string }> {
  if (typeof body.text !== 'string') throw new StudioError('invalid', 'text must be a string');
  if (typeof body.base !== 'string' || !/^[0-9a-f]{64}$/.test(body.base)) throw new StudioError('invalid', 'base must be the sha256 read');
  const { text, base } = body;
  const next = Buffer.from(text, 'utf8');
  if (next.length > MAX_MOCKUP_BYTES) throw new StudioError('too-large', 'the mockup is larger than 2 MiB');
  if (text.includes('\0')) throw new StudioError('invalid', 'the text holds a NUL');
  if (knownSecrets.find(text).length > 0) throw new StudioError('refused', 'the text holds a value of the vault');
  return studied(async () => {
    const { root } = await projectRoot(deps, project);
    const target = join(root, checkedPath(await mockupFolder(root), body.path).path);
    return oneAtATime(target, async () => {
      const { project: found, path, name, bytes } = await loadMockup(deps, project, body.path);
      const old = sha256Of(bytes);
      if (old !== base) throw new StudioError('changed', 'the mockup changed since it was read', old);
      const absolute = join(root, path);
      const before = await lstat(absolute);
      const temporary = join(root, path.slice(0, path.length - name.length), `.${name}.${randomBytes(6).toString('hex')}.studio-tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, before.mode & 0o777);
      try {
        try {
          await handle.writeFile(next);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Swapped between the read and now (a link, another file): nothing is replaced.
        const now = await lstat(absolute).catch(() => undefined);
        if (now === undefined || !now.isFile() || now.ino !== before.ino || now.dev !== before.dev) throw new StudioError('changed', 'the mockup changed while it was written', old);
        await rename(temporary, absolute);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      const sha256 = sha256Of(next);
      await deps.record({ kind: 'studio.edit', label: found.label, payload: { project: found.name, path, before: old, after: sha256, bytes: next.length } });
      return { path, sha256 };
    });
  });
}

/**
 * Deletes a mockup from the Studio (D-184, choice of the user) when its
 * sha256 is still `base`: the file moves to `<folder>/eliminati/` (same
 * name; a name already there gets `~<hex>`), out of the list and of the
 * variants, and can be put back by hand. With `permanent` (I-20, D-185:
 * the box of the window, off by default) it is removed for good instead,
 * and `retired` is null. Event `studio.delete`.
 */
export async function deleteMockup(deps: StudioDeps, project: string, body: { path: unknown; base: unknown; permanent?: unknown }): Promise<{ path: string; retired: string | null }> {
  if (typeof body.base !== 'string' || !/^[0-9a-f]{64}$/.test(body.base)) throw new StudioError('invalid', 'base must be the sha256 read');
  if (body.permanent !== undefined && typeof body.permanent !== 'boolean') throw new StudioError('invalid', 'permanent must be true or false');
  const base = body.base;
  const permanent = body.permanent === true;
  return studied(async () => {
    const { root } = await projectRoot(deps, project);
    const folder = await mockupFolder(root);
    const target = join(root, checkedPath(folder, body.path).path);
    return oneAtATime(target, async () => {
      // The file whose bytes are checked is the one moved: same inode before the read and at the move.
      const first = await lstat(target).catch(() => undefined);
      const { project: found, path, name, bytes } = await loadMockup(deps, project, body.path);
      const old = sha256Of(bytes);
      if (old !== base) throw new StudioError('changed', 'the mockup changed since it was read', old);
      if (permanent) {
        const absolute = join(root, path);
        const now = await lstat(absolute).catch(() => undefined);
        if (first === undefined || now === undefined || !now.isFile() || now.ino !== first.ino || now.dev !== first.dev) {
          throw new StudioError('changed', 'the mockup changed while it was deleted', old);
        }
        await unlink(absolute);
        await deps.record({ kind: 'studio.delete', label: found.label, payload: { project: found.name, path, retired: null, permanent: true, sha256: old } });
        return { path, retired: null };
      }
      const retiredFolder = `${folder}/${RETIRED_FOLDER}`;
      await mkdir(join(root, retiredFolder), { mode: 0o755 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      // A link in place of the folder would move the file out of the project.
      if ((await folderState(root, retiredFolder)) !== 'ok') throw new StudioError('refused', 'the folder of the deleted mockups is not a plain folder');
      const absolute = join(root, path);
      const now = await lstat(absolute).catch(() => undefined);
      if (first === undefined || now === undefined || !now.isFile() || now.ino !== first.ino || now.dev !== first.dev) {
        throw new StudioError('changed', 'the mockup changed while it was deleted', old);
      }
      // A hard link never replaces a file: a name already there gets a suffix, and the folder is checked after the link.
      let retired = `${retiredFolder}/${name}`;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await link(absolute, join(root, retired));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 5) throw error;
          retired = `${retiredFolder}/${name.replace(/\.html$/i, '')}~${randomBytes(4).toString('hex')}.html`;
        }
      }
      const placed = await lstat(join(root, retired)).catch(() => undefined);
      const realFolder = await realpath(join(root, retiredFolder)).catch(() => undefined);
      if (realFolder !== join(root, retiredFolder) || placed === undefined || placed.ino !== now.ino || placed.dev !== now.dev) {
        // The folder was swapped for a link meanwhile: the new name goes, the mockup stays where it was.
        if (realFolder === join(root, retiredFolder)) await unlink(join(root, retired)).catch(() => undefined);
        throw new StudioError('refused', 'the folder of the deleted mockups is not a plain folder');
      }
      await unlink(absolute);
      await deps.record({ kind: 'studio.delete', label: found.label, payload: { project: found.name, path, retired, sha256: old } });
      return { path, retired };
    });
  });
}

/** The file name of an export: the mockup's name without `.html`, safe in a header. */
export function pptxFileName(name: string): string {
  return `${name.replace(/\.html$/i, '')}.pptx`;
}

/**
 * The deck of a mockup as a .pptx (D-184, O5): the deck checked by
 * `parseDeck`, written by `writePptx`; nothing written in the project. Event
 * `studio.export` with the number of slides.
 */
export async function exportPptx(deps: StudioDeps, project: string, body: { path: unknown; deck: unknown }): Promise<{ name: string; bytes: Buffer }> {
  return studied(async () => {
    const { project: found, path, name, bytes } = await loadMockup(deps, project, body.path);
    // The same checks as a read: UTF-8, no value of the vault.
    shownText(bytes);
    const codec = deps.pptx ?? PPTX_CODEC;
    let deck: Deck;
    try {
      deck = codec.parse(body.deck);
    } catch (error) {
      if (error instanceof DeckError) throw new StudioError('invalid', error.message);
      throw error;
    }
    const written = await codec.write(deck);
    await deps.record({ kind: 'studio.export', label: found.label, payload: { project: found.name, path, slides: deck.slides.length } });
    return { name: pptxFileName(name), bytes: Buffer.from(written.buffer, written.byteOffset, written.byteLength) };
  });
}
