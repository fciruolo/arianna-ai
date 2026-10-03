// The projects the user approved for the cloud executors (D-058): real folders
// wherever they are under the user's home, or `repos/<name>` inside
// ARIANNA_HOME. The list is a privacy setting: only the user writes it (the
// wizard or by hand), never an agent.
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { asArray, asOneOf, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

export const PROJECTS_DIR = 'repos';
export const PROJECT_LABELS = ['L0', 'L1'] as const;
export type ProjectLabel = (typeof PROJECT_LABELS)[number];

/** Also the name of the link in `repos/`: no separators, no dots, nothing hidden. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface Project {
  name: string;
  /** As written in arianna.toml: `~/...` (under the user's home) or `repos/<name>`. */
  path: string;
  /** The folder on this machine. Opening it checks again that it is a real folder, not a link. */
  absolute: string;
  /** Every file of the project has this label; at most L1, since the project exists to go to the cloud. */
  label: ProjectLabel;
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
    onlyKeys(table, ['name', 'path', 'label'], where);
    const name = asString(table.name, `${where}.name`);
    if (!PROJECT_NAME.test(name)) throw new ConfigError(`${where}.name: lowercase letters, digits and dashes, starting with a letter or digit`);
    const path = asString(table.path, `${where}.path`);
    const absolute = resolveProject(path, name, roots, `${where}.path`);
    if (table.label === 'L2' || table.label === 'L3') {
      throw new ConfigError(`${where}.label: a project goes to the cloud, so it is L0 or L1; keep private folders out of the list`);
    }
    const label = table.label === undefined ? 'L1' : asOneOf(table.label, PROJECT_LABELS, `${where}.label`);
    return { name, path, absolute, label };
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
export function projectNamed(projects: readonly Project[], name: string | null | undefined): Project | undefined {
  if (name === null || name === undefined) return undefined;
  const plain = name.startsWith(`${PROJECTS_DIR}/`) ? name.slice(PROJECTS_DIR.length + 1) : name;
  return projects.find((project) => project.name === plain);
}
