import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CatalogError,
  cleanLine,
  createGitSource,
  PENDING_MESSAGE,
  readRegular,
  releaseBusy,
  takeBusy,
  writeAtomic,
  type CatalogGateway,
  type CatalogIndex,
  type GitSource,
  type TreeSize,
} from './git-catalog.ts';

/**
 * The engine of a catalog made of many GitHub sources (D-161 for skills,
 * D-079 for agents): the list `<folder>/sources.json` in `data/catalogs`,
 * follow and stop following, and for each source the mechanism of
 * git-catalog.ts in `<folder>/<owner>__<repo>/` (adopted checkout, version
 * waiting, busy file). What a source checks out and how it is indexed is
 * the catalog's own (`plan`, `build`). With `serial`, one download runs at a
 * time in this process and the others wait in a queue.
 */

/** `https://github.com/<owner>/<repo>`, nothing else: owner as GitHub allows it, repo without `/`. */
const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/;
/** A segment of a path the sparse checkout may name exactly: no glob, no space, no hidden folder. */
export const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
export const LICENSE_FILE = /^(?:LICEN[CS]E|COPYING)(?:\.(?:txt|md))?$/i;
/** The id of a source: `owner/repo`, lowercase. */
export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
export const MAX_LICENSE_BYTES = 64 * 1024;

const SOURCES = 'sources.json';
const SOURCES_BUSY = 'sources.busy';
const PREFIX = 'source';

export interface SourceRef {
  /** `owner/repo`, lowercase. */
  id: string;
  /** What git clones. */
  repository: string;
  /** Where the user reads it. */
  page: string;
}

export interface FollowedSource extends SourceRef {
  addedAt: string;
}

/** The source of an address: `https://github.com/<owner>/<repo>` (a final `.git` or `/` is dropped), or `file://` in tests. */
export function parseSourceUrl(value: unknown, allowLocal = false): SourceRef {
  if (typeof value !== 'string') throw new CatalogError('invalid', 'the address must be https://github.com/<owner>/<repo>');
  const given = value.trim().replace(/\/$/, '').replace(/\.git$/, '');
  const match = GITHUB.exec(given);
  if (match !== null) {
    const [, owner = '', repo = ''] = match;
    if (repo === '.' || repo === '..') throw new CatalogError('invalid', 'the address must be https://github.com/<owner>/<repo>');
    const page = `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`;
    return { id: `${owner.toLowerCase()}/${repo.toLowerCase()}`, repository: `${page}.git`, page };
  }
  if (allowLocal && /^file:\/\/\/[^\s?#]+$/.test(value)) {
    const parts = value.replace(/\/$/, '').split('/');
    const id = `${parts.at(-2) ?? ''}/${parts.at(-1) ?? ''}`.toLowerCase();
    if (SOURCE_ID.test(id)) return { id, repository: value, page: value };
  }
  throw new CatalogError('invalid', 'the address must be https://github.com/<owner>/<repo>');
}

/** The folder of a source: owners have no `_`, so `__` never meets in two ids. */
export function folderOf(id: string): string {
  return id.replace('/', '__');
}

/** The license a license file states, when it is a common one; null for any other text. */
export function detectLicense(text: string): string | null {
  const head = text.slice(0, 4000);
  if (/Apache License/i.test(head) && /Version 2\.0/.test(head)) return 'Apache-2.0';
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(head)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(head)) return 'LGPL';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(head)) return /Version 2,/.test(head) ? 'GPL-2.0' : 'GPL-3.0';
  if (/Mozilla Public License,? Version 2\.0/i.test(head)) return 'MPL-2.0';
  if (/^\s*MIT License/i.test(head) || /Permission is hereby granted, free of charge/.test(head)) return 'MIT';
  if (/ISC License/.test(head) || /Permission to use, copy, modify, and\/or distribute this software for any purpose/.test(head)) return 'ISC';
  if (/Redistribution and use in source and binary forms/.test(head)) return /Neither the name/.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/Attribution 4\.0 International/.test(head)) return /ShareAlike/.test(head) ? 'CC-BY-SA-4.0' : 'CC-BY-4.0';
  if (/free and unencumbered software released into the public domain/.test(head)) return 'Unlicense';
  if (/CC0 1\.0 Universal/.test(head)) return 'CC0-1.0';
  return null;
}

/** The license file at the root of a list of names, the first in order; null without one. */
export function rootLicenseOf(names: readonly string[]): string | null {
  return names.filter((name) => !name.includes('/') && LICENSE_FILE.test(name)).sort()[0] ?? null;
}

interface SourcesFile {
  version: 1;
  sources: FollowedSource[];
}

function readSources(path: string): FollowedSource[] {
  const read = readRegular(path, 256 * 1024);
  if (read === undefined || 'refused' in read) return [];
  try {
    const parsed = JSON.parse(read.buffer.toString('utf8')) as { version?: unknown; sources?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.sources)) return [];
    return (parsed.sources as unknown[]).filter((item): item is FollowedSource => {
      if (typeof item !== 'object' || item === null) return false;
      const source = item as Record<string, unknown>;
      return typeof source.id === 'string' && typeof source.repository === 'string' && typeof source.page === 'string' && typeof source.addedAt === 'string';
    });
  } catch {
    return [];
  }
}

