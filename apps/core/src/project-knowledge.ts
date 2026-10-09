import { closeSync, constants, lstatSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isFolderName, managementFolders, type ManagementFolder, type Project } from '@arianna/config';
import { createLabelRules, isAtMost, isLabel, labelForKbPage, labelForPath, LABELS, maxLabel, type Label, type LabelRules } from '@arianna/policy';

import { localTimestamp, slugOf } from './capture.ts';
import { parsePage, type KbPage } from './orchestrator/kb.ts';

/**
 * The knowledge of a project (I-11, D-145, tappa P2): the management folders
 * of its container (Workplan, IM, documenti...) and the notes in them, read
 * and written only on this computer. Each folder has a label, by its name or
 * as the user chose it in `[[project.folder]]`; each note the higher of its
 * folder's and of its own header (`labels.toml` rule: a header raises, never
 * lowers). Nothing here goes to an executor or a channel: the Coder does not
 * see the container until P3.
 */

/** Where a page of a project lives for the tools of Arianna: `projects/<project>/<folder>/<file>.md`. */
export const PROJECT_PAGES = 'projects';

const MAX_DEPTH = 6;
const MAX_NOTES = 2_000;
/** The header is at the top: what is read to label a note that is only listed. */
const HEADER_BYTES = 8 * 1024;
const MAX_NOTE_BYTES = 200_000;
export const MAX_NOTE_TEXT = 64 * 1024;
const MAX_TITLE = 200;
const MAX_ATTEMPTS = 50;

export type KnowledgeErrorCode = 'invalid' | 'not-found' | 'refused' | 'too-large' | 'unavailable';

/** Messages name fixed reasons and folder names, never the text of a note. */
export class KnowledgeError extends Error {
  override name = 'KnowledgeError';
  readonly code: KnowledgeErrorCode;

  constructor(code: KnowledgeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A note as the tab "Conoscenza" lists it: relative to the container, with its effective label. */
export interface KnowledgeNote {
  folder: string;
  path: string;
  title: string;
  label: Label;
}

export interface ProjectKnowledge {
  /** True when the container is itself the part (one git): its notes sit inside the Coder's folder. */
  single: boolean;
  folders: ManagementFolder[];
  notes: KnowledgeNote[];
  /** Notes left out past MAX_NOTES. */
  more: number;
}

/** The project by name among the approved ones, its container exactly its path on disk (no link). */
export function containerOf(projects: readonly Project[], name: string): { project: Project; root: string } {
  const project = projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new KnowledgeError('not-found', `the project ${name} is not among the approved projects`);
  let root: string;
  try {
    root = realpathSync(project.absolute);
  } catch {
    throw new KnowledgeError('not-found', `the folder of ${name} does not exist`);
  }
  if (root !== project.absolute || !lstatSync(root).isDirectory()) throw new KnowledgeError('refused', `the folder of ${name} is not the approved path`);
  return { project, root };
}

/** The label rules of a container: one per management folder, paths relative to the container; anything else L2. */
export function knowledgeRules(folders: readonly ManagementFolder[]): LabelRules {
  // `Docs` and `docs` on a case-sensitive disk: the rules take one per name ignoring case, with the higher label of the two.
  const unique = new Map<string, { path: string; label: Label }>();
  for (const { path, label } of folders) {
    const key = path.toUpperCase().toLowerCase();
    const found = unique.get(key);
    unique.set(key, found === undefined ? { path, label } : { path: found.path, label: maxLabel(found.label, label) });
  }
  return createLabelRules({ folders: [...unique.values()], sources: [] });
}

/** The label of a page from its folder rule and its header lines, as `kb.read` does: the header raises, never lowers. */
function pageLabel(rules: LabelRules, path: string, labels: readonly string[]): Label {
  if (labels.length === 0) return labelForPath(rules, path);
  return maxLabel(...labels.map((declared) => labelForKbPage(rules, path, declared)));
}

/** The first bytes of a regular file, never through a link. */
function readHead(file: string, bytes: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Every file under the management folders, relative to the container: no
 * link followed (a link is listed as a file of its folder), at most MAX_DEPTH
 * folders down. Hidden entries are not listed in the tab nor searched; with
 * `strict` (the check that keeps the Coder out) they count too, and a folder
 * too deep or that cannot be read is reported to `unreadable`: what is not
 * seen cannot be said to be at most L1.
 */
function walk(
  root: string,
  folders: readonly ManagementFolder[],
  visit: (path: string, folder: string, link: boolean) => boolean,
  strict?: { unreadable: (path: string) => boolean },
): void {
  const go = (dir: string, rel: string, folder: string, depth: number): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return strict === undefined ? true : strict.unreadable(rel);
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (strict === undefined && entry.name.startsWith('.')) continue;
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) {
          if (strict !== undefined && !strict.unreadable(path)) return false;
          continue;
        }
        if (!go(join(dir, entry.name), path, folder, depth + 1)) return false;
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!visit(path, folder, entry.isSymbolicLink())) return false;
      }
    }
    return true;
  };
  for (const folder of folders) {
    const dir = join(root, folder.path);
    // The management folder itself must be a real folder: a link would take the walk elsewhere.
    if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    if (!go(dir, folder.path, folder.path, 1)) return;
  }
}

