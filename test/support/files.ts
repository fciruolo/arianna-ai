import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'data', 'dist']);
/** Other checkouts of the repository: the worktrees Claude Code makes for its agents, and the projects in repos/ (the clones of GOD among them, D-127). */
const SKIPPED_PATHS = new Set(['.claude/worktrees', 'repos']);

/** Repository files as POSIX paths relative to the root, without dependencies and runtime data. */
export function listFiles(dir: string = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) || SKIPPED_PATHS.has(relative(ROOT, path).split(sep).join('/')) ? [] : listFiles(path);
    return [relative(ROOT, path).split(sep).join('/')];
  });
}
