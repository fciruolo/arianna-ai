import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { activeTheme, applyTheme, contrast, lowContrast, THEME_TOKENS, themeAttributes, themeProperties, type ChatTheme, type ThemeTokens } from '../src/lib/themes.ts';

const HUD = join(import.meta.dirname, '..');
const THEMES_DIR = join(HUD, 'themes');
const CSS = readFileSync(join(HUD, 'src', 'style.css'), 'utf8');

/** The tokens of one block of style.css: `:root {` for dark, `:root[data-theme="light"] {` for light. */
function cssTokens(opening: string): ThemeTokens {
  const start = CSS.indexOf(opening);
  assert.ok(start >= 0, opening);
  const block = CSS.slice(start, CSS.indexOf('}', start));
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6,8});/g)) tokens[match[1] ?? ''] = match[2] ?? '';
  return tokens;
}
const BASE = { dark: cssTokens(':root {'), light: cssTokens(':root[data-theme="light"] {') };

const repoThemes: ChatTheme[] = readdirSync(THEMES_DIR).map((folder) => JSON.parse(readFileSync(join(THEMES_DIR, folder, 'theme.json'), 'utf8')) as ChatTheme);

test('the repository has the themes of the series, each in its folder (D-103)', () => {
  assert.deepEqual(repoThemes.map((theme) => theme.id).sort(), ['corsia', 'ufficio']);
  for (const folder of readdirSync(THEMES_DIR)) assert.deepEqual(readdirSync(join(THEMES_DIR, folder)), ['theme.json'], folder);
});

test('every token a theme may set is a colour token of style.css, in both modes (D-103)', () => {
  for (const token of THEME_TOKENS) {
    assert.ok(BASE.dark[token] !== undefined, `--${token} dark`);
    assert.ok(BASE.light[token] !== undefined, `--${token} light`);
  }
});

test('the contrast of WCAG 2.x is computed as the standard says', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 10) / 10, 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.equal(Math.round(contrast('#767676', '#ffffff') * 100) / 100, 4.54);
  // A colour with alpha is laid over its background first.
  assert.equal(Math.round(contrast('#00000000', '#ffffff') * 10) / 10, 1);
});

test('every theme of the repository reaches WCAG AA in dark and light: 4.5:1 for text, 3:1 for the accent (D-103)', () => {
  for (const theme of repoThemes) {
    for (const mode of ['dark', 'light'] as const) {
      assert.deepEqual(lowContrast(theme.tokens[mode], BASE[mode]), [], `${theme.id} ${mode}`);
    }
  }
});

test('the contrast test fails a theme under the minimum, with the pair named', () => {
  const low = lowContrast({ ink: '#777777', bg: '#808080', surface: '#808080', 'surface-2': '#808080' }, BASE.dark);
  assert.ok(low.some((item) => item.pair === 'ink su bg' && item.minimum === 4.5));
  assert.ok(low.some((item) => item.pair === 'accent su bg' || item.pair === 'muted su surface'));
});

test('the costumes a theme names are in the pack of the originals (D-103)', () => {
  const pack = JSON.parse(readFileSync(join(HUD, 'characters', 'originali', 'pack.json'), 'utf8')) as { characters: { id: string }[] };
  for (const theme of repoThemes) {
    for (const [agent, choice] of Object.entries(theme.characters)) {
      const [packId, character] = choice.split('/');
      assert.equal(packId, 'originali', `${theme.id}.${agent}`);
      assert.ok(pack.characters.some((entry) => entry.id === character), `${theme.id}.${agent}: ${choice}`);
      assert.equal(character, `${agent}-${theme.id}`);
    }
  }
});

const CORSIA = repoThemes.find((theme) => theme.id === 'corsia') as ChatTheme;

test('a theme sets only the tokens of the list, with a valid colour; Base removes them all (D-103)', () => {
  const tricky = { ...CORSIA, tokens: { dark: { ...CORSIA.tokens.dark, ink: 'red; background: url(x)', other: '#ffffff' } as ThemeTokens, light: {} } };
  const properties = themeProperties(tricky, 'dark');
  assert.equal(properties.get('--ink'), undefined);
  assert.equal(properties.get('--other'), undefined);
  assert.equal(properties.get('--bg'), '#0b1517');
  // hud.glow "tenue": the accent with a fixed alpha.
  assert.equal(properties.get('--glow'), '#5fd0b522');
  assert.equal(themeProperties({ ...CORSIA, hud: { ...CORSIA.hud, glow: 'nessuno' } }, 'dark').get('--glow'), 'transparent');

  const set = new Map<string, string>();
  const attributes = new Map<string, string>();
  const target = {
    style: { setProperty: (name: string, value: string) => set.set(name, value), removeProperty: (name: string) => (set.delete(name), '') },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  };
  applyTheme(target, CORSIA, 'light');
  assert.equal(set.get('--bg'), '#f2f7f6');
  assert.deepEqual(Object.fromEntries(attributes), { 'data-pattern': 'nessuno', 'data-decor': 'corrimano', 'data-corners': 'off', 'data-radius': 'morbido' });
  applyTheme(target, undefined, 'light');
  assert.equal(set.size, 0);
  assert.equal(attributes.size, 0);
});

test('an attribute outside the closed lists is never set', () => {
  const odd = { ...CORSIA, background: { pattern: 'url(x)', decor: 'x' }, hud: { corners: true, glow: 'tenue', radius: 'x' } } as unknown as ChatTheme;
  assert.deepEqual(themeAttributes(odd), { 'data-pattern': undefined, 'data-decor': undefined, 'data-corners': undefined, 'data-radius': undefined });
});

test('the theme in use is the current one of the listing, Base otherwise', () => {
  assert.equal(activeTheme(null), undefined);
  assert.equal(activeTheme({ themes: repoThemes, refused: [], chosen: 'corsia', current: 'corsia' })?.id, 'corsia');
  assert.equal(activeTheme({ themes: repoThemes, refused: [], chosen: 'sparito', current: 'base' }), undefined);
});