/** The label of a file of the container: a note by its header too, read from its first bytes; unreadable means L3. */
function fileLabel(root: string, rules: LabelRules, path: string, link: boolean): Label {
  const folder = labelForPath(rules, path);
  if (link) return folder;
  if (!path.toLowerCase().endsWith('.md')) return folder;
  try {
    const { header } = parsePage(readHead(join(root, ...path.split('/')), HEADER_BYTES));
    return pageLabel(rules, path, header.labels);
  } catch {
    return 'L3';
  }
}

/** The tab "Conoscenza" (D-145): the management folders with their labels and the notes with theirs. */
export function readProjectKnowledge(projects: readonly Project[], name: string, single: boolean): ProjectKnowledge {
  const { project, root } = containerOf(projects, name);
  const folders = managementFolders(project);
  const rules = knowledgeRules(folders);
  const notes: KnowledgeNote[] = [];
  let more = 0;
  walk(root, folders, (path, folder, link) => {
    if (link || !path.toLowerCase().endsWith('.md')) return true;
    if (notes.length >= MAX_NOTES) {
      more += 1;
      return true;
    }
    let title = path.split('/').at(-1)?.replace(/\.md$/i, '') ?? path;
    let label: Label;
    try {
      const { header } = parsePage(readHead(join(root, ...path.split('/')), HEADER_BYTES));
      label = pageLabel(rules, path, header.labels);
      if (header.title !== undefined && header.title !== '') title = header.title;
    } catch {
      label = 'L3';
    }
    notes.push({ folder, path, title, label });
    return true;
  });
  return { single, folders, notes, more };
}

/**
 * The files of the management folders above L1 (D-145), when the container is
 * itself the part: the Coder's folder holds them, so it does not open until
 * P3 can deny them file by file. The paths, never their text.
 */
export function privateKnowledge(project: Project): string[] {
  let root: string;
  try {
    root = realpathSync(project.absolute);
  } catch {
    return [];
  }
  const folders = managementFolders(project);
  const rules = knowledgeRules(folders);
  const found: string[] = [];
  const enough = (): boolean => found.length < 20;
  walk(
    root,
    folders,
    (path, _folder, link) => {
      if (!isAtMost(fileLabel(root, rules, path, link), 'L1')) found.push(path);
      return enough();
    },
    {
      unreadable: (path) => {
        found.push(path);
        return enough();
      },
    },
  );
  return found;
}

export interface NoteInput {
  /** The management folder, by its name. */
  folder: string;
  title: string;
  text: string;
  /** The label the user saw and kept or raised; never below the folder's. */
  label: Label;
  /** Written as `capture:hud:<id>`. */
  id: string;
  now?: Date;
}

/**
 * "+ Conoscenza" (D-145): a new note in a management folder, written as
 * `kb:capture` writes one (D-080): the header only from here, the user's text
 * in the body, where it cannot change the label; never through a link, never
 * over a file.
 */
