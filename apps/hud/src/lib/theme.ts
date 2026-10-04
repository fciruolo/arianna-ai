/**
 * The theme of the web chat (D-060): dark first, light when the system is
 * light, or the user's choice. The choice is a convenience of this browser
 * only (localStorage), so a missing or blocked storage just means "system".
 */
export type Theme = 'system' | 'dark' | 'light';

const KEY = 'arianna.theme';
export const THEMES: readonly Theme[] = ['system', 'dark', 'light'];

export const THEME_TEXT: Record<Theme, string> = {
  system: 'Tema del sistema',
  dark: 'Tema scuro',
  light: 'Tema chiaro',
};

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

/** The next theme of the cycle system → dark → light. */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system';
}

/** The value of data-theme on <html>: absent for "system". */
export function themeAttribute(theme: Theme): string | undefined {
  return theme === 'system' ? undefined : theme;
}
