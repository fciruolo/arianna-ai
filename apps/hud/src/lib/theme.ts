/**
 * The theme of the web chat (D-060): dark first, light when the system is
 * light, or the user's choice. The choice is a convenience of this browser
 * only (localStorage), so a missing or blocked storage just means "system".
 */
export type Theme = 'system' | 'dark' | 'light';

const KEY = 'arianna.theme';
/** The order of the cycle of the header button (D-158): Chiaro → Scuro → Auto. */
export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

/** The short names of the three buttons of Impostazioni → Aspetto. */
export const THEME_TEXT: Record<Theme, string> = {
  light: 'Chiaro',
  dark: 'Scuro',
  system: 'Auto',
};

/** The icon of each theme, the one the header button shows for the active theme. */
export const THEME_ICON = { light: 'theme-light', dark: 'theme-dark', system: 'theme-system' } as const satisfies Record<Theme, string>;

/** "Tema: chiaro", the title and the name of the header button. */
export function themeLabel(theme: Theme): string {
  return `Tema: ${{ light: 'chiaro', dark: 'scuro', system: 'automatico' }[theme]}`;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadTheme(storage: StorageLike | undefined): Theme {
  try {
    const value = storage?.getItem(KEY);
    return THEMES.find((theme) => theme === value) ?? 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(storage: StorageLike | undefined, theme: Theme): void {
  try {
    storage?.setItem(KEY, theme);
  } catch {
    // Private window or blocked storage: the choice lasts until the page closes.
  }
}

/** The next theme of the cycle light → dark → system (D-158). */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'light';
}

/** The value of data-theme on <html>: absent for "system". */
export function themeAttribute(theme: Theme): string | undefined {
  return theme === 'system' ? undefined : theme;
}
