import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import {
  AGENCY_REPOSITORY,
  AgencyError,
  buildIndex,
  MAX_AGENCY_FILE_BYTES,
  parseAgencyFile,
  parseDivisions,
  type AgencyEntry,
  type AgencyOrigin,
} from '@arianna/agents';

import {
  CatalogError,
  cleanLine,
  isRealDir,
  kindChanges,
  MAX_TREE_FILES,
  readRegular,
  sha256,
  utf8,
  type CatalogEntry,
  type CatalogGateway,
  type CatalogIndex,
  type CatalogRejection,
  type JobView,
  type KindChanges,
} from './git-catalog.ts';
import { createSourceCatalog, detectLicense, LICENSE_FILE, MAX_LICENSE_BYTES, parseSourceUrl, rootLicenseOf, SAFE_SEGMENT, SOURCE_ID, type SourceRef } from './source-catalogs.ts';

/**
 * The catalog of agents (D-079, revised 2026-10-13): roles in the format of
 * agency-agents (a Markdown file with `name` and `description` in its
 * frontmatter) from the GitHub repositories the user follows, with the
 * engine of the skills (source-catalogs.ts, D-161).
 *
 * The list is `data/catalogs/agents/sources.json`; each source lives in
 * `data/catalogs/agents/<owner>__<repo>/` with its adopted commit, version
 * waiting and busy file. Only the `.md` files that may be roles, the license
 * at the root and `divisions.json` reach the disk; nothing of the clone
 * runs. With `divisions.json` only its folders hold roles (agency-agents);
 * without it every folder of the first level is a division, and the files
 * at the root go to `general`. The index keeps names, descriptions,
 * divisions, paths and sha256, never the texts. Downloads wait in a queue,
 * one at a time, and the whole catalog stays under MAX_AGENTS_CATALOG_BYTES.
 *
 * A role becomes an agent only through a disabled card the user confirms
 * (`proposeCard`): its text is third-party data at L0, its permissions
 * come from a starting point, never from the file.
 */

/** Shown as suggestions to add with one click; never followed by themselves. */
export const AGENT_SUGGESTIONS = [AGENCY_REPOSITORY] as const;
export const MAX_AGENT_SOURCES = 100;
/** Roles of one source: agency-agents has about 230. */
export const MAX_ROLES = 2000;
/** One role file: the longest known are about 650 lines. */
export const MAX_ROLE_BYTES = MAX_AGENCY_FILE_BYTES;
/** The whole catalog on the disk: versions in use and waiting, of every source. */
export const MAX_AGENTS_CATALOG_BYTES = 512 * 1024 * 1024;
/** The division of a role at the root of a repository without `divisions.json`. */
export const ROOT_DIVISION = 'general';

const FOLDER = 'agents';
const DIVISIONS_FILE = 'divisions.json';
const MAX_DIVISIONS_BYTES = 64 * 1024;
/** How deep a role may be (game-development/unity/unity-architect.md is 3). */
const MAX_DEPTH = 6;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 400;
/** Folders of the first level that hold documentation or tools, never roles. */
const NOT_DIVISIONS = new Set(['docs', 'doc', 'examples', 'example', 'scripts', 'integrations']);
/** Files of a repository that are not roles. */
const NOT_ROLES = /^(?:README|CONTRIBUTING|CHANGELOG|SECURITY|CODE_OF_CONDUCT|SUPPORT|GOVERNANCE|NOTICE|AUTHORS|MAINTAINERS|CLAUDE|AGENTS|LICEN[CS]E|COPYING)(?:[._-][A-Za-z0-9_-]+)*\.md$/i;
/** The file name a role needs: its slug is the name of the card. */
const ROLE_FILE = /^[a-z][a-z0-9-]{0,63}\.md$/;
/** `<owner>/<repo>/<slug>`. */
const ROLE_ID = /^([a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100})\/([a-z][a-z0-9-]{0,63})$/;

export interface AgentRoleEntry extends CatalogEntry {
  kind: 'agent';
  slug: string;
  division: string;
  name: string;
  description: string;
  emoji: string | null;
  /** The role file inside the clone, with `/`. */
  path: string;
  bytes: number;
}

export interface AgentIndex extends CatalogIndex<AgentRoleEntry> {
  /** The license file at the root of the repository, with the license recognised in it and the sha256 of the file. */
  license: { name: string | null; file: string | null; sha256: string | null };
  /** The divisions with roles, sorted. */
  divisions: string[];
  /** The bytes of every file of the checkout on the disk, rejected ones included. */
  bytes: number;
}

