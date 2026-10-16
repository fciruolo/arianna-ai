import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Label } from '@arianna/policy';

import type { Queryable } from './db/client.ts';
import { appendEvent } from './events.ts';
import { writeAtomic } from './git-catalog.ts';

/**
 * «Cosa è cambiato» (D-233, idea 11 of OpenWork in D-093): what changed in
 * this installation, as observations. The core takes a picture of the state
 * (models, roles, cloud executors, catalogs, agents, projects, theme,
 * characters, version) at start, after a change of arianna.toml, every few
 * minutes and when the page is opened; it compares it with the last one,
 * kept in `data/changes/state.json`, and writes what differs as one
 * `installation.changed` event. The page reads only those events.
 *
 * Only names, ids, versions and states pass: every key and value must match
 * SAFE_VALUE, anything else is left out, so no text of the user, no path and
 * no content can reach the picture. Names the user chose (projects, agents
 * of the user, the characters they wear) make the event L1, as
 * `settings.projects` (D-058); everything else is L0.
 */

export const CHANGE_AREAS = [
  'arianna',
  'role',
  'model',
  'executor',
  'cloud-model',
  'cloud-name',
  'binary',
  'skills',
  'design',
  'agents-catalog',
  'agent',
  'project',
  'theme',
  'character',
] as const;
export type ChangeArea = (typeof CHANGE_AREAS)[number];

/** Per area: id → value. A missing area in a fresh picture means it could not be read: the last one stays. */
export type StateAreas = Partial<Record<ChangeArea, Record<string, string>>>;

export interface InstallationState {
  version: 1;
  observedAt: string;
  areas: Record<ChangeArea, Record<string, string>>;
  /** Areas never read yet: their first reading fills the picture without an event, so nothing looks added. */
  unread: ChangeArea[];
}

/** One observation: `from` null is something that appeared, `to` null something that went away. */
export interface Change {
  area: ChangeArea;
  id: string;
  from: string | null;
  to: string | null;
}

export const CHANGED_EVENT = 'installation.changed';
/** The first picture, the day «Cosa è cambiato» starts to observe. */
export const BASELINE_EVENT = 'installation.baseline';

/** Ids, versions, model and catalog names: letters, digits and a few signs, no spaces. */
export const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
/** At most this many entries per area, and changes per event. */
export const MAX_ENTRIES = 500;
export const MAX_CHANGES = 100;

/** Areas whose ids are names the user chose: L1, as the projects (D-058). */
const L1_AREAS: ReadonlySet<ChangeArea> = new Set(['project', 'agent', 'character']);

export function isChangeArea(value: unknown): value is ChangeArea {
  return typeof value === 'string' && (CHANGE_AREAS as readonly string[]).includes(value);
}

/** Keeps only the entries whose id and value are safe, at most MAX_ENTRIES, sorted. */
export function cleanArea(given: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (given === null || typeof given !== 'object') return out;
  const entries = given as Record<string, unknown>;
  for (const key of Object.keys(entries).sort()) {
    const value = entries[key];
    if (!SAFE_VALUE.test(key) || typeof value !== 'string' || !SAFE_VALUE.test(value)) continue;
    out[key] = value;
    if (Object.keys(out).length >= MAX_ENTRIES) break;
  }
  return out;
}

function emptyAreas(): Record<ChangeArea, Record<string, string>> {
  return Object.fromEntries(CHANGE_AREAS.map((area) => [area, {}])) as Record<ChangeArea, Record<string, string>>;
}

/** The saved picture, checked again: undefined when missing, unreadable or not of this shape. */
export function parseState(raw: unknown): InstallationState | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as { version?: unknown; observedAt?: unknown; areas?: unknown };
  if (value.version !== 1 || typeof value.observedAt !== 'string' || value.areas === null || typeof value.areas !== 'object') return undefined;
  const areas = emptyAreas();
  const given = value.areas as Record<string, unknown>;
  for (const area of CHANGE_AREAS) areas[area] = cleanArea(given[area]);
  const unread = Array.isArray((raw as { unread?: unknown }).unread) ? ((raw as { unread: unknown[] }).unread.filter(isChangeArea)) : [];
  return { version: 1, observedAt: value.observedAt, areas, unread };
}

