import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

import { CatalogError, cleanBody, cleanLine, frontmatter, isRealDir, MAX_TREE_BYTES, readRegular, releaseBusy, sha256, SLUG, takeBusy, utf8, writeAtomic } from './git-catalog.ts';
import { detectLicense, LICENSE_FILE, MAX_LICENSE_BYTES, SAFE_SEGMENT, skillSlug } from './source-catalogs.ts';

/**
 * The user's own skills of Claude Code in the catalog of skills (D-255): the
 * folders `skills/<name>/SKILL.md` of the configuration of Claude Code
 * (`$CLAUDE_CONFIG_DIR`, else `.claude` in the home), copied only when the
 * user asks («Importa», «Aggiorna»), into `data/catalogs/skills-claude/`.
 *
 * Only each SKILL.md and the license file beside it are copied, as plain
 * files; scripts and resources are counted, never copied nor run; a
 * symbolic link is refused, anywhere. Limits as for the GitHub sources.
 *
 * Privacy: the text of a personal skill may hold personal data, so each one
 * is private (L2, default-deny) until the user marks it as shareable (L1),
 * one by one; the mark holds for that exact text (its sha256): a text changed
 * after the mark is private again. A private skill never reaches an agent in
 * the cloud, and no personal skill is ever exempt from the second check of
 * personal data (D-250 applies to the adopted catalogs only).
 */

/** The id of the source: `local` is not a GitHub repository the catalog would follow (add refuses it). */
export const CLAUDE_SOURCE = 'local/claude-code';

export const MAX_CLAUDE_SKILL_BYTES = 256 * 1024;
export const MAX_CLAUDE_SKILLS = 2000;
/** The scripts and resources of a skill counted, at most (never read). */
const MAX_COUNTED = 10_000;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 400;
const MAX_LICENSE_FIELD = 160;
const LICENSE_NAMES = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE', 'LICENCE.txt', 'LICENCE.md', 'COPYING', 'COPYING.txt', 'COPYING.md'];

const FOLDER = 'skills-claude';
const INDEX = 'index.json';
const SHARED = 'shared.json';
const BUSY = '.busy';
const FILES = 'files';

export interface ClaudeSkillEntry {
  slug: string;
  name: string;
  description: string;
  /** The folder in the user's configuration, with SKILL.md: `<folder>/SKILL.md`. */
  path: string;
  sha256: string;
  bytes: number;
  license: string | null;
  /** The license file copied beside it, by its name. */
  licenseFile: string | null;
  /** Scripts and resources of the folder: counted, never copied. */
  otherFiles: number;
}

export interface ClaudeSkillsIndex {
  version: 1;
  importedAt: string;
  entries: ClaudeSkillEntry[];
  rejected: { path: string; reason: string }[];
}

export interface ClaudeSkillView {
  id: string;
  slug: string;
  name: string;
  description: string;
  license: string | null;
  otherFiles: number;
  /** The text this view describes: «Rendi condivisibile» sends it back. */
  sha256: string;
  /** L2 private (the default), L1 marked shareable by the user for this exact text. */
  label: 'L1' | 'L2';
}

export interface ClaudeSkillsStatus {
  imported: boolean;
  importedAt: string | null;
  skills: ClaudeSkillView[];
  /** Folders left out at the last import, with the reason (names of folders only). */
  rejected: { path: string; reason: string }[];
}

export interface ClaudeSkillRead {
  entry: ClaudeSkillEntry;
  importedAt: string;
  label: 'L1' | 'L2';
  /** The body of the SKILL.md, hidden characters out. */
  body: string;
}

export interface ClaudeSkillsOptions {
  /** `data/catalogs` of ARIANNA_HOME. */
  dir: string;
  /** Where `CLAUDE_CONFIG_DIR` is read; tests point it at a fake folder. */
  env: NodeJS.ProcessEnv;
  /** The user's home, for `.claude` without `CLAUDE_CONFIG_DIR`. */
  home: string;
  now?: () => Date;
  /** Counts only: never a name of a skill, never a text. */
  onEvent?: (kind: string, payload: Record<string, string | number>) => void;
}

export interface ClaudeSkills {
  status(): ClaudeSkillsStatus;
  /** Reads the folder again and replaces the copy («Importa», «Aggiorna»); the shareable marks of unchanged texts stay. */
  import(): ClaudeSkillsStatus;
  /** Deletes the copy and the marks («Togli»). */
  remove(): ClaudeSkillsStatus;
  /**
   * Marks a skill shareable (L1) for its current text, or private again (L2). Sharing needs `sha256`, the text the user
   * read: a text changed since (an import from elsewhere) is refused, never shared unseen.
   */
  share(slug: unknown, shared: unknown, sha256?: unknown): ClaudeSkillsStatus;
  /** Undefined: not imported. */
  labelOf(slug: string): 'L1' | 'L2' | undefined;
  read(slug: string): ClaudeSkillRead;
  entries(): (ClaudeSkillEntry & { label: 'L1' | 'L2' })[];
}

