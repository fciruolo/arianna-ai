// Writing config/arianna.toml (task 1.18, D-071): validated exactly as
// loadConfig reads it, then written beside it and renamed, so the running
// core, which checks the file every second, never reads half of it. The
// wizard and the settings page of the web chat write through here.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ModelCatalog } from './catalog.ts';
import { CONFIG_FILE, parseConfig, userHomeOf } from './config.ts';
import { renderSettings, type Settings } from './settings.ts';

/** The sha256 of a file's text: what the settings page read, compared before writing. */
export function settingsFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The file changed since it was read: the write is refused (D-071). */
export class StaleSettingsError extends Error {
  override name = 'StaleSettingsError';
}

export interface WriteOptions {
  /** The user's home for `~/` of the projects; HOME by default, as the wizard. */
  userHome?: string;
  /**
   * The fingerprint of the file the caller read (`settingsFingerprint`), or
   * null when it read no file; checked right before the rename. Absent, the
   * file is replaced whatever it holds (the wizard).
   */
  expected?: string | null;
}

/** Writes `settings`; returns the text written. */
export function writeSettings(home: string, catalog: ModelCatalog, settings: Settings, options: WriteOptions = {}): string {
  const text = renderSettings(settings);
  // The same home the wizard and the links use (HOME), not the account's when they differ.
  parseConfig(text, home, catalog, options.userHome ?? userHomeOf());
  const path = join(home, CONFIG_FILE);
  if (options.expected !== undefined) {
    // Synchronous from here to the rename: no other write of this process comes in between.
    const found = existsSync(path) ? settingsFingerprint(readFileSync(path, 'utf8')) : null;
    if (found !== options.expected) throw new StaleSettingsError(`${CONFIG_FILE} changed since it was read`);
  }
  const temporary = join(dirname(path), `.arianna.toml.${String(process.pid)}`);
  try {
    writeFileSync(temporary, text, { mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return text;
}
