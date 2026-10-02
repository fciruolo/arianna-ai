// Reloads arianna.toml and the catalog while the core runs (task 1.18): a new
// model for a role applies without a restart. Only the roles and the model
// names they give the local servers change live; everything else waits for a
// restart, privacy settings first, so that an edited file never turns on a
// cloud executor or a channel by itself, nor changes where L2 requests go
// (`url`) or what the watchdog runs (`command`).
import { unwatchFile, watchFile } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { CATALOG_FILE } from './catalog.ts';
import { CONFIG_FILE, loadConfig, type AriannaConfig } from './config.ts';

const RESTART_SECTIONS = ['paths', 'database', 'server', 'cloud', 'telegram'] as const;

export interface ConfigChange {
  /** Applied: `current()` returns the new values (`roles`, `local.models`). */
  applied: string[];
  /** Changed in the file but still the old values until the core restarts. */
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
  /** An invalid file keeps the previous configuration. */
  onError: (error: unknown) => void;
  /** How often the files are checked; 1 s by default. */
  intervalMs?: number;
}

/** The local servers without their model names: what needs a restart. */
function servers(config: AriannaConfig): unknown {
  return config.local.endpoints.map(({ id, url, command }) => ({ id, url, command }));
}

/** Which sections differ between two configurations. */
export function diffConfig(before: AriannaConfig, after: AriannaConfig): ConfigChange {
  const changed = (section: keyof AriannaConfig): boolean => !isDeepStrictEqual(before[section], after[section]);
  const sameServers = isDeepStrictEqual(servers(before), servers(after));
  return {
    applied: [
      ...(changed('roles') ? ['roles'] : []),
      ...(sameServers && changed('local') ? ['local.models'] : []),
    ],
    restart: [...(sameServers ? [] : ['local.endpoints']), ...RESTART_SECTIONS.filter(changed)],
  };
}

function empty(change: ConfigChange): boolean {
  return change.applied.length + change.restart.length === 0;
}

export function watchConfig(options: WatchOptions): ConfigWatcher {
  let current = options.initial;
  const env = { ...process.env, ARIANNA_HOME: current.home };
  // The last valid file read: what a new read is compared with.
  let read = options.initial;
  const reload = (): void => {
    let next: AriannaConfig;
    try {
      next = loadConfig(env);
    } catch (error) {
      options.onError(error);
      return;
    }
    // Reported once per change of the file, not at every check.
    if (empty(diffConfig(read, next))) return;
    read = next;
    const before = current;
    const sameServers = isDeepStrictEqual(servers(current), servers(next));
    current = { ...current, roles: next.roles, ...(sameServers ? { local: next.local } : {}) };
    const change = { applied: diffConfig(before, current).applied, restart: diffConfig(current, next).restart };
    // A file put back as it was changes nothing.
    if (!empty(change)) options.onChange(change);
  };
  // Polled, not fs.watch: on macOS events right after the watch starts can be
  // lost, and the wizard replaces the file with a rename, which polling by path
  // sees as any other change.
  const files = [CONFIG_FILE, CATALOG_FILE].map((file) => join(current.home, file));
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
