import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadTheme, nextTheme, saveTheme, themeAttribute } from '../src/lib/theme.ts';

test('the theme cycles system → dark → light and is remembered when storage works', () => {
  assert.equal(nextTheme('system'), 'dark');
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(nextTheme('light'), 'system');
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
