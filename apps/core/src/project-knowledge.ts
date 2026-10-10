import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultFolderLabel, isFolderName, isSinglePart, managementFolders, NOT_MANAGEMENT, projectParts, type ManagementFolder, type Project } from '@arianna/config';
import { createLabelRules, isAtMost, isLabel, labelForKbPage, labelForPath, LABELS, maxLabel, type Label, type LabelRules } from '@arianna/policy';

import { localTimestamp, slugOf } from './capture.ts';
import { KB_PROJECT_NOTES, parsePage, type KbPage } from './orchestrator/kb.ts';
import { unlinkPlainFile } from './plain-file.ts';

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
export const HEADER_BYTES = 8 * 1024;
export const MAX_NOTE_BYTES = 200_000;
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
  /** True when the notes live in `kb/progetti/<project>/` of Arianna, outside the code (one git, D-145). */
  inKb: boolean;
  /** The folder the management folders are in, as the user reads it (`kb/progetti/demo`, or the container). */
  where: string;
  folders: ManagementFolder[];
  notes: KnowledgeNote[];
  /** Notes left out past MAX_NOTES. */
  more: number;
  /**
   * One git: the management folders found inside the repository itself (as
   * before), which keep the Coder out while a file above L1 is there.
   */
  repoFolders: ManagementFolder[];
}

/** ARIANNA_HOME and the rules of `labels.toml`: where `kb/progetti` is, and the rules that may raise it. */
export interface KnowledgeEnv {
  home: string;
  rules: LabelRules;
}

/**
 * Where the knowledge of a project lives (D-145): the container when it holds
 * parts, `kb/progetti/<project>` of Arianna when the project is one git (the
 * notes stay out of the code). `labelOf` labels a path relative to `root`:
 * the folder rule, the header, and for `kb/progetti` any explicit rule of
 * labels.toml above it, which only raises.
 */
interface KnowledgeBase {
  project: Project;
  root: string;
  inKb: boolean;
  /** False while `kb/progetti/<project>` does not exist yet: no folder, no note. */
  exists: boolean;
  folders: ManagementFolder[];
  rules: LabelRules;
  floor: (rel: string) => Label | undefined;
}

/** The highest label of the rules of labels.toml that contain `path` (relative to ARIANNA_HOME), if any. */
function explicitLabel(rules: LabelRules, path: string): Label | undefined {
  const folded = path.toUpperCase().toLowerCase();
  const found = rules.folders.filter((rule) => {
    const folder = rule.path.toUpperCase().toLowerCase();
    return folded === folder || folded.startsWith(`${folder}/`);
  });
  return found.length === 0 ? undefined : maxLabel(...found.map((rule) => rule.label));
}

/**
 * `kb/progetti/<project>` as a real folder inside ARIANNA_HOME, every segment
 * a folder and never a link; created (0700) only when `create`.
 */
function kbRoot(home: string, name: string, create: boolean): { root: string; exists: boolean } {
  let dir: string;
  try {
    dir = realpathSync(home);
  } catch {
    throw new KnowledgeError('unavailable', 'ARIANNA_HOME cannot be read');
  }
  const segments = [...KB_PROJECT_NOTES.split('/'), name];
  for (const [index, segment] of segments.entries()) {
    dir = join(dir, segment);
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat === undefined) {
      if (!create) return { root: join(realpathSync(home), ...segments), exists: false };
      // kb/ itself must be there: Arianna does not make her knowledge base here.
      if (index === 0) throw new KnowledgeError('unavailable', 'there is no kb/ folder');
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw new KnowledgeError('unavailable', `cannot create ${segments.slice(0, index + 1).join('/')}`);
      }
      if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) throw new KnowledgeError('refused', `${segments.slice(0, index + 1).join('/')} is not a plain folder`);
      continue;
    }
    if (!stat.isDirectory()) throw new KnowledgeError('refused', `${segments.slice(0, index + 1).join('/')} is not a plain folder`);
  }
  if (realpathSync(dir) !== dir) throw new KnowledgeError('refused', `${segments.join('/')} goes through a symbolic link`);
  return { root: dir, exists: true };
}

