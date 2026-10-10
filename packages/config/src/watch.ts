// Reloads arianna.toml and the catalog while the core runs (task 1.18, D-071):
// a change applies without a restart. The roles and the model names they give
// the local servers, the local servers themselves (the core restarts the one
// whose `url` or `command` changed), the cloud executors and their models,
// the projects, Telegram, `[voice]` (the core restarts apps/voice once no call
// is in progress), the characters and the personas change live; the core
// reads `current()` at each use. Only `paths`, `database` and `server` wait
// for a restart.
//
// The cloud executors, the projects, Telegram and the user's text of a
// persona (L1 by declaration, D-107) are privacy settings: the user writes
// them by editing the file (or on the settings page), never an agent. A file
// that cannot be read closes them until it is valid again (the persona keeps
// tone and form of address, its text is dropped), so that an exit taken off
// by hand next to a typo is not left open.
import { unwatchFile, watchFile } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { CATALOG_FILE, USER_CATALOG_FILE } from './catalog.ts';
import { CONFIG_FILE, loadConfig, type AriannaConfig } from './config.ts';

const RESTART_SECTIONS = ['paths', 'database', 'server'] as const;

export interface ConfigChange {
  /**
   * Applied: `current()` returns the new values (`roles`, `local.models`,
   * `local.endpoints`, `cloud.executors`, `cloud.models`, `projects`,
   * `telegram`, `voice`, `characters`, `personas`, `notifications`).
   */
  applied: string[];
  /**
   * Changed in the file by this reload and still the old values until the
   * core restarts; reported once per change (the settings page lists all
   * of them as `restartPending`).
   */
  restart: string[];
}

export interface ConfigWatcher {
  /** The configuration to use now: read it at each use, never keep a copy. */
  current(): AriannaConfig;
  close(): void;
}

export interface WatchOptions {
  /** Its `home` is the folder watched and reloaded. */
  initial: AriannaConfig;
  onChange: (change: ConfigChange) => void;
  /**
   * An invalid file keeps the previous configuration, except the exits
   * (projects, cloud executors, Telegram, the text of the personas),
   * which are closed until it is valid.
   */
  onError: (error: unknown) => void;
  /** How often the files are checked; 1 s by default. */
  intervalMs?: number;
}

/** The local servers without their model names: a change restarts them. */
function servers(config: AriannaConfig): unknown {
  return config.local.endpoints.map(({ id, url, command }) => ({ id, url, command }));
}

/** `[cloud.models]`. */
function cloudModels(config: AriannaConfig): unknown {
  return config.cloud.models;
}

/** Which sections differ between two configurations. */
export function diffConfig(before: AriannaConfig, after: AriannaConfig): ConfigChange {
  const changed = (section: keyof AriannaConfig): boolean => !isDeepStrictEqual(before[section], after[section]);
  const sameServers = isDeepStrictEqual(servers(before), servers(after));
  return {
    applied: [
      ...(changed('roles') ? ['roles'] : []),
      ...(sameServers && changed('local') ? ['local.models'] : []),
      ...(sameServers ? [] : ['local.endpoints']),
      ...(isDeepStrictEqual(before.cloud.executors, after.cloud.executors) ? [] : ['cloud.executors']),
      ...(isDeepStrictEqual(cloudModels(before), cloudModels(after)) ? [] : ['cloud.models']),
      ...(changed('projects') ? ['projects'] : []),
      ...(changed('telegram') ? ['telegram'] : []),
      ...(changed('voice') ? ['voice'] : []),
      ...(changed('characters') ? ['characters'] : []),
      ...(changed('agents') ? ['agents'] : []),
      ...(changed('personas') ? ['personas'] : []),
      ...(changed('sprites') ? ['sprites'] : []),
      ...(changed('notifications') ? ['notifications'] : []),
      ...(changed('secretary') ? ['secretary'] : []),
      ...(changed('capture') ? ['capture'] : []),
      ...(changed('installation') ? ['installation'] : []),
    ],
    restart: RESTART_SECTIONS.filter(changed),
  };
}

function empty(change: ConfigChange): boolean {
  return change.applied.length + change.restart.length === 0;
}

/**
 * `config` with every exit closed: no project, no cloud executor, no Telegram,
 * and no text of a persona (L1, D-107): only tone and form of address, fixed
 * sentences of ours.
 */
function closeExits(config: AriannaConfig): AriannaConfig {
  const personas = Object.fromEntries(Object.entries(config.personas).map(([agent, persona]) => [agent, { tone: persona.tone, address: persona.address }]));
  const closed: AriannaConfig = { ...config, projects: [], cloud: { ...config.cloud, executors: [] }, personas };
  delete closed.telegram;
  return closed;
}

/** `next`, except what waits for a restart, which stays as in `current`. */
function applicable(current: AriannaConfig, next: AriannaConfig): AriannaConfig {
  return { ...next, home: current.home, paths: current.paths, database: current.database, server: current.server };
}

export function watchConfig(options: WatchOptions): ConfigWatcher {
  let current = options.initial;
  const env = { ...process.env, ARIANNA_HOME: current.home };
  // The last valid file read: what a new read is compared with.
  let read = options.initial;
  let closed = false;
  const reload = (): void => {
    let next: AriannaConfig;
    try {
      next = loadConfig(env);
    } catch (error) {
      if (!closed) {
        closed = true;
        const before = current;
        current = closeExits(current);
        const { applied } = diffConfig(before, current);
        if (applied.length > 0) options.onChange({ applied, restart: [] });
      }
      options.onError(error);
      return;
    }
    const reopened = closed;
    closed = false;
    // Reported once per change of the file, not at every check.
    if (empty(diffConfig(read, next)) && !reopened) return;
    const previous = read;
    read = next;
    const before = current;
    current = applicable(current, next);
    // A section waiting for a restart is reported once, when the file changes
    // it, not again at every later reload; one put back as the core runs it is
    // not reported.
    const pending = diffConfig(current, next).restart;
    const restart = diffConfig(previous, next).restart.filter((section) => pending.includes(section));
    const change = { applied: diffConfig(before, current).applied, restart };
    // A file put back as it was changes nothing.
    if (!empty(change)) options.onChange(change);
  };
  // Polled, not fs.watch: on macOS events right after the watch starts can be
  // lost, and the wizard replaces the file with a rename, which polling by path
  // sees as any other change.
  const files = [CONFIG_FILE, CATALOG_FILE, USER_CATALOG_FILE].map((file) => join(current.home, file));
  const interval = options.intervalMs ?? 1000;
  for (const file of files) watchFile(file, { interval, persistent: false }, reload);
  // Polling compares with its own first look: a change made between the
  // initial load and that look is caught by one comparison with `initial`.
  const first = setTimeout(reload, interval * 2);
  first.unref();
  return {
    current: () => current,
    close: () => {
      clearTimeout(first);
      for (const file of files) unwatchFile(file, reload);
    },
  };
}