export interface AgentPlan {
  patterns: string[];
  /** The `.md` files that may be roles, sorted. */
  files: string[];
  rootLicense: string | null;
  divisionsFile: boolean;
  rejected: CatalogRejection[];
}

export interface AgentVersionView {
  commit: string;
  committedAt: string | null;
  fetchedAt: string;
  roles: number;
  divisions: number;
  rejected: number;
  bytes: number;
}

export interface AgentSourceStatus {
  id: string;
  page: string;
  license: { name: string | null; file: string | null } | null;
  adopted: (AgentVersionView & { adoptedAt: string | null }) | null;
  pending: (AgentVersionView & { diff: KindChanges }) | null;
  job: JobView | null;
  /** Waiting for its download behind another one. */
  queued: boolean;
  /** Why it left the queue without downloading. */
  queueError: string | null;
}

export interface AgentsStatus {
  sources: AgentSourceStatus[];
  suggestions: { id: string; page: string }[];
  ignored: { entry: string; reason: string }[];
  limits: { sources: number; maxSources: number; bytes: number; maxBytes: number };
}

export interface AgentRoleItem {
  /** `<owner>/<repo>/<slug>`. */
  id: string;
  source: string;
  slug: string;
  division: string;
  name: string;
  description: string;
  emoji: string | null;
  license: string | null;
  /** The license file at the root of its source, when its license is not one recognised by name. */
  licenseFile: string | null;
}

export interface AgentRole {
  id: string;
  source: string;
  /** The role read again from the adopted checkout, checked against its index; `body` is third-party text. */
  entry: AgencyEntry;
  /** Source, adopted commit and license, for `proposeCard`. */
  origin: AgencyOrigin;
}

export interface AgentsCatalogOptions {
  /** `data/catalogs` of ARIANNA_HOME: the sources in its `agents` folder. */
  dir: string;
  /** Asked before every download, with the address of the repository only. */
  gateway: CatalogGateway;
  /** Tests only: `file://` repositories, named by their last two folders. */
  allowLocal?: boolean;
  /** As for D-160: the command passes false. */
  recover?: boolean;
  /** Tests only. */
  maxTreeFiles?: number;
  /** Tests only. */
  maxCatalogBytes?: number;
  onEvent?: (kind: string, payload: Record<string, string | number>) => void;
  env?: NodeJS.ProcessEnv;
  git?: string;
  now?: () => Date;
}

export interface AgentsCatalog {
  status(): AgentsStatus;
  add(url: unknown): AgentsStatus;
  remove(source: unknown): AgentsStatus;
  /** Starts the download, or queues it behind the one running. */
  update(source: unknown): AgentsStatus;
  adopt(source: unknown, commit: unknown): AgentsStatus;
  discard(source: unknown): AgentsStatus;
  /** Every download running and queued, for tests and the command. */
  idle(): Promise<void>;
  /** The roles of the versions in use, without texts. */
  list(): { roles: AgentRoleItem[] };
  /** One role with its text and origin. */
  role(id: unknown): AgentRole;
}

/**
 * What to check out, from the names of the tree alone: every `.md` that may
 * be a role (outside hidden folders, documentation folders and the usual
 * files of a repository), the license at the root and `divisions.json`.
 * Throws past the limits, before any content is fetched.
 */
export function planAgents(names: readonly string[], maxTreeFiles: number = MAX_TREE_FILES): AgentPlan {
  const rejected: CatalogRejection[] = [];
  const files: string[] = [];
  for (const path of [...names].sort()) {
    if (!path.endsWith('.md')) continue;
    const segments = path.split('/');
    const file = segments.at(-1) ?? '';
    if (segments.some((segment) => segment.startsWith('.'))) continue;
    if (segments.length > 1 && NOT_DIVISIONS.has((segments[0] ?? '').toLowerCase())) continue;
    if (NOT_ROLES.test(file)) continue;
    if (segments.length > MAX_DEPTH + 1) {
      rejected.push({ path: cleanLine(path, 200), reason: 'deeper than the catalog reads' });
      continue;
    }
    if (!segments.every((segment) => SAFE_SEGMENT.test(segment))) {
      rejected.push({ path: cleanLine(path, 200), reason: 'unusual characters in the path' });
      continue;
    }
    if (!ROLE_FILE.test(file)) {
      rejected.push({ path, reason: 'the file name is not lowercase letters, digits and dashes' });
      continue;
    }
    files.push(path);
  }
  if (files.length > MAX_ROLES) throw new CatalogError('invalid', `more than ${String(MAX_ROLES)} roles in the repository, nothing downloaded`);
  const rootLicense = rootLicenseOf(names);
  const divisionsFile = names.includes(DIVISIONS_FILE);
  const all = [...files, ...(rootLicense === null ? [] : [rootLicense]), ...(divisionsFile ? [DIVISIONS_FILE] : [])];
  if (all.length > maxTreeFiles) throw new CatalogError('invalid', `more than ${String(maxTreeFiles)} files in the catalog, nothing downloaded`);
  return { patterns: all.sort().map((name) => `/${name}`), files, rootLicense, divisionsFile, rejected };
}