/** The skills folder of the configuration of Claude Code: `$CLAUDE_CONFIG_DIR/skills`, else `<home>/.claude/skills`. */
export function claudeSkillsDir(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && configured !== '') {
    if (!isAbsolute(configured)) throw new CatalogError('invalid', 'CLAUDE_CONFIG_DIR is not an absolute path');
    return join(configured, 'skills');
  }
  if (home === '' || !isAbsolute(home)) throw new CatalogError('invalid', 'no home folder to find the configuration of Claude Code');
  return join(home, '.claude', 'skills');
}

function readJson(path: string): unknown {
  const read = readRegular(path, 4 * 1024 * 1024);
  if (read === undefined || 'refused' in read) return undefined;
  try {
    return JSON.parse(read.buffer.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function readIndex(path: string): ClaudeSkillsIndex | undefined {
  const raw = readJson(path) as Partial<ClaudeSkillsIndex> | undefined;
  if (raw?.version !== 1 || !Array.isArray(raw.entries) || typeof raw.importedAt !== 'string') return undefined;
  const entries = (raw.entries as unknown[]).filter(
    (entry): entry is ClaudeSkillEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      'slug' in entry &&
      'sha256' in entry &&
      'name' in entry && typeof entry.slug === 'string' && SLUG.test(entry.slug) && typeof entry.sha256 === 'string' && typeof entry.name === 'string',
  );
  return { version: 1, importedAt: raw.importedAt, entries, rejected: Array.isArray(raw.rejected) ? raw.rejected : [] };
}

function readShared(path: string): Record<string, string> {
  const raw = readJson(path) as { version?: unknown; shared?: unknown } | undefined;
  if (raw?.version !== 1 || typeof raw.shared !== 'object' || raw.shared === null) return {};
  return Object.fromEntries(Object.entries(raw.shared as Record<string, unknown>).filter((pair): pair is [string, string] => SLUG.test(pair[0]) && typeof pair[1] === 'string'));
}

/** The files of a folder, without following links, up to MAX_COUNTED. */
function countFiles(path: string, depth = 0): number {
  if (depth > 8) return 0;
  let count = 0;
  let names;
  try {
    names = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const item of names) {
    if (count >= MAX_COUNTED) break;
    if (item.isDirectory()) count += countFiles(join(path, item.name), depth + 1);
    else count += 1;
  }
  return Math.min(count, MAX_COUNTED);
}

interface Planned {
  entry: ClaudeSkillEntry;
  body: Buffer;
  license: { name: string; buffer: Buffer } | undefined;
}

/** Each folder of the skills directory: its SKILL.md and the license beside it, read and checked; never anything else. */
export function scanClaudeSkills(root: string): { planned: Planned[]; rejected: { path: string; reason: string }[] } {
  const rejected: { path: string; reason: string }[] = [];
  const planned: Planned[] = [];
  const slugs = new Map<string, string>();
  let total = 0;
  const items = readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    const shown = cleanLine(item.name, 120);
    if (item.isSymbolicLink()) {
      rejected.push({ path: shown, reason: 'symbolic link' });
      continue;
    }
    if (!item.isDirectory()) continue;
    if (!SAFE_SEGMENT.test(item.name)) {
      rejected.push({ path: shown, reason: 'unusual characters in the name' });
      continue;
    }
    const slug = skillSlug(item.name);
    if (!SLUG.test(slug)) {
      rejected.push({ path: shown, reason: 'the folder name is not a valid slug' });
      continue;
    }
    const taken = slugs.get(slug);
    if (taken !== undefined) {
      rejected.push({ path: shown, reason: `same slug as ${taken}` });
      continue;
    }
    const folder = join(root, item.name);
    const path = `${item.name}/SKILL.md`;
    // Checked again right before reading: a folder swapped for a link since the listing is refused.
    if (!isRealDir(folder)) {
      rejected.push({ path: shown, reason: 'symbolic link' });
      continue;
    }
    const read = readRegular(join(folder, 'SKILL.md'), MAX_CLAUDE_SKILL_BYTES);
    if (read === undefined) {
      rejected.push({ path: shown, reason: 'no SKILL.md' });
      continue;
    }
    if ('refused' in read) {
      rejected.push({ path, reason: read.refused });
      continue;
    }
    const text = utf8(read.buffer);
    if (text === undefined) {
      rejected.push({ path, reason: 'not UTF-8 text' });
      continue;
    }
    let front: Record<string, unknown> | undefined;
    try {
      front = frontmatter(text, path, ['name', 'description', 'license']);
    } catch (error) {
      rejected.push({ path, reason: cleanLine(error instanceof Error ? error.message : String(error), 200) });
      continue;
    }
    if (front === undefined) {
      rejected.push({ path, reason: 'no frontmatter' });
      continue;
    }
    // The license file beside it: a regular file only, never a link.
    let license: Planned['license'];
    for (const name of LICENSE_NAMES) {
      const file = readRegular(join(folder, name), MAX_LICENSE_BYTES);
      if (file !== undefined && !('refused' in file) && LICENSE_FILE.test(name)) {
        license = { name, buffer: file.buffer };
        break;
      }
    }
    const declared = cleanLine(front.license, MAX_LICENSE_FIELD);
    const recognised = license === undefined ? null : detectLicense(utf8(license.buffer) ?? '');
    const licenseName = declared !== '' ? declared : (recognised ?? (license === undefined ? null : `see ${license.name}`));
    total += read.buffer.length + (license?.buffer.length ?? 0);
    if (total > MAX_TREE_BYTES) throw new CatalogError('invalid', `more than ${String(MAX_TREE_BYTES / 1024 / 1024)} MB of skills, nothing copied`);
    slugs.set(slug, item.name);
    const other = countFiles(folder) - 1 - (license === undefined ? 0 : 1);
    planned.push({
      entry: {
        slug,
        name: cleanLine(front.name, MAX_NAME) || slug,
        description: cleanLine(front.description, MAX_DESCRIPTION),
        path,
        sha256: sha256(read.buffer),
        bytes: read.buffer.length,
        license: licenseName,
        licenseFile: license?.name ?? null,
        otherFiles: Math.max(0, other),
      },
      body: read.buffer,
      license,
    });
    if (planned.length > MAX_CLAUDE_SKILLS) throw new CatalogError('invalid', `more than ${String(MAX_CLAUDE_SKILLS)} skills, nothing copied`);
  }
  return { planned, rejected };
}

/** Whether `path`, links resolved, lies inside `root`. */
function inside(root: string, path: string): boolean {
  try {
    return realpathSync(path).startsWith(`${realpathSync(root)}${sep}`);
  } catch {
    return false;
  }
}

export function createClaudeSkills(options: ClaudeSkillsOptions): ClaudeSkills {
  const base = join(options.dir, FOLDER);
  const indexPath = join(base, INDEX);
  const sharedPath = join(base, SHARED);
  const busyPath = join(base, BUSY);
  const now = (): Date => options.now?.() ?? new Date();
  const event = (kind: string, payload: Record<string, string | number>): void => {
    try {
      options.onEvent?.(kind, payload);
    } catch {
      // An event that cannot be written never stops the step.
    }
  };

  function labelFor(entry: ClaudeSkillEntry, shared: Record<string, string>): 'L1' | 'L2' {
    return Object.hasOwn(shared, entry.slug) && shared[entry.slug] === entry.sha256 ? 'L1' : 'L2';
  }

  function entries(): (ClaudeSkillEntry & { label: 'L1' | 'L2' })[] {
    const index = readIndex(indexPath);
    if (index === undefined) return [];
    const shared = readShared(sharedPath);
    return index.entries.map((entry) => ({ ...entry, label: labelFor(entry, shared) }));
  }

  function status(): ClaudeSkillsStatus {
    const index = readIndex(indexPath);
    if (index === undefined) return { imported: false, importedAt: null, skills: [], rejected: [] };
    const shared = readShared(sharedPath);
    return {
      imported: true,
      importedAt: index.importedAt,
      skills: index.entries.map((entry) => ({
        id: `${CLAUDE_SOURCE}/${entry.slug}`,
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        license: entry.license,
        otherFiles: entry.otherFiles,
        sha256: entry.sha256,
        label: labelFor(entry, shared),
      })),
      rejected: index.rejected,
    };
  }

  function locked<T>(work: () => T): T {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    if (!takeBusy(busyPath, token)) throw new CatalogError('conflict', 'your skills of Claude Code are being changed by another process');
    try {
      return work();
    } finally {
      releaseBusy(busyPath, token);
    }
  }

  function importSkills(): ClaudeSkillsStatus {
    const root = claudeSkillsDir(options.env, options.home);
    let stat;
    try {
      stat = lstatSync(root);
    } catch {
      throw new CatalogError('not-found', 'no skills folder in the configuration of Claude Code');
    }
    if (stat.isSymbolicLink()) throw new CatalogError('invalid', 'the skills folder of Claude Code is a symbolic link: it is not read');
    if (!stat.isDirectory()) throw new CatalogError('not-found', 'no skills folder in the configuration of Claude Code');
    const scan = scanClaudeSkills(root);
    locked(() => {
      const next = join(base, `${FILES}.next`);
      const old = join(base, `${FILES}.old`);
      rmSync(next, { recursive: true, force: true });
      rmSync(old, { recursive: true, force: true });
      mkdirSync(next, { mode: 0o700 });
      for (const item of scan.planned) {
        const folder = join(next, item.entry.slug);
        mkdirSync(folder, { mode: 0o700 });
        // Plain files, written by us: never a mode, a link or a name of the source.
        writeFileSync(join(folder, 'SKILL.md'), item.body, { mode: 0o600 });
        if (item.license !== undefined) writeFileSync(join(folder, item.license.name), item.license.buffer, { mode: 0o600 });
      }
      const current = join(base, FILES);
      if (existsSync(current)) renameSync(current, old);
      renameSync(next, current);
      writeAtomic(indexPath, { version: 1, importedAt: now().toISOString(), entries: scan.planned.map((item) => item.entry), rejected: scan.rejected } satisfies ClaudeSkillsIndex);
      rmSync(old, { recursive: true, force: true });
      // The marks of the texts gone or changed go too: a changed text is private again.
      const shared = readShared(sharedPath);
      const kept = Object.fromEntries(scan.planned.filter((item) => shared[item.entry.slug] === item.entry.sha256).map((item) => [item.entry.slug, item.entry.sha256]));
      writeAtomic(sharedPath, { version: 1, shared: kept });
    });
    event('skills-claude.imported', { skills: scan.planned.length, rejected: scan.rejected.length });
    return status();
  }

  function remove(): ClaudeSkillsStatus {
    if (!existsSync(base)) return status();
    locked(() => {
      for (const name of [INDEX, SHARED, FILES, `${FILES}.next`, `${FILES}.old`, `${INDEX}.tmp`, `${SHARED}.tmp`]) rmSync(join(base, name), { recursive: true, force: true });
    });
    try {
      // The folder itself only when nothing else is left in it.
      if (isRealDir(base) && readdirSync(base).length === 0) rmSync(base, { recursive: true });
    } catch {
      // Left as it is.
    }
    event('skills-claude.removed', {});
    return status();
  }

  function share(slug: unknown, shared: unknown, expected?: unknown): ClaudeSkillsStatus {
    if (typeof slug !== 'string' || !SLUG.test(slug)) throw new CatalogError('invalid', 'a skill is named by its slug');
    if (typeof shared !== 'boolean') throw new CatalogError('invalid', 'shared is true or false');
    locked(() => {
      const index = readIndex(indexPath);
      const entry = index?.entries.find((item) => item.slug === slug);
      if (entry === undefined) throw new CatalogError('not-found', 'no such skill among yours');
      if (shared && expected !== entry.sha256) throw new CatalogError('conflict', 'the skill changed since you read it: read it again');
      const others = Object.entries(readShared(sharedPath)).filter(([key]) => key !== slug);
      writeAtomic(sharedPath, { version: 1, shared: Object.fromEntries(shared ? [...others, [slug, entry.sha256]] : others) });
    });
    event('skills-claude.shared', { label: shared ? 'L1' : 'L2' });
    return status();
  }

  function read(slug: string): ClaudeSkillRead {
    const index = readIndex(indexPath);
    if (index === undefined) throw new CatalogError('not-found', 'your skills of Claude Code have not been imported');
    const entry = index.entries.find((item) => item.slug === slug);
    if (entry === undefined || !SLUG.test(slug)) throw new CatalogError('not-found', 'no such skill in the catalog');
    const folder = join(base, FILES, slug);
    const path = join(folder, 'SKILL.md');
    if (!isRealDir(join(base, FILES)) || !isRealDir(folder) || !inside(base, path)) throw new CatalogError('not-found', 'the skill is no longer on the disk');
    const file = readRegular(path, MAX_CLAUDE_SKILL_BYTES);
    if (file === undefined || 'refused' in file) throw new CatalogError('not-found', 'the skill is no longer on the disk');
    if (sha256(file.buffer) !== entry.sha256) throw new CatalogError('conflict', 'the skill changed on the disk since it was indexed');
    return { entry, importedAt: index.importedAt, label: labelFor(entry, readShared(sharedPath)), body: cleanBody(utf8(file.buffer) ?? '') };
  }

  return {
    status,
    import: importSkills,
    remove,
    share,
    labelOf: (slug) => entries().find((entry) => entry.slug === slug)?.label,
    read,
    entries,
  };
}
