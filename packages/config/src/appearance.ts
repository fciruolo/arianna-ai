import { asString, asTable, ConfigError, onlyKeys } from './validate.ts';

/**
 * `[appearance]` of arianna.toml (D-103): the theme of the web chat, the
 * same on every device. Cosmetic: it applies without a restart. A theme that
 * is missing or invalid when the core reads the folders falls back to Base;
 * here only the form of the id is checked. Light, dark or system stays a
 * choice of each browser.
 */
export interface AppearanceConfig {
  theme: string;
}

/** The theme with no file: the colours of style.css. */
export const BASE_THEME = 'base';
/** A theme id, as its folder name: lowercase, digits and `-`. */
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const DEFAULT_APPEARANCE: AppearanceConfig = { theme: BASE_THEME };

export function checkAppearance(value: AppearanceConfig, where = 'appearance'): AppearanceConfig {
  if (!THEME_ID.test(value.theme)) throw new ConfigError(`${where}.theme: lowercase letters, digits and -, at most 40`);
  return { theme: value.theme };
}

export function parseAppearance(value: unknown): AppearanceConfig {
  if (value === undefined) return { ...DEFAULT_APPEARANCE };
  const table = asTable(value, 'appearance');
  onlyKeys(table, ['theme'], 'appearance');
  return checkAppearance({ theme: table.theme === undefined ? BASE_THEME : asString(table.theme, 'appearance.theme') });
}