/** The text of a file of the checkout, or why not. */
function readText(root: string, path: string, max: number): { text: string; bytes: number } | { refused: string } | undefined {
  const read = readRegular(join(root, path), max);
  if (read === undefined || 'refused' in read) return read;
  // Valid UTF-8 without NUL; the raw text keeps the sha256 of the file.
  if (utf8(read.buffer) === undefined) return { refused: 'not UTF-8 text' };
  return { text: read.buffer.toString('utf8'), bytes: read.buffer.length };
}

/** The license file at the root: a usual name, nothing else (a path read from an index is checked again here). */
function licenseOf(root: string, file: string | null): { name: string | null; text: string | null; sha256: string | null } {
  if (file === null || file.includes('/') || !LICENSE_FILE.test(file)) return { name: null, text: null, sha256: null };
  const read = readText(root, file, MAX_LICENSE_BYTES);
  // An empty file is no license, as for the card (`sourceLicensed`).
  if (read === undefined || 'refused' in read || read.text.trim() === '' || !inside(root, join(root, file))) return { name: null, text: null, sha256: null };
  return { name: detectLicense(read.text), text: read.text, sha256: sha256(read.text) };
}

/** Every folder on the way to `path` is a real one: a link written as a file stops here. */
function realFolders(root: string, path: string): boolean {
  const segments = path.split('/').slice(0, -1);
  return segments.every((_, index) => isRealDir(join(root, ...segments.slice(0, index + 1))));
}

/** The index of a checkout planned by planAgents: frontmatter only, never the bodies. */
export function scanAgents(root: string, plan: AgentPlan): Pick<AgentIndex, 'entries' | 'rejected' | 'license' | 'divisions'> {
  const rejected = [...plan.rejected];
  const license = licenseOf(root, plan.rootLicense);
  let allowed: Set<string> | null = null;
  if (plan.divisionsFile) {
    const read = readText(root, DIVISIONS_FILE, MAX_DIVISIONS_BYTES);
    if (read !== undefined && !('refused' in read)) {
      try {
        allowed = new Set(parseDivisions(read.text));
      } catch (error) {
        rejected.push({ path: DIVISIONS_FILE, reason: cleanLine(error instanceof Error ? error.message : String(error), 200) });
      }
    } else if (read !== undefined) rejected.push({ path: DIVISIONS_FILE, reason: read.refused });
  }
  const parsed: AgencyEntry[] = [];
  const sizes = new Map<string, number>();
  for (const path of plan.files) {
    if (!realFolders(root, path)) {
      rejected.push({ path, reason: 'not a real folder' });
      continue;
    }
    const read = readText(root, path, MAX_ROLE_BYTES);
    if (read === undefined) continue;
    if ('refused' in read) {
      rejected.push({ path, reason: read.refused });
      continue;
    }
    let entry: AgencyEntry;
    try {
      entry = parseAgencyFile(read.text, path, { rootDivision: ROOT_DIVISION });
    } catch (error) {
      rejected.push({ path, reason: cleanLine(error instanceof AgencyError ? error.message.replace(`${path}: `, '') : 'unreadable', 200) });
      continue;
    }
    // With divisions.json only its folders hold roles: the others are documents (strategy/ of agency-agents).
    if (allowed !== null && !allowed.has(entry.division)) {
      rejected.push({ path, reason: 'not in a division of divisions.json' });
      continue;
    }
    parsed.push(entry);
    sizes.set(path, read.bytes);
  }
  const index = buildIndex(parsed);
  rejected.push(...index.rejected);
  const entries: AgentRoleEntry[] = index.entries.map((entry) => {
    const size = sizes.get(entry.path) ?? 0;
    return {
      kind: 'agent',
      slug: entry.slug,
      division: entry.division,
      name: cleanLine(entry.name, MAX_NAME) || entry.slug,
      description: cleanLine(entry.description, MAX_DESCRIPTION),
      emoji: entry.emoji === undefined ? null : cleanLine(entry.emoji, 16) || null,
      path: entry.path,
      sha256: entry.sha256,
      bytes: size,
    };
  });
  return {
    license: { name: license.name, file: license.sha256 === null ? null : plan.rootLicense, sha256: license.sha256 },
    entries,
    rejected: rejected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    divisions: [...new Set(entries.map((entry) => entry.division))].sort(),
  };
}