/** The first-level folders of `kb/progetti/<project>`: real folders, not hidden, each with its label (D-145). */
function kbFolders(root: string, project: Project): ManagementFolder[] {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isFolderName(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const fold = (name: string): string => name.normalize('NFC').toLowerCase();
  const chosen = new Map((project.folders ?? []).map((folder) => [fold(folder.path), folder.label]));
  return names
    .sort((a, b) => a.localeCompare(b, 'it'))
    .map((path) => {
      const defaultLabel = defaultFolderLabel(path);
      const label = chosen.get(fold(path));
      return { path, label: label ?? defaultLabel, defaultLabel, chosen: label !== undefined };
    });
}

/** Where the knowledge of the project `name` is, with its folders and rules (see KnowledgeBase). */
function knowledgeBase(projects: readonly Project[], name: string, env: KnowledgeEnv, create = false): KnowledgeBase {
  const project = projects.find((candidate) => candidate.name === name);
  if (project === undefined) throw new KnowledgeError('not-found', `the project ${name} is not among the approved projects`);
  if (isSinglePart(project)) {
    const { root, exists } = kbRoot(env.home, project.name, create);
    const raw = exists ? kbFolders(root, project) : [];
    const prefix = `${KB_PROJECT_NOTES}/${project.name}`;
    const floor = (rel: string): Label | undefined => explicitLabel(env.rules, `${prefix}/${rel}`);
    // An explicit rule of labels.toml over kb/progetti only raises a folder.
    const folders = raw.map((folder) => {
      const above = floor(folder.path);
      return above === undefined ? folder : { ...folder, label: maxLabel(folder.label, above) };
    });
    return { project, root, inKb: true, exists, folders, rules: knowledgeRules(folders), floor };
  }
  const { root } = containerOf(projects, name);
  const folders = managementFolders(project);
  return { project, root, inKb: false, exists: true, folders, rules: knowledgeRules(folders), floor: () => undefined };
}

/** The label of a path of the base: folder rule, header lines, and the floor of labels.toml for kb/progetti. */
function baseLabel(base: KnowledgeBase, rel: string, headerLabels: readonly string[]): Label {
  const label = pageLabel(base.rules, rel, headerLabels);
  const floor = base.floor(rel);
  return floor === undefined ? label : maxLabel(label, floor);
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
export function readProjectKnowledge(projects: readonly Project[], name: string, env: KnowledgeEnv): ProjectKnowledge {
  const base = knowledgeBase(projects, name, env);
  const notes: KnowledgeNote[] = [];
  let more = 0;
  if (base.exists) {
    walk(base.root, base.folders, (path, folder, link) => {
      if (link || !path.toLowerCase().endsWith('.md')) return true;
      if (notes.length >= MAX_NOTES) {
        more += 1;
        return true;
      }
      let title = path.split('/').at(-1)?.replace(/\.md$/i, '') ?? path;
      let label: Label;
      try {
        const { header } = parsePage(readHead(join(base.root, ...path.split('/')), HEADER_BYTES));
        label = baseLabel(base, path, header.labels);
        if (header.title !== undefined && header.title !== '') title = header.title;
      } catch {
        label = 'L3';
      }
      notes.push({ folder, path, title, label });
      return true;
    });
  }
  return {
    inKb: base.inKb,
    where: base.inKb ? `${KB_PROJECT_NOTES}/${base.project.name}` : base.project.path,
    folders: base.folders,
    notes,
    more,
    repoFolders: base.inKb ? managementFolders(base.project) : [],
  };
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

/** A management folder to write in: the caller checks with `sameFolder` that it is a real folder directly inside the base, before and after opening. */
export interface OpenedFolder {
  project: Project;
  folder: ManagementFolder;
  dir: string;
  sameFolder: () => boolean;
}

/**
 * The management folder `folderName` of the project, created (0700) when it is
 * not there yet (D-145): never a part, a repository, a folder of the code or a
 * name that differs from an existing one only in case; never through a link.
 */
function openFolder(projects: readonly Project[], name: string, env: KnowledgeEnv, folderName: string): OpenedFolder {
  const look = knowledgeBase(projects, name, env);
  const fold = (value: string): string => value.normalize('NFC').toLowerCase();
  let folder = look.folders.find((item) => item.path === folderName);
  if (folder === undefined) {
    // A new management folder, named by the user (D-145): never a part, a repository, a folder of the code or one that differs only in case.
    if (look.folders.some((item) => fold(item.path) === fold(folderName))) throw new KnowledgeError('invalid', 'a folder with this name exists with other letter case');
    if (NOT_MANAGEMENT.has(fold(folderName))) throw new KnowledgeError('invalid', 'the folder is not a management folder of the project');
    if (!look.inKb) {
      if (projectParts(look.project).some((part) => part.part !== null && fold(part.part) === fold(folderName))) throw new KnowledgeError('invalid', 'the folder is a part of the project: notes never go in the code');
      if (lstatSync(join(look.root, folderName), { throwIfNoEntry: false }) !== undefined) throw new KnowledgeError('invalid', 'the folder is not a management folder of the project');
    }
    const base = knowledgeBase(projects, name, env, true);
    const created = join(base.root, folderName);
    try {
      mkdirSync(created, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw new KnowledgeError('unavailable', 'cannot create the folder');
    }
    folder = knowledgeBase(projects, name, env).folders.find((item) => item.path === folderName);
    if (folder === undefined) throw new KnowledgeError('refused', 'the folder is not a plain folder of the project');
  }
  const { project, root } = knowledgeBase(projects, name, env);

  const dir = join(root, folder.path);
  // The folder is a real folder directly inside the container: a link would take the note elsewhere.
  const sameFolder = (): boolean => {
    try {
      return lstatSync(dir).isDirectory() && realpathSync(dir) === dir;
    } catch {
      return false;
    }
  };
  return { project, folder, dir, sameFolder };
}

/** The name of the management folder of the work plan (D-145, I-15). */
export const WORKPLAN = 'Workplan';

/**
 * The folder Workplan of a project, with any letter case it already has, or
 * created as `Workplan` (I-15, D-147): where the core writes the diary of the
 * works. Same rules as a folder of "+ Conoscenza".
 */
export function openWorkplan(projects: readonly Project[], name: string, env: KnowledgeEnv): OpenedFolder {
  const look = knowledgeBase(projects, name, env);
  const fold = (value: string): string => value.normalize('NFC').toLowerCase();
  const found = look.folders.find((item) => fold(item.path) === fold(WORKPLAN));
  return openFolder(projects, name, env, found?.path ?? WORKPLAN);
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
export function writeProjectNote(projects: readonly Project[], name: string, env: KnowledgeEnv, input: NoteInput): { path: string; label: Label } {
  // Every check of the input before anything is created on the disk.
  if (typeof input.folder !== 'string' || !isFolderName(input.folder)) throw new KnowledgeError('invalid', 'the folder must be one plain folder name, not hidden');
  if (!isLabel(input.label)) throw new KnowledgeError('invalid', `label must be one of ${LABELS.join(', ')}`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) throw new KnowledgeError('invalid', 'invalid source');
  if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > MAX_NOTE_TEXT) throw new KnowledgeError('too-large', 'the text is too long');
  const text = input.text.replace(/\r\n/g, '\n').trim();
  if (text === '' || text.includes('\0')) throw new KnowledgeError('invalid', 'the text is empty');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title === '' || title.length > MAX_TITLE || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)) throw new KnowledgeError('invalid', `title must be one line of at most ${String(MAX_TITLE)} characters`);

  const { project, folder, dir, sameFolder } = openFolder(projects, name, env, input.folder);
  // The note is never below its folder: the user can only raise it.
  if (!isAtMost(folder.label, input.label)) throw new KnowledgeError('invalid', `the folder ${folder.path} is ${folder.label}: a note in it cannot be lower`);
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

/**
 * "Elimina" of a note of a project (D-157): the file `path` (relative to
 * where the knowledge is, as the tab "Conoscenza" lists it) goes for good.
 * Only a markdown file inside a management folder of the project, never a
 * hidden entry, a link, a part or a file of the code; anything else answers
 * not found. The user sees every note of the tab, so any label is deleted.
 */
export function deleteProjectNote(projects: readonly Project[], name: string, env: KnowledgeEnv, path: string): void {
  const refuse = (): KnowledgeError => new KnowledgeError('not-found', 'note not found');
  if (typeof path !== 'string' || path.length > 1024 || !path.toLowerCase().endsWith('.md')) throw refuse();
  const segments = path.split('/');
  if (segments.length < 2 || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.') || segment.includes('\\') || segment.includes('\0'))) throw refuse();
  const base = knowledgeBase(projects, name, env);
  if (!base.exists || !base.folders.some((folder) => folder.path === segments[0])) throw refuse();
  if (!unlinkPlainFile(base.root, segments)) throw refuse();
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
export function createProjectPages(projects: () => readonly Project[], env: KnowledgeEnv): ProjectPages {
  const containerOrUndefined = (name: string): KnowledgeBase | undefined => {
    try {
      const base = knowledgeBase(projects(), name, env);
      return base.exists ? base : undefined;
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
          if (!link && path.toLowerCase().endsWith('.md')) found.push({ path: `${PROJECT_PAGES}/${project.name}/${path}`, folderLabel: baseLabel(container, path, []) });
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
      return baseLabel(container, split.rel, []);
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
        label: baseLabel(container, split.rel, header.labels),
        title: header.title ?? split.rel.split('/').at(-1)?.replace(/\.md$/i, '') ?? path,
        body,
      };
    },
  };
}
