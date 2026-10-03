// The approved projects on disk (D-058): their folders, and the link
// `repos/<name>` the wizard keeps for each folder under the user's home. The
// link is a shortcut for the user (Finder, Obsidian, a terminal inside
// Arianna); the Coder always works in the approved path, and opening it
// checks the folder again (`openRepository` in @arianna/executors).
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { PROJECTS_DIR, type Project } from '@arianna/config';
import type { DoctorCheck } from '@arianna/core/doctor';

/** True when `inner` is `outer` or inside it. */
function within(inner: string, outer: string): boolean {
  const fromOuter = relative(outer, inner);
  return fromOuter === '' || (fromOuter !== '..' && !fromOuter.startsWith(`..${sep}`) && !isAbsolute(fromOuter));
}

/**
 * What is wrong with the folder of a project, in Italian for the wizard, or
 * `undefined` when it is ready: the same checks `openRepository` makes at
 * each launch (the folder exactly itself on disk, no link on the way, not
 * around ARIANNA_HOME, inside it only as `repos/<name>`), and the top of a
 * git repository.
 */
export function folderProblem(absolute: string, home: string, name: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return `la cartella ${absolute} non esiste`;
  }
  if (real !== absolute) return `${absolute} non è il percorso vero della cartella (un link simbolico, o maiuscole diverse): indica ${real}`;
  if (!lstatSync(real).isDirectory()) return `${absolute} non è una cartella`;
  const realHome = realpathSync(home);
  if (within(realHome, real)) return `${absolute} contiene la cartella di Arianna`;
  if (within(real, realHome) && real !== join(realHome, PROJECTS_DIR, name)) return `${absolute} è dentro Arianna: lì un progetto può stare solo in ${PROJECTS_DIR}/${name}`;
  if (!existsSync(join(real, '.git'))) return `${absolute} non è la cartella principale di un repository git (git init, poi un primo commit)`;
  return undefined;
}

/** `repos/<name>` of a project: absent for a folder that is itself in repos/. */
function linkPath(home: string, project: Project): string | undefined {
  return project.path.startsWith(`${PROJECTS_DIR}/`) ? undefined : join(home, PROJECTS_DIR, project.name);
}

export type LinkState = 'none' | 'ok' | 'missing' | 'elsewhere' | 'not-link';

/** Whether `repos/<name>` is the link to the project's folder. */
export function linkState(home: string, project: Project): LinkState {
  const path = linkPath(home, project);
  if (path === undefined) return 'none';
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return 'missing';
  }
  if (!stats.isSymbolicLink()) return 'not-link';
  return readlinkSync(path) === project.absolute ? 'ok' : 'elsewhere';
}

/**
 * Brings the links in `repos/` in line with the list, after the wizard wrote
 * it: a link for each project under the home (a link pointing elsewhere is
 * replaced, it is ours), the link of a project taken off the list removed.
 * Only links are ever created or removed: a real file or folder named like a
 * project is left alone and reported. Returns what was done, in Italian.
 */
export function syncProjectLinks(home: string, before: readonly Project[], after: readonly Project[]): string[] {
  const done: string[] = [];
  // `repos/` itself must be a real folder: through a link the links would be made elsewhere.
  try {
    if (!lstatSync(join(home, PROJECTS_DIR)).isDirectory()) return [`${PROJECTS_DIR}/ non è una cartella vera: non creo né tolgo link.`];
  } catch {
    // Created below when a link is needed.
  }
  const names = new Set(after.map((project) => project.name));
  for (const project of before) {
    const path = linkPath(home, project);
    if (path === undefined || names.has(project.name)) continue;
    if (linkState(home, project) === 'ok' || linkState(home, project) === 'elsewhere') {
      unlinkSync(path);
      done.push(`Tolto il link ${PROJECTS_DIR}/${project.name}.`);
    }
  }
  for (const project of after) {
    const path = linkPath(home, project);
    if (path === undefined) continue;
    const state = linkState(home, project);
    if (state === 'ok') continue;
    if (state === 'not-link') {
      done.push(`${PROJECTS_DIR}/${project.name} esiste e non è un link: lo lascio com'è, il link non c'è.`);
      continue;
    }
    if (state === 'elsewhere') unlinkSync(path);
    mkdirSync(join(home, PROJECTS_DIR), { recursive: true });
    symlinkSync(project.absolute, path);
    done.push(`Creato il link ${PROJECTS_DIR}/${project.name} → ${project.absolute}.`);
  }
  return done;
}

/** The doctor's checks: each folder ready for the Coder, each link in place. Nothing is fixed here. */
export function projectChecks(home: string, projects: readonly Project[]): DoctorCheck[] {
  if (projects.length === 0) return [{ id: 'projects', ok: true, detail: 'no project approved yet (pnpm arianna:init --reconfigure)' }];
  return projects.flatMap((project): DoctorCheck[] => {
    const problem = folderProblem(project.absolute, home, project.name);
    const checks: DoctorCheck[] = [
      { id: `projects.${project.name}`, ok: problem === undefined, detail: problem ?? `${project.path} (${project.label}): a git repository, ready for the Coder` },
    ];
    const link = linkState(home, project);
    if (link !== 'none') {
      const detail: Record<Exclude<LinkState, 'none'>, string> = {
        ok: `${PROJECTS_DIR}/${project.name} links to the folder`,
        missing: `${PROJECTS_DIR}/${project.name} is missing: pnpm arianna:init --reconfigure creates it`,
        elsewhere: `${PROJECTS_DIR}/${project.name} links elsewhere (the Coder still uses ${project.path}): pnpm arianna:init --reconfigure fixes it`,
        'not-link': `${PROJECTS_DIR}/${project.name} is a real file or folder, not the link: move it away`,
      };
      checks.push({ id: `projects.${project.name}.link`, ok: link === 'ok', detail: detail[link] });
    }
    return checks;
  });
}
