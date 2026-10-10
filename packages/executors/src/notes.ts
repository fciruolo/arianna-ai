// The notes of a project the Coder may read (I-11, tappa P3, D-166): a
// read-only copy, for one run, of the notes the gateway let out towards that
// executor. The container itself stays closed to the run (its folders are
// denied whole, `workspaceContainer`); the copy holds only what passed, so a
// private note beside an internal one, or one written during the run, is not
// there to be read. Nothing here reads the container: the core gives the
// texts, each one an `allow` of the gateway logged in gateway_log.
import { chmod, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { checkCoderNote, isAtMost, maxLabel, spendAllowed, type Label } from '@arianna/policy';

import { notesPath, removeNotesFolder, WORKTREES_DIR, WorkspaceError, type WorkspaceOptions } from './workspace.ts';

/** The cloud executors a copy can be made for: the one the gateway allowed. */
export type NotesExecutor = 'claude' | 'codex';

/** At most this many notes, and this many bytes in all, in one copy. */
export const MAX_CODER_NOTES = 50;
export const MAX_CODER_NOTES_BYTES = 512 * 1024;

export interface ProjectNoteInput {
  /** Relative to where the project's knowledge lives, as `checkCoderNote` takes it. */
  path: string;
  /** The `allow` of the gateway for this note's text alone, towards `executor` (`passGateway`); spent here. */
  decision: unknown;
}

export interface PrepareNotesOptions extends WorkspaceOptions {
  executor: NotesExecutor;
  notes: readonly ProjectNoteInput[];
}

/** A copy ready for a run: what the brief may tell the Coder about it. */
export interface PreparedNotes {
  /** Absolute folder of the copy. */
  readonly path: string;
  /** The notes in it, relative to the copy, in order. */
  readonly files: readonly string[];
  /** The highest label among them: at most L1. */
  readonly label: Label;
}

// Copies made here, and only these, can be given to a run: a literal object could name any folder.
const made = new WeakMap<PreparedNotes, { path: string; executor: NotesExecutor }>();

/** The real folder and the executor of a copy `prepareProjectNotes` made; undefined for anything else. */
export function preparedNotes(notes: unknown): { path: string; executor: NotesExecutor } | undefined {
  return typeof notes === 'object' && notes !== null ? made.get(notes as PreparedNotes) : undefined;
}

/**
 * Writes the copy into `data/worktrees/<runId>.notes`: every note checked
 * again (`checkCoderNote`: a plain markdown path, no instruction file, at most
 * L1), every decision spent once and only if it is an `allow` towards this
 * executor, in the cloud, of one text; then each text is written exactly as
 * the gateway let it out. Files 0400, folders 0500: the copy is read only.
 * Throws, and leaves nothing, when one note does not hold; a folder that
 * already exists belongs to another run and is never touched.
 */
export async function prepareProjectNotes(options: PrepareNotesOptions): Promise<PreparedNotes> {
  // Types do not hold at runtime.
  const executor: unknown = options.executor;
  if (executor !== 'claude' && executor !== 'codex') throw new WorkspaceError('notes: unknown executor');
  const list: unknown = options.notes;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CODER_NOTES) throw new WorkspaceError(`notes: between 1 and ${String(MAX_CODER_NOTES)} notes`);
  const notes = list as ProjectNoteInput[];
  const seen = new Set<string>();
  for (const note of notes) {
    if (checkCoderNote({ path: note.path, label: 'L0' }).decision !== 'allow') throw new WorkspaceError('notes: a note is not a plain markdown path of a management folder');
    // One name per note on a case-insensitive disk too.
    const key = note.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new WorkspaceError('notes: a note is listed twice');
    seen.add(key);
  }
  const texts: { path: string; text: string; label: Label }[] = [];
  let bytes = 0;
  for (const note of notes) {
    const allowed = spendAllowed(note.decision);
    if (allowed?.target.kind !== 'executor' || allowed.target.id !== options.executor || allowed.target.locality !== 'cloud') {
      throw new WorkspaceError(`notes: a note is not a logged gateway decision that allows ${options.executor}`);
    }
    const [text] = allowed.texts;
    if (allowed.texts.length !== 1 || text === undefined || !isAtMost(allowed.label, 'L1') || checkCoderNote({ path: note.path, label: allowed.label }).decision !== 'allow') {
      throw new WorkspaceError('notes: a note is above what the Coder may read');
    }
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_CODER_NOTES_BYTES) throw new WorkspaceError('notes: too many bytes');
    texts.push({ path: note.path, text, label: allowed.label });
  }

  const folder = notesPath(options);
  await mkdir(join(options.data, WORKTREES_DIR), { recursive: true });
  try {
    await mkdir(folder, { mode: 0o700 });
  } catch {
    throw new WorkspaceError(`notes of ${options.runId} already exist`);
  }
  try {
    const folders = new Set<string>([folder]);
    for (const note of texts) {
      const file = join(folder, ...note.path.split('/'));
      for (let dir = dirname(file); dir !== folder && !folders.has(dir); dir = dirname(dir)) folders.add(dir);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      // `wx`: never over a file, never through a link (the folder is new and ours).
      await writeFile(file, note.text, { flag: 'wx', mode: 0o400 });
    }
    // Deepest first: a folder made read only cannot take its subfolders' change of mode after.
    for (const dir of [...folders].sort((a, b) => b.length - a.length)) await chmod(dir, 0o500);
    // The sandbox rules name real folders (`/var` is `/private/var` on macOS).
    const real = await realpath(folder);
    if (!(await stat(real)).isDirectory()) throw new WorkspaceError('notes: the copy is not a folder');
    const prepared: PreparedNotes = Object.freeze({
      path: real,
      files: Object.freeze(texts.map((note) => note.path)),
      label: maxLabel(...texts.map((note) => note.label)),
    });
    made.set(prepared, { path: real, executor: options.executor });
    return prepared;
  } catch (error) {
    await removeNotesFolder(folder).catch(() => undefined);
    throw error;
  }
}

/** Removes the copy of a run (also done by `removeWorkspace`). */
export async function removeProjectNotes(options: WorkspaceOptions): Promise<void> {
  await removeNotesFolder(notesPath(options));
}