export function readState(file: string): InstallationState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return parseState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** The fresh picture over the last one: an area that could not be read keeps its last value. */
export function mergeState(previous: InstallationState | undefined, fresh: StateAreas, now: Date): InstallationState {
  const areas = emptyAreas();
  for (const area of CHANGE_AREAS) {
    const read = fresh[area];
    areas[area] = read === undefined ? { ...(previous?.areas[area] ?? {}) } : cleanArea(read);
  }
  const unread = (previous?.unread ?? CHANGE_AREAS).filter((area) => fresh[area] === undefined);
  return { version: 1, observedAt: now.toISOString(), areas, unread };
}

/** What differs, area by area in the order of CHANGE_AREAS, ids sorted; an area never read before has nothing to compare with. */
export function diffStates(before: InstallationState, after: InstallationState): Change[] {
  const changes: Change[] = [];
  for (const area of CHANGE_AREAS) {
    if (before.unread.includes(area)) continue;
    const a = before.areas[area];
    const b = after.areas[area];
    const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const id of ids) {
      const from = Object.hasOwn(a, id) ? (a[id] ?? null) : null;
      const to = Object.hasOwn(b, id) ? (b[id] ?? null) : null;
      if (from !== to) changes.push({ area, id, from, to });
    }
  }
  return changes;
}

export function changesLabel(changes: readonly Change[]): Label {
  return changes.some((change) => L1_AREAS.has(change.area)) ? 'L1' : 'L0';
}

export interface ChangeWatcherOptions {
  sql: Queryable;
  /** `data/changes/state.json`. */
  file: string;
  /** Reads the installation now; an area that throws or is left out keeps its last value. */
  read: () => Promise<StateAreas>;
  onError: (error: unknown) => void;
  now?: () => Date;
}

export interface ChangeWatcher {
  /** Takes a picture and writes what changed; checks asked while one runs share the next one. How many changes it wrote. */
  check(): Promise<number>;
}

export function createChangeWatcher(options: ChangeWatcherOptions): ChangeWatcher {
  const now = (): Date => options.now?.() ?? new Date();
  let running: Promise<number> | undefined;
  let next: Promise<number> | undefined;

  async function once(): Promise<number> {
    const previous = readState(options.file);
    const state = mergeState(previous, await options.read(), now());
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    if (previous === undefined) {
      // The first picture, or a new start after a picture that could not be read: observations start again from here.
      const reset = existsSync(options.file);
      if (reset) options.onError(new Error(`${options.file}: unreadable, «Cosa è cambiato» starts observing again`));
      await appendEvent(options.sql, { kind: BASELINE_EVENT, label: 'L0', payload: reset ? { reset: true } : {} });
      writeAtomic(options.file, state);
      return 0;
    }
    const changes = diffStates(previous, state);
    if (changes.length === 0) return 0;
    const shown = changes.slice(0, MAX_CHANGES);
    // The event first: if it fails, the picture stays the old one and the next check writes it again.
    await appendEvent(options.sql, {
      kind: CHANGED_EVENT,
      label: changesLabel(shown),
      payload: { changes: shown.map((change) => ({ ...change })), ...(changes.length > shown.length ? { more: changes.length - shown.length } : {}) },
    });
    writeAtomic(options.file, state);
    return changes.length;
  }

  function run(): Promise<number> {
    const started = once().catch((error: unknown) => {
      options.onError(error);
      return 0;
    });
    running = started.finally(() => {
      running = undefined;
    });
    return started;
  }

  return {
    check() {
      // `next` first: between the end of a check and the start of the next one, `running` is already gone.
      if (next !== undefined) return next;
      if (running === undefined) return run();
      // One more after the one running, shared by everyone who asks meanwhile.
      next = running.then(() => {
        next = undefined;
        return run();
      });
      return next;
    },
  };
}

export function stateFile(dataDir: string): string {
  return join(dataDir, 'changes', 'state.json');
}

/** What the page shows: the events, most recent first, and when observing started. */
export interface ChangesEntry {
  id: string;
  at: string;
  changes: Change[];
  /** Changes left out of the event beyond MAX_CHANGES. */
  more: number;
}

export interface ChangesReport {
  /** The time of the first picture; null before the core took one. */
  since: string | null;
  entries: ChangesEntry[];
  /** Older events exist beyond the limit. */
  truncated: boolean;
}

export const CHANGES_LIMIT = 300;