export interface SourceCatalogSpec<I extends CatalogIndex, P> {
  /** `data/catalogs` of ARIANNA_HOME. */
  dir: string;
  /** The folder of this catalog in `dir`: `skills`, `agents`. */
  folder: string;
  /** Kind of the events: `<events>.added`, `.removed`, `.queued`, and those of each source. */
  events: string;
  /** What the sources hold, in the messages: `skills`, `agents`. */
  noun: string;
  maxSources: number;
  maxTreeFiles: number;
  gateway: CatalogGateway;
  /** From the names of every file of HEAD: the sparse patterns, or a refusal. */
  plan: (names: readonly string[], ref: SourceRef) => P & { patterns: readonly string[] };
  /** The index of the checkout, without `.git`: throws to refuse the version. */
  build: (root: string, plan: P, base: Omit<CatalogIndex, 'entries' | 'rejected'> & { links: string[] }, ref: SourceRef, measured: TreeSize) => I;
  counts: (index: I) => Record<string, number>;
  /** An id this catalog never follows itself (Open Design for skills), with the refusals of add and of every other step. */
  reserved?: { id: string; add: string; other: string };
  /** One download at a time; the others wait in a queue. */
  serial?: boolean;
  /** Tests only: `file://` repositories, named by their last two folders. */
  allowLocal?: boolean;
  /** As for D-160: the command passes false. */
  recover?: boolean;
  onEvent?: (kind: string, payload: Record<string, string | number>) => void;
  env?: NodeJS.ProcessEnv;
  git?: string;
  now?: () => Date;
}

export interface SourceCatalog<I extends CatalogIndex> {
  /** The folder of the catalog: `data/catalogs/<folder>`. */
  readonly base: string;
  /** The list as written, each address checked again, and what was left out with why. */
  sources(): { followed: FollowedSource[]; ignored: { entry: string; reason: string }[] };
  followed(): FollowedSource[];
  sourceFor(ref: SourceRef): GitSource<I>;
  /** A followed source, by id or address. */
  find(value: unknown): { ref: SourceRef; source: GitSource<I> };
  /** Follows a repository; nothing is downloaded until "Scarica". */
  add(url: unknown): SourceRef;
  /** Stops following it and deletes its files. */
  remove(value: unknown): SourceRef;
  /** Starts the download, or with `serial` queues it behind the one running. */
  update(value: unknown): void;
  adopt(value: unknown, commit: unknown): I;
  discard(value: unknown): void;
  /** Whether a source waits in the queue. */
  queued(id: string): boolean;
  /** Why a source left the queue without downloading, until its next update. */
  queueError(id: string): string | undefined;
  /** Every download running and queued. */
  idle(): Promise<void>;
}

