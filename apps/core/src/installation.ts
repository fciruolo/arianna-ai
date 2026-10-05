import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

/**
 * What the web chat shows about this installation (D-089): development or
 * production, the name of its folder and the commit it runs. No command is
 * run: the commit is read from the files of .git, and anything unexpected
 * gives null.
 */
export type InstallationMode = 'development' | 'production';

export interface InstallationInfo {
  mode: InstallationMode;
  /** The name of the ARIANNA_HOME folder, never its full path. */
  home: string;
  /** The short commit of HEAD, or null when it cannot be read. */
  version: string | null;
}

/**
 * Development while the database uses the development passwords (the same
 * flag the doctor checks: `development` of the resolved login), or while
 * `[installation] mode = "development"` says so; production only with real
 * passwords and no such key.
 */
export function installationMode(developmentPasswords: boolean, declared: InstallationMode | undefined): InstallationMode {
  return developmentPasswords || declared === 'development' ? 'development' : 'production';
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REF = /^refs\/[A-Za-z0-9._/-]{1,200}$/;
const MAX_GIT_FILE = 1024 * 1024;

/** A small plain file, without following a link; undefined otherwise. */
function readSmall(file: string, limit = 4096): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return undefined;
    return readFileSync(fd, 'utf8');
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The git folder of `home`: `.git` itself, or the folder a `.git` file points to (a worktree). */
function gitDir(home: string): string | undefined {
  const dotGit = join(home, '.git');
  if (readSmall(join(dotGit, 'HEAD')) !== undefined) return dotGit;
  const pointer = /^gitdir: (.+)$/m.exec(readSmall(dotGit) ?? '')?.[1]?.trim();
  if (pointer === undefined) return undefined;
  return isAbsolute(pointer) ? pointer : resolve(home, pointer);
}

/** The short commit of HEAD from the files of .git (loose ref, packed-refs, detached HEAD); null otherwise. */
export function readVersion(home: string): string | null {
  const dir = gitDir(home);
  if (dir === undefined) return null;
  const head = readSmall(join(dir, 'HEAD'))?.trim();
  if (head === undefined) return null;
  if (SHA.test(head)) return head.slice(0, 7);
  const ref = /^ref: (.+)$/.exec(head)?.[1];
  if (ref === undefined || !REF.test(ref) || ref.includes('..')) return null;
  // In a worktree the branches live in the common folder.
  const common = readSmall(join(dir, 'commondir'))?.trim();
  const dirs = common === undefined ? [dir] : [dir, isAbsolute(common) ? common : resolve(dir, common)];
  for (const base of dirs) {
    const loose = readSmall(join(base, ...ref.split('/')))?.trim();
    if (loose !== undefined && SHA.test(loose)) return loose.slice(0, 7);
    const packed = readSmall(join(base, 'packed-refs'), MAX_GIT_FILE);
    const line = packed?.split('\n').find((entry) => entry.endsWith(` ${ref}`));
    const sha = line?.split(' ')[0];
    if (sha !== undefined && SHA.test(sha)) return sha.slice(0, 7);
  }
  return null;
}

export function installationInfo(home: string, developmentPasswords: boolean, declared: InstallationMode | undefined): InstallationInfo {
  return { mode: installationMode(developmentPasswords, declared), home: basename(home), version: readVersion(home) };
}