/** The changes kept in an event, checked again: an entry of another shape is left out. */
export function parseChanges(payload: unknown): { changes: Change[]; more: number } {
  const value = (payload ?? {}) as { changes?: unknown; more?: unknown };
  const list = Array.isArray(value.changes) ? value.changes : [];
  const safe = (item: unknown): item is string | null => item === null || (typeof item === 'string' && SAFE_VALUE.test(item));
  const changes = list.flatMap((item: unknown): Change[] => {
    if (item === null || typeof item !== 'object') return [];
    const { area, id, from, to } = item as Record<string, unknown>;
    if (!isChangeArea(area) || typeof id !== 'string' || !SAFE_VALUE.test(id) || !safe(from) || !safe(to)) return [];
    return [{ area, id, from, to }];
  });
  const more = typeof value.more === 'number' && Number.isSafeInteger(value.more) && value.more > 0 ? value.more : 0;
  return { changes, more };
}

/** Reads only the events of «Cosa è cambiato»: never another kind, never a message or a conversation. */
export async function loadChanges(sql: Queryable, limit: number = CHANGES_LIMIT): Promise<ChangesReport> {
  const rows = await sql<{ id: string; ts: Date; payload: unknown }[]>`
    SELECT id::text, ts, payload FROM events WHERE kind = ${CHANGED_EVENT} ORDER BY id DESC LIMIT ${limit + 1}`;
  // The last start: after an unreadable picture, observations start again from there.
  const [first] = await sql<{ ts: Date }[]>`SELECT ts FROM events WHERE kind = ${BASELINE_EVENT} ORDER BY id DESC LIMIT 1`;
  const entries = rows.slice(0, limit).map((row) => ({ id: row.id, at: row.ts.toISOString(), ...parseChanges(row.payload) }));
  return { since: first?.ts.toISOString() ?? null, entries: entries.filter((entry) => entry.changes.length > 0 || entry.more > 0), truncated: rows.length > limit };
}

/** The last version of a cloud binary its runs reported (`executor.model`, D-233), or undefined. */
export async function lastBinaryVersion(sql: Queryable, executor: string): Promise<string | undefined> {
  const [row] = await sql<{ version: string | null }[]>`
    SELECT payload ->> 'version' AS version FROM events
    WHERE kind = 'executor.model' AND payload ->> 'executor' = ${executor} AND payload ? 'version'
    ORDER BY id DESC LIMIT 1`;
  const version = row?.version ?? undefined;
  return version !== undefined && SAFE_VALUE.test(version) ? version : undefined;
}

/** `version` of the main package.json, or undefined. */
export function packageVersion(home: string): string | undefined {
  try {
    const value = (JSON.parse(readFileSync(join(home, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A commit as the page shows it: its first 7 characters, or `-` for a source followed without a version in use. */
export function shortCommit(commit: string | null | undefined): string {
  return commit === null || commit === undefined || !/^[0-9a-f]{7,40}$/.test(commit) ? '-' : commit.slice(0, 7);
}

/** Where each area is read from; a source that throws leaves its area as it was. */
export type StateSources = { [area in ChangeArea]: () => Record<string, string> | Promise<Record<string, string>> };

export async function readAreas(sources: StateSources, onError: (area: ChangeArea, error: unknown) => void): Promise<StateAreas> {
  const areas: StateAreas = {};
  for (const area of CHANGE_AREAS) {
    try {
      areas[area] = cleanArea(await sources[area]());
    } catch (error) {
      onError(area, error);
    }
  }
  return areas;
}

/** Each model of the catalog: `on-disk` with every file of the right size, else `in-catalog`. */
export function modelsArea(models: readonly { id: string }[], files: readonly { model: string; state: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { id } of models) {
    const own = files.filter((file) => file.model === id);
    out[id] = own.length > 0 && own.every((file) => file.state === 'present' || file.state === 'ok') ? 'on-disk' : 'in-catalog';
  }
  return out;
}

/** A catalog of sources (skills, agents, Open Design): source id → the commit in use, `-` when followed without one. */
export function sourcesArea(sources: readonly { id: string; adopted: { commit: string } | null }[]): Record<string, string> {
  return Object.fromEntries(sources.map((source) => [source.id, shortCommit(source.adopted?.commit)]));
}

/** `[cloud.models]`: alias → `on`/`off`, and alias → the exact name when one is written. */
export function cloudModelAreas(models: Record<string, { enabled: boolean; name?: string }>): { on: Record<string, string>; names: Record<string, string> } {
  const on: Record<string, string> = {};
  const names: Record<string, string> = {};
  for (const [alias, setting] of Object.entries(models)) {
    on[alias] = setting.enabled ? 'on' : 'off';
    if (setting.name !== undefined) names[alias] = setting.name;
  }
  return { on, names };
}