export function createSourceCatalog<I extends CatalogIndex, P>(spec: SourceCatalogSpec<I, P>): SourceCatalog<I> {
  const allowLocal = spec.allowLocal === true;
  const base = join(spec.dir, spec.folder);
  const sourcesPath = join(base, SOURCES);
  const opened = new Map<string, GitSource<I>>();
  const waiting: string[] = [];
  const queueErrors = new Map<string, string>();
  const now = (): Date => spec.now?.() ?? new Date();

  function sourceFor(ref: SourceRef): GitSource<I> {
    const known = opened.get(ref.id);
    if (known !== undefined && known.repository === ref.repository) return known;
    const source = createGitSource<I, P>({
      dir: join(base, folderOf(ref.id)),
      prefix: PREFIX,
      repository: ref.repository,
      gateway: spec.gateway,
      events: spec.events,
      maxTreeFiles: spec.maxTreeFiles,
      plan: (names) => spec.plan(names, ref),
      build: (root, plan, head, measured) => spec.build(root, plan, head, ref, measured),
      counts: spec.counts,
      ...(spec.recover === undefined ? {} : { recover: spec.recover }),
      ...(spec.onEvent === undefined ? {} : { onEvent: (kind: string, payload: Record<string, string | number>) => spec.onEvent?.(kind, { source: ref.id, ...payload }) }),
      ...(spec.env === undefined ? {} : { env: spec.env }),
      ...(spec.git === undefined ? {} : { git: spec.git }),
      ...(spec.now === undefined ? {} : { now: spec.now }),
    });
    opened.set(ref.id, source);
    return source;
  }

  function sources(): { followed: FollowedSource[]; ignored: { entry: string; reason: string }[] } {
    const ignored: { entry: string; reason: string }[] = [];
    const followed = readSources(sourcesPath).flatMap((item) => {
      const entry = cleanLine(item.page, 200) || cleanLine(item.id, 200);
      try {
        const ref = parseSourceUrl(item.page, allowLocal);
        if (ref.id === item.id) return [{ ...ref, addedAt: item.addedAt }];
        ignored.push({ entry, reason: `the id ${cleanLine(item.id, 120)} does not match the address` });
      } catch (error) {
        ignored.push({ entry, reason: error instanceof CatalogError ? error.message : 'not a valid address' });
      }
      return [];
    });
    return { followed, ignored };
  }
  const followed = (): FollowedSource[] => sources().followed;

  function find(value: unknown): { ref: SourceRef; source: GitSource<I> } {
    if (spec.reserved !== undefined && value === spec.reserved.id) throw new CatalogError('conflict', spec.reserved.other);
    const id = typeof value === 'string' && SOURCE_ID.test(value) ? value : parseSourceUrl(value, allowLocal).id;
    const item = followed().find((source) => source.id === id);
    if (item === undefined) throw new CatalogError('not-found', `no such source of ${spec.noun}`);
    const ref = { id: item.id, repository: item.repository, page: item.page };
    return { ref, source: sourceFor(ref) };
  }

  /** Under the busy file of the list: the core and the command never write it together. */
  function changeSources(change: (list: FollowedSource[]) => FollowedSource[]): void {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    if (!takeBusy(join(base, SOURCES_BUSY), token)) throw new CatalogError('conflict', 'the list of sources is being changed by another process');
    try {
      writeAtomic(sourcesPath, { version: 1, sources: change(followed()) } satisfies SourcesFile);
    } finally {
      releaseBusy(join(base, SOURCES_BUSY), token);
    }
  }

  function add(url: unknown): SourceRef {
    const ref = parseSourceUrl(url, allowLocal);
    if (spec.reserved !== undefined && ref.id === spec.reserved.id) throw new CatalogError('conflict', spec.reserved.add);
    changeSources((list) => {
      if (list.some((source) => source.id === ref.id)) throw new CatalogError('conflict', 'this source is already followed');
      if (list.length >= spec.maxSources) throw new CatalogError('invalid', `at most ${String(spec.maxSources)} sources`);
      return [...list, { ...ref, addedAt: now().toISOString() }];
    });
    spec.onEvent?.(`${spec.events}.added`, { source: ref.id });
    return ref;
  }

  /**
   * Under the busy file of the source, held to the end: first out of the
   * list, then every file of its folder. Held by the other process, nothing
   * changes.
   */
  function remove(value: unknown): SourceRef {
    const { ref, source } = find(value);
    source.erase({
      first: () => {
        changeSources((list) => list.filter((item) => item.id !== ref.id));
      },
      folder: true,
    });
    opened.delete(ref.id);
    const at = waiting.indexOf(ref.id);
    if (at >= 0) waiting.splice(at, 1);
    queueErrors.delete(ref.id);
    spec.onEvent?.(`${spec.events}.removed`, { source: ref.id });
    return ref;
  }

  const running = (): boolean => [...opened.values()].some((source) => source.job()?.status === 'running');

  /** Starts a download, and the next of the queue when it ends. */
  function start(source: GitSource<I>): void {
    source.update();
    const next = (): void => {
      startNext();
    };
    void source.idle().then(next, next);
  }

  /** The first sources of the queue that may start: one, or none while one runs. */
  function startNext(): void {
    while (waiting.length > 0 && !running()) {
      const id = waiting.shift() ?? '';
      const item = followed().find((source) => source.id === id);
      if (item === undefined) continue;
      try {
        start(sourceFor(item));
      } catch (error) {
        // Refused now (a version waiting, the other process holding it): said in the status.
        queueErrors.set(id, error instanceof CatalogError ? error.message : 'the download could not start');
      }
    }
  }

  function update(value: unknown): void {
    const { ref, source } = find(value);
    queueErrors.delete(ref.id);
    if (spec.serial !== true) {
      source.update();
      return;
    }
    if (waiting.includes(ref.id)) throw new CatalogError('conflict', 'this source already waits for its download');
    if (source.job()?.status === 'running') throw new CatalogError('conflict', 'a download of the catalog is already running');
    if (source.pending() !== undefined) throw new CatalogError('conflict', PENDING_MESSAGE);
    if (running()) {
      waiting.push(ref.id);
      spec.onEvent?.(`${spec.events}.queued`, { source: ref.id, position: waiting.length });
      return;
    }
    start(source);
  }

  async function idle(): Promise<void> {
    for (;;) {
      await Promise.all([...opened.values()].map((source) => source.idle()));
      if (!running() && waiting.length === 0) return;
      if (!running()) startNext();
    }
  }

  // The sources followed, repaired at the start (each under its own busy file).
  if (spec.recover !== false && existsSync(sourcesPath)) {
    for (const item of followed()) sourceFor(item);
  }

  return {
    base,
    sources,
    followed,
    sourceFor,
    find,
    add,
    remove,
    update,
    adopt: (value, commit) => find(value).source.adopt(commit),
    discard: (value) => {
      find(value).source.discard();
    },
    queued: (id) => waiting.includes(id),
    queueError: (id) => queueErrors.get(id),
    idle,
  };
}