/** The segments of a role path read from an index, checked as planAgents checked the names of the tree. */
export function indexedRolePath(path: string, slug: string): string[] {
  const segments = path.split('/');
  const fine =
    segments.length <= MAX_DEPTH + 1 &&
    segments.at(-1) === `${slug}.md` &&
    segments.every((segment) => segment !== '..' && !segment.startsWith('.') && SAFE_SEGMENT.test(segment)) &&
    !(segments.length > 1 && NOT_DIVISIONS.has((segments[0] ?? '').toLowerCase()));
  if (!fine) throw new CatalogError('conflict', 'the index of this source names an unexpected path');
  return segments;
}

/** Whether `path`, links resolved, lies inside `root`, links resolved too. */
function inside(root: string, path: string): boolean {
  try {
    return realpathSync(path).startsWith(`${realpathSync(root)}${sep}`);
  } catch {
    return false;
  }
}

function versionView(index: AgentIndex): AgentVersionView {
  return {
    commit: index.commit,
    committedAt: index.committedAt,
    fetchedAt: index.fetchedAt,
    roles: index.entries.length,
    divisions: index.divisions.length,
    rejected: index.rejected.length,
    bytes: index.bytes,
  };
}

export function createAgentsCatalog(options: AgentsCatalogOptions): AgentsCatalog {
  const maxTreeFiles = options.maxTreeFiles ?? MAX_TREE_FILES;
  const maxBytes = options.maxCatalogBytes ?? MAX_AGENTS_CATALOG_BYTES;

  /** The bytes on the disk of every version in use and waiting, but the one waiting of `except`. */
  function usedBytes(except?: string): number {
    let total = 0;
    for (const item of engine.followed()) {
      const source = engine.sourceFor(item);
      total += source.adopted()?.index.bytes ?? 0;
      if (item.id !== except) total += source.pending()?.bytes ?? 0;
    }
    return total;
  }

  const engine = createSourceCatalog<AgentIndex, AgentPlan>({
    dir: options.dir,
    folder: FOLDER,
    events: 'agents-catalog',
    noun: 'agents',
    maxSources: MAX_AGENT_SOURCES,
    maxTreeFiles,
    gateway: options.gateway,
    serial: true,
    plan: (names) => planAgents(names, maxTreeFiles),
    build: (root, plan, { links, ...head }, ref, measured) => {
      const scan = scanAgents(root, plan);
      // Every file on the disk, rejected ones too; the version downloaded counts beside the one in use until one of them goes.
      const total = usedBytes(ref.id) + measured.bytes;
      if (total > maxBytes) {
        throw new CatalogError('invalid', `the catalog of agents would take ${String(Math.ceil(total / 1024 / 1024))} MiB, more than ${String(Math.round(maxBytes / 1024 / 1024))} MiB`);
      }
      return {
        ...head,
        ...scan,
        bytes: measured.bytes,
        rejected: [...scan.rejected, ...links.map((path) => ({ path, reason: 'symbolic link' }))].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      };
    },
    counts: (index) => ({ roles: index.entries.length, divisions: index.divisions.length }),
    ...(options.allowLocal === undefined ? {} : { allowLocal: options.allowLocal }),
    ...(options.recover === undefined ? {} : { recover: options.recover }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  function status(): AgentsStatus {
    const list = engine.sources();
    const sources: AgentSourceStatus[] = list.followed.map((item) => {
      const source = engine.sourceFor(item);
      const current = source.adopted();
      const next = source.pending();
      return {
        id: item.id,
        page: item.page,
        license: next?.license ?? current?.index.license ?? null,
        adopted: current === undefined ? null : { ...versionView(current.index), adoptedAt: current.lock.adoptedAt },
        pending: next === undefined ? null : { ...versionView(next), diff: kindChanges(current?.index.entries ?? [], next.entries, 'agent') },
        job: source.job(),
        queued: engine.queued(item.id),
        queueError: engine.queueError(item.id) ?? null,
      };
    });
    const ids = new Set(sources.map((source) => source.id));
    const suggestions = AGENT_SUGGESTIONS.map((url) => parseSourceUrl(url)).filter((ref) => !ids.has(ref.id)).map(({ id, page }) => ({ id, page }));
    return {
      sources,
      suggestions,
      ignored: list.ignored,
      limits: { sources: list.followed.length, maxSources: MAX_AGENT_SOURCES, bytes: usedBytes(), maxBytes },
    };
  }

  function list(): { roles: AgentRoleItem[] } {
    const roles: AgentRoleItem[] = [];
    for (const item of engine.followed()) {
      const current = engine.sourceFor(item).adopted();
      for (const entry of current?.index.entries ?? []) {
        roles.push({
          id: `${item.id}/${entry.slug}`,
          source: item.id,
          slug: entry.slug,
          division: entry.division,
          name: entry.name,
          description: entry.description,
          emoji: entry.emoji,
          license: current?.index.license.name ?? null,
          licenseFile: current?.index.license.file ?? null,
        });
      }
    }
    return { roles: roles.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en')) };
  }

  function role(id: unknown): AgentRole {
    const match = typeof id === 'string' ? ROLE_ID.exec(id) : null;
    if (match === null) throw new CatalogError('invalid', 'a role is <owner>/<repo>/<slug>');
    const [, sourceId = '', slug = ''] = match;
    if (!SOURCE_ID.test(sourceId)) throw new CatalogError('invalid', 'a role is <owner>/<repo>/<slug>');
    const item = engine.followed().find((source) => source.id === sourceId);
    if (item === undefined) throw new CatalogError('not-found', 'no such source of agents');
    const source = engine.sourceFor(item);
    const current = source.adopted();
    if (current === undefined) throw new CatalogError('not-found', 'this source has not been downloaded');
    const indexed = current.index.entries.find((candidate) => candidate.slug === slug);
    if (indexed === undefined) throw new CatalogError('not-found', 'no such role in the catalog');
    // The index is a file on the disk: its path is checked as the plan checked the names of the tree.
    const segments = indexedRolePath(indexed.path, slug);
    if (!realFolders(source.root, indexed.path)) throw new CatalogError('not-found', 'the role is no longer on the disk');
    const path = join(source.root, ...segments);
    if (!inside(source.root, path)) throw new CatalogError('conflict', 'the index names a file outside the folder of the source');
    const read = readText(source.root, indexed.path, MAX_ROLE_BYTES);
    if (read === undefined || 'refused' in read) throw new CatalogError('not-found', 'the role is no longer on the disk');
    if (sha256(read.text) !== indexed.sha256) throw new CatalogError('conflict', 'the role changed on the disk since it was indexed');
    let entry: AgencyEntry;
    try {
      entry = parseAgencyFile(read.text, indexed.path, { rootDivision: ROOT_DIVISION });
    } catch {
      throw new CatalogError('conflict', 'the role no longer reads as it was indexed');
    }
    // The license is the one indexed: its name checked again, its sha256 the same, else none.
    const indexedLicense = current.index.license;
    const license = licenseOf(source.root, indexedLicense.file);
    if (indexedLicense.file !== null && (license.sha256 === null || license.sha256 !== indexedLicense.sha256)) {
      throw new CatalogError('conflict', 'the license of the source changed on the disk since it was indexed');
    }
    return {
      id: `${sourceId}/${slug}`,
      source: sourceId,
      entry,
      origin: { repository: item.page, commit: current.index.commit, license: { name: license.name, file: indexedLicense.file, text: license.text } },
    };
  }

  return {
    status,
    add: (url) => {
      engine.add(url);
      return status();
    },
    remove: (value) => {
      engine.remove(value);
      return status();
    },
    update: (value) => {
      engine.update(value);
      return status();
    },
    adopt: (value, commit) => {
      engine.adopt(value, commit);
      return status();
    },
    discard: (value) => {
      engine.discard(value);
      return status();
    },
    idle: () => engine.idle(),
    list,
    role,
  };
}

export type { SourceRef as AgentSourceRef };
