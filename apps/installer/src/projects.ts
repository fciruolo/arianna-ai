// The links `repos/<name>` the wizard keeps for each approved project under
// the user's home (D-058). The link is a shortcut for the user (Finder,
// Obsidian, a terminal inside Arianna); the Coder always works in the
// approved path, and opening it checks the folder again (`openRepository` in
// @arianna/executors). The checks of the folders and of the links live in
// the core (install-checks.ts), shared with «Pronta per i dati veri» (D-192).
import { lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECTS_DIR, type Project } from '@arianna/config';
import { linkPath, linkState } from '@arianna/core/install-checks';

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
