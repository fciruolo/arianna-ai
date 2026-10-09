// The projects the user approved for the cloud executors (D-058): real folders
// wherever they are under the user's home, or `repos/<name>` inside
// ARIANNA_HOME. The list is a privacy setting: only the user writes it (the
// wizard or by hand), never an agent.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { LABELS, type Label } from '@arianna/policy';

import { asArray, asOneOf, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

export const PROJECTS_DIR = 'repos';
export const PROJECT_LABELS = ['L0', 'L1'] as const;
export type ProjectLabel = (typeof PROJECT_LABELS)[number];

/** Also the name of the link in `repos/`: no separators, no dots, nothing hidden. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A part of a container (D-145): a direct subfolder that is the top of its own
 * git repository. A plain name, so that `<project>:<part>` is one segment of
 * a URL and never a path.
 */
export const PART_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
/** Between the project and the part in the name of a part (`progetto-test:progetto-test-admin`). */
export const PART_SEPARATOR = ':';

/**
 * The label the user gave a management folder of the container (D-145): a
 * direct subfolder by name, any label. Written only by the user (Settings,
 * "Conoscenza" of the page Progetti, by hand), never by an agent.
 */
export interface ProjectFolder {
  path: string;
  label: Label;
}

export interface Project {
  name: string;
  /** As written in arianna.toml: `~/...` (under the user's home) or `repos/<name>`. */
  path: string;
  /** The folder on this machine. Opening it checks again that it is a real folder, not a link. */
  absolute: string;
  /** Every file of the project has this label; at most L1, since the project exists to go to the cloud. */
  label: ProjectLabel;
  /**
   * D-145: the parts the user listed, when the container is not a git
   * repository; absent, every direct subfolder that is the top of a git
   * repository is a part.
   */
  parts?: readonly string[];
  /** D-145: the labels the user gave the management folders of the container; the others have their default. */
  folders?: readonly ProjectFolder[];
}

/** True when `inner` is `outer` or inside it; a folder named `..x` is inside. */
function within(inner: string, outer: string): boolean {
  const fromOuter = relative(outer, inner);
  return fromOuter === '' || (fromOuter !== '..' && !fromOuter.startsWith(`..${sep}`) && !isAbsolute(fromOuter));
}

/** NFC and lowercase: on a case-insensitive disk `Sito` and `sito` are one folder. */
function fold(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * The segments of a project path: none empty, `.` or `..`, none hidden (a
 * `.ssh` or `.config` must never become a project), no backslash or NUL.
 */
function segmentsOf(rest: string, where: string): string[] {
  const segments = rest.split('/');
  for (const segment of segments) {
    if (segment === '' || segment.startsWith('.') || segment.includes('\\') || segment.includes('\0')) {
      throw new ConfigError(`${where}: every folder of the path must be a plain name, not empty or hidden`);
    }
  }
  return segments;
}

/** The path as it is on disk when it exists (links resolved), else as given: what the comparisons use. */
function onDisk(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `inner` is `outer` or inside it, ignoring case and normalization, as a case-insensitive disk does. */
function foldedWithin(inner: string, outer: string): boolean {
  return within(fold(inner), fold(outer));
}

/**
 * Where a project path points on this machine. Only two forms:
 * - `~/a/b`: under the user's home, never the home itself, nothing hidden,
 *   not `Library`, not ARIANNA_HOME nor `data/` nor a folder inside or
 *   around them (compared as on disk, ignoring case);
 * - `repos/<name>`: a folder inside ARIANNA_HOME, as `repos/demo`.
 * Opening the project checks the folder on disk again (`openRepository`).
 */
function resolveProject(path: string, name: string, roots: Roots, where: string): string {
  if (path.startsWith('~/')) {
    const segments = segmentsOf(path.slice(2), where);
    if (fold(segments[0] ?? '') === 'library') throw new ConfigError(`${where}: Library holds the settings and data of every app, it cannot be a project`);
    const absolute = join(roots.userHome, ...segments);
    for (const forbidden of [roots.home, onDisk(roots.home), roots.data, onDisk(roots.data)]) {
      if (foldedWithin(absolute, forbidden) || foldedWithin(forbidden, absolute)) {
        throw new ConfigError(`${where}: must not be ARIANNA_HOME, inside it or around it; for a folder inside Arianna write ${PROJECTS_DIR}/<name>`);
      }
    }
    return absolute;
  }
  if (path.startsWith(`${PROJECTS_DIR}/`)) {
    const segments = segmentsOf(path.slice(PROJECTS_DIR.length + 1), where);
    if (segments.length !== 1 || segments[0] !== name) throw new ConfigError(`${where}: a folder inside Arianna must be ${PROJECTS_DIR}/${name}`);
    return join(roots.home, PROJECTS_DIR, name);
  }
  throw new ConfigError(`${where}: write ~/<folder> for a folder under your home, or ${PROJECTS_DIR}/<name> for one inside Arianna`);
}

/**
 * The `[[project]]` sections. Names unique; no project the same folder as
 * another, nor inside it, also when they differ only in case. Whether the
 * folder exists and is the top of a git repository is checked when a
 * delegated step opens it, and by the doctor.
 */
interface Roots {
  home: string;
  userHome: string;
  data: string;
}

export function parseProjects(value: unknown, home: string, userHome: string, data: string = join(home, 'data')): Project[] {
  if (value === undefined) return [];
  // `~/` must point somewhere real: with HOME unset to `/` or a relative path, `~/etc` would be `/etc`.
  if (!isAbsolute(userHome) || resolve(userHome) === sep) throw new ConfigError('project: the home folder (HOME) must be an absolute folder other than /');
  const roots: Roots = { home, userHome: resolve(userHome), data };
  const projects = asArray(value, 'project').map((item, index): Project => {
    const where = `project[${String(index)}]`;
    const table = asTable(item, where);
    onlyKeys(table, ['name', 'path', 'label', 'parts', 'folder'], where);
    const name = asString(table.name, `${where}.name`);
    if (!PROJECT_NAME.test(name)) throw new ConfigError(`${where}.name: lowercase letters, digits and dashes, starting with a letter or digit`);
    const path = asString(table.path, `${where}.path`);
    const absolute = resolveProject(path, name, roots, `${where}.path`);
    if (table.label === 'L2' || table.label === 'L3') {
      throw new ConfigError(`${where}.label: a project goes to the cloud, so it is L0 or L1; keep private folders out of the list`);
    }
    const label = table.label === undefined ? 'L1' : asOneOf(table.label, PROJECT_LABELS, `${where}.label`);
    const parts = table.parts === undefined ? undefined : parseParts(table.parts, `${where}.parts`);
    const folders = table.folder === undefined ? undefined : parseFolders(table.folder, `${where}.folder`);
    return { name, path, absolute, label, ...(parts === undefined ? {} : { parts }), ...(folders === undefined ? {} : { folders }) };
  });
  for (const [index, project] of projects.entries()) {
    for (const other of projects.slice(index + 1)) {
      if (project.name === other.name) throw new ConfigError(`project: ${project.name} is listed twice`);
      const [a, b] = [fold(project.absolute), fold(other.absolute)];
      if (within(a, b) || within(b, a)) throw new ConfigError(`project: ${project.name} and ${other.name} are the same folder or one inside the other`);
    }
  }
  return projects;
}

/**
 * The project a work conversation names: by name, or by the path conversations
 * opened before D-058 stored (`repos/demo` is the project `demo`).
 */
export function projectNamed<T extends Project>(projects: readonly T[], name: string | null | undefined): T | undefined {
  if (name === null || name === undefined) return undefined;
  const plain = name.startsWith(`${PROJECTS_DIR}/`) ? name.slice(PROJECTS_DIR.length + 1) : name;
  return projects.find((project) => project.name === plain);
}

/** `parts` of a `[[project]]`: plain folder names, each once (ignoring case, as the disk does). */
function parseParts(value: unknown, where: string): string[] {
  const parts = asArray(value, where).map((item, index) => {
    const part = asString(item, `${where}[${String(index)}]`);
    if (!PART_NAME.test(part)) throw new ConfigError(`${where}[${String(index)}]: a part is a folder of the container: letters, digits, dot, dash or underscore, not hidden`);
    return part;
  });
  if (new Set(parts.map(fold)).size !== parts.length) throw new ConfigError(`${where}: a part is listed twice`);
  return parts;
}

/** A management folder name: one plain folder of the container, not hidden, no separator nor control character. */
export function isFolderName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && !name.startsWith('.') && name.trim() === name && !/[/\\\p{Cc}]/u.test(name);
}

/** `[[project.folder]]`: one folder of the container each, with its label. */
function parseFolders(value: unknown, where: string): ProjectFolder[] {
  const folders = asArray(value, where).map((item, index) => {
    const at = `${where}[${String(index)}]`;
    const table = asTable(item, at);
    onlyKeys(table, ['path', 'label'], at);
    const path = asString(table.path, `${at}.path`);
    if (!isFolderName(path)) throw new ConfigError(`${at}.path: one folder of the container, by its name, not hidden`);
    return { path, label: asOneOf(table.label, LABELS, `${at}.label`) };
  });
  if (new Set(folders.map((folder) => fold(folder.path))).size !== folders.length) throw new ConfigError(`${where}: a folder is listed twice`);
  return folders;
}

/**
 * A part of a project as the Coder and the page Progetti see it (D-145): a
 * `Project` of its own, named `<project>` when the container is itself the
 * top of a git repository (one part, as every project before D-145) and
 * `<project>:<part>` otherwise, with the folder of the part as `absolute`.
 */
export interface ProjectPart extends Project {
  /** The `[[project]]` the part belongs to. */
  project: string;
  /** The container folder. */
  container: string;
  /** The folder of the part inside the container; null when the container is the part. */
  part: string | null;
}

/** True when `dir/.git` exists, as a folder or as the file of a worktree; opening checks the repository again. */
function hasGit(dir: string): boolean {
  try {
    lstatSync(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** A real folder, not a link. */
function isPlainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when the container is itself the part: the top of a git repository, or missing (opening says why, as before D-145). */
export function isSinglePart(project: Project): boolean {
  return !isPlainDir(project.absolute) || hasGit(project.absolute);
}

/**
 * The parts of a project, read from the disk now (D-145). A container that is
 * the top of a git repository, or is missing (opening says so, as before), is
 * one part; otherwise each direct subfolder that is a real folder with a
 * plain name and a `.git`, or only those of them the user listed in `parts`.
 * Never the container itself when it is not a git repository.
 */
export function projectParts(project: Project): ProjectPart[] {
  if (isSinglePart(project)) return [{ ...project, project: project.name, container: project.absolute, part: null }];
  let names: string[];
  try {
    names = readdirSync(project.absolute, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PART_NAME.test(entry.name) && hasGit(join(project.absolute, entry.name)))
      .map((entry) => entry.name);
  } catch {
    names = [];
  }
  if (project.parts !== undefined) {
    const listed = new Set(project.parts.map(fold));
    names = names.filter((name) => listed.has(fold(name)));
  }
  return names
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((part) => ({
      name: `${project.name}${PART_SEPARATOR}${part}`,
      path: `${project.path}/${part}`,
      absolute: join(project.absolute, part),
      label: project.label,
      project: project.name,
      container: project.absolute,
      part,
    }));
}

/** Every part of every project: what a work conversation, the Coder and the tabs File, Git and Servizi work on. */
export function workParts(projects: readonly Project[]): ProjectPart[] {
  return projects.flatMap(projectParts);
}

/** Folders not of the project's own: dependencies, never management. */
const NOT_MANAGEMENT = new Set(['node_modules']);
/** D-145: management folders recognized by name, ignoring case. */
const KNOWN_FOLDERS = new Set(['workplan', 'im', 'documenti']);
/** D-145: the management folders that are Interne (L1) before the user's choice. */
const INTERNAL_FOLDERS = new Set(['workplan', 'im']);

/** The label of a management folder before the user's choice (D-145): Workplan and IM Interne (L1), every other Privata (L2). */
export function defaultFolderLabel(name: string): Label {
  return INTERNAL_FOLDERS.has(fold(name)) ? 'L1' : 'L2';
}

export interface ManagementFolder {
  /** The name of the folder inside the container. */
  path: string;
  label: Label;
  /** The label without the user's choice. */
  defaultLabel: Label;
  /** True when the user chose the label (`[[project.folder]]`). */
  chosen: boolean;
}

/**
 * The management folders of a container (D-145), read from the disk now: its
 * direct subfolders that are real folders, not hidden, not a part, not
 * dependencies. When the container is itself the part (one git), its code
 * and its management share the folder: only the folders recognized by name
 * (Workplan, IM, Documenti) and those the user labeled count.
 */
export function managementFolders(project: Project): ManagementFolder[] {
  let names: string[];
  try {
    names = readdirSync(project.absolute, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isFolderName(entry.name) && !NOT_MANAGEMENT.has(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const chosen = new Map((project.folders ?? []).map((folder) => [fold(folder.path), folder.label]));
  if (isSinglePart(project)) {
    names = names.filter((name) => KNOWN_FOLDERS.has(fold(name)) || chosen.has(fold(name)));
  } else {
    // A repository is code, a part or not (a name the parts refuse, one left out of `parts`).
    names = names.filter((name) => !hasGit(join(project.absolute, name)));
  }
  return names
    .sort((a, b) => a.localeCompare(b, 'it'))
    .map((path) => {
      const defaultLabel = defaultFolderLabel(path);
      const label = chosen.get(fold(path));
      return { path, label: label ?? defaultLabel, defaultLabel, chosen: label !== undefined };
    });
}