export function writeProjectNote(projects: readonly Project[], name: string, input: NoteInput): { path: string; label: Label } {
  const { project, root } = containerOf(projects, name);
  const folder = managementFolders(project).find((item) => item.path === input.folder);
  if (folder === undefined || !isFolderName(input.folder)) throw new KnowledgeError('invalid', 'the folder is not a management folder of the project');
  if (!isLabel(input.label)) throw new KnowledgeError('invalid', `label must be one of ${LABELS.join(', ')}`);
  // The note is never below its folder: the user can only raise it.
  if (!isAtMost(folder.label, input.label)) throw new KnowledgeError('invalid', `the folder ${folder.path} is ${folder.label}: a note in it cannot be lower`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) throw new KnowledgeError('invalid', 'invalid source');
  if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > MAX_NOTE_TEXT) throw new KnowledgeError('too-large', 'the text is too long');
  const text = input.text.replace(/\r\n/g, '\n').trim();
  if (text === '' || text.includes('\0')) throw new KnowledgeError('invalid', 'the text is empty');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title === '' || title.length > MAX_TITLE || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)) throw new KnowledgeError('invalid', `title must be one line of at most ${String(MAX_TITLE)} characters`);

  const dir = join(root, folder.path);
  // The folder is a real folder directly inside the container: a link would take the note elsewhere.
  const sameFolder = (): boolean => {
    try {
      return lstatSync(dir).isDirectory() && realpathSync(dir) === dir;
    } catch {
      return false;
    }
  };
  if (!sameFolder()) throw new KnowledgeError('refused', `the folder ${folder.path} is not a plain folder of the project`);

  const now = input.now ?? new Date();
  const label = maxLabel(folder.label, input.label);
  const header = ['---', `label: ${label}`, `source: capture:hud:${input.id}`, `captured_at: ${localTimestamp(now)}`, 'kind: note', `project: ${project.name}`, `title: ${JSON.stringify(title)}`, '---'].join('\n');
  const content = `${header}\n\n${text}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new KnowledgeError('too-large', 'the text is too long');
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const base = `${stamp}-${slugOf(title)}`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const fileName = `${base}${attempt === 1 ? '' : `-${String(attempt)}`}.md`;
    const file = join(dir, fileName);
    let fd: number;
    try {
      // O_EXCL: an existing file is never touched; O_NOFOLLOW: a link is refused, not followed.
      fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue;
      throw new KnowledgeError('unavailable', 'cannot create the note');
    }
    let written = false;
    try {
      // A folder swapped for a link between the check and the open: the empty file goes, nothing is written.
      if (sameFolder()) {
        writeFileSync(fd, content);
        written = true;
      }
    } catch {
      // Disk full, I/O error: below, the partial note goes.
    } finally {
      closeSync(fd);
    }
    if (!written) {
      try {
        unlinkSync(file);
      } catch {
        // Already gone.
      }
      throw new KnowledgeError('unavailable', 'cannot create the note');
    }
    return { path: `${folder.path}/${fileName}`, label };
  }
  throw new KnowledgeError('unavailable', 'too many notes with the same name in this second');
}

/** A page of a project for `kb.search`: its path for the tools, and its folder label (known without opening it). */
export interface ProjectPageRef {
  path: string;
  folderLabel: Label;
}

/** The pages of the projects for the search and the reading of Arianna (D-145): local only, each with its label. */
export interface ProjectPages {
  list(): ProjectPageRef[];
  /** The folder label of a page path, without opening it; undefined when the path is not a page of a project. */
  folderLabel(path: string): Label | undefined;
  load(path: string): KbPage;
}

/** `projects/<project>/<folder>/.../<file>.md` split, or undefined when it is not one. */
function splitPagePath(path: string): { project: string; rel: string } | undefined {
  const segments = path.split('/');
  if (segments[0] !== PROJECT_PAGES || segments.length < 4 || !path.toLowerCase().endsWith('.md')) return undefined;
  if (segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.') || segment.includes('\\') || segment.includes('\0'))) return undefined;
  return { project: segments[1] ?? '', rel: segments.slice(2).join('/') };
}

/** A page path of a project, for `kb.read` and `kb.search` alike: one rule for both (D-145). */
export function isProjectPagePath(path: string): boolean {
  return splitPagePath(path) !== undefined;
}

/** The pages of the approved projects, read again at each call: a folder relabeled by the user counts at once. */
export function createProjectPages(projects: () => readonly Project[]): ProjectPages {
  const containerOrUndefined = (name: string): { project: Project; root: string; rules: LabelRules; folders: ManagementFolder[] } | undefined => {
    try {
      const { project, root } = containerOf(projects(), name);
      const folders = managementFolders(project);
      return { project, root, rules: knowledgeRules(folders), folders };
    } catch {
      return undefined;
    }
  };
  return {
    list() {
      const found: ProjectPageRef[] = [];
      for (const project of projects()) {
        const container = containerOrUndefined(project.name);
        if (container === undefined) continue;
        walk(container.root, container.folders, (path, _folder, link) => {
          if (!link && path.toLowerCase().endsWith('.md')) found.push({ path: `${PROJECT_PAGES}/${project.name}/${path}`, folderLabel: labelForPath(container.rules, path) });
          return found.length < MAX_NOTES * 4;
        });
      }
      return found;
    },
    folderLabel(path) {
      const split = splitPagePath(path);
      if (split === undefined) return undefined;
      const container = containerOrUndefined(split.project);
      if (container === undefined) return undefined;
      return labelForPath(container.rules, split.rel);
    },
    load(path) {
      const split = splitPagePath(path);
      const container = split === undefined ? undefined : containerOrUndefined(split.project);
      if (split === undefined || container === undefined) throw new KnowledgeError('not-found', `page ${path} not found`);
      const folder = split.rel.split('/')[0] ?? '';
      if (!container.folders.some((item) => item.path === folder)) throw new KnowledgeError('not-found', `page ${path} not found`);
      const file = join(container.root, ...split.rel.split('/'));
      // A regular file exactly where the path says: no link anywhere on the way.
      let real: string;
      try {
        const stat = lstatSync(file);
        if (!stat.isFile()) throw new KnowledgeError('not-found', `page ${path} not found`);
        if (stat.size > MAX_NOTE_BYTES) throw new KnowledgeError('too-large', `page ${path} is too large to read`);
        real = realpathSync(file);
      } catch (error) {
        if (error instanceof KnowledgeError) throw error;
        throw new KnowledgeError('not-found', `page ${path} not found`);
      }
      if (real !== file) throw new KnowledgeError('not-found', `page ${path} not found`);
      const { header, body } = parsePage(readHead(file, MAX_NOTE_BYTES));
      return {
        path,
        label: pageLabel(container.rules, split.rel, header.labels),
        title: header.title ?? split.rel.split('/').at(-1)?.replace(/\.md$/i, '') ?? path,
        body,
      };
    },
  };
}
