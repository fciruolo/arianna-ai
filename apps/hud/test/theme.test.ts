import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadTheme, nextTheme, saveTheme, THEME_ICON, THEME_TEXT, themeAttribute, themeLabel, THEMES } from '../src/lib/theme.ts';

test('the theme cycles light → dark → system (D-158) and is remembered when storage works', () => {
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'system');
  assert.equal(nextTheme('system'), 'light');
  assert.notEqual(nextTheme('dark'), 'light');
  assert.deepEqual(THEMES.map((theme) => THEME_TEXT[theme]), ['Chiaro', 'Scuro', 'Auto']);
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  assert.equal(loadTheme(storage), 'system');
  saveTheme(storage, 'light');
  assert.equal(loadTheme(storage), 'light');
  assert.equal(themeAttribute('light'), 'light');
  assert.equal(themeAttribute('system'), undefined);
});

test('a broken or blocked storage means the system theme, never an error', () => {
  const broken = {
    getItem: (): string | null => {
      throw new Error('blocked');
    },
    setItem: (): void => {
      throw new Error('blocked');
    },
  };
  assert.equal(loadTheme(broken), 'system');
  assert.doesNotThrow(() => { saveTheme(broken, 'dark'); });
  assert.equal(loadTheme({ getItem: () => 'purple', setItem: () => undefined }), 'system');
  assert.equal(loadTheme(undefined), 'system');
});

test('the header button says and shows the active theme (D-158)', () => {
  assert.equal(themeLabel('light'), 'Tema: chiaro');
  assert.equal(themeLabel('dark'), 'Tema: scuro');
  assert.equal(themeLabel('system'), 'Tema: automatico');
  assert.equal(THEME_ICON.light, 'theme-light');
  assert.equal(THEME_ICON.dark, 'theme-dark');
  assert.equal(THEME_ICON.system, 'theme-system');
  assert.notEqual(THEME_ICON.light, THEME_ICON.system);
});
