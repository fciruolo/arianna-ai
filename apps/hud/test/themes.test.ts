import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { activeTheme, applyTheme, contrast, CONTRAST_PAIRS, feastInUse, lowContrast, THEME_TOKENS, themeAttributes, themeNoticeText, themeProperties, untilText, type ChatTheme, type ThemeTokens } from '../src/lib/themes.ts';

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

// As the core serves them: a theme with no characters (Base) has none.
const repoThemes: ChatTheme[] = readdirSync(THEMES_DIR).map((folder) => {
  const theme = JSON.parse(readFileSync(join(THEMES_DIR, folder, 'theme.json'), 'utf8')) as Omit<ChatTheme, 'characters'> & { characters?: Record<string, string> };
  return { ...theme, characters: theme.characters ?? {} };
});

const FEASTS = ['carnevale', 'estate', 'halloween', 'natale', 'pasqua', 'san-patrizio'];

test('the repository has Base, the themes of the series and the feasts, each in its folder (D-103, D-246)', () => {
  assert.deepEqual(repoThemes.map((theme) => theme.id).sort(), ['base', 'carnevale', 'corsia', 'estate', 'fox-river', 'halloween', 'langley', 'natale', 'pasadena', 'pasqua', 'planet-express', 'quahog', 'san-patrizio', 'springfield', 'ufficio']);
  for (const folder of readdirSync(THEMES_DIR)) assert.deepEqual(readdirSync(join(THEMES_DIR, folder)), ['theme.json'], folder);
  // The names of the series (D-214), the ids unchanged so that a saved choice still works.
  assert.deepEqual(
    repoThemes.map((theme) => [theme.id, theme.name]).sort(),
    [
      ['base', 'Base'],
      ['carnevale', 'Carnevale'],
      ['corsia', 'Scrubs'],
      ['estate', 'Estate'],
      ['fox-river', 'Prison Break'],
      ['halloween', 'Halloween'],
      ['langley', 'American Dad'],
      ['natale', 'Natale'],
      ['pasadena', 'The Big Bang Theory'],
      ['pasqua', 'Pasqua'],
      ['planet-express', 'Futurama'],
      ['quahog', 'I Griffin'],
      ['san-patrizio', 'San Patrizio'],
      ['springfield', 'I Simpson'],
      ['ufficio', 'The Office'],
    ],
  );
});

test('every token a theme may set is a colour token of style.css, in both modes (D-103)', () => {
  for (const token of THEME_TOKENS) {
    assert.ok(BASE.dark[token] !== undefined, `--${token} dark`);
    assert.ok(BASE.light[token] !== undefined, `--${token} light`);
  }
});

const BASE_THEME = repoThemes.find((theme) => theme.id === 'base') as ChatTheme;

test('Base in theme.json is style.css with the seven colours under AA corrected, and nothing else changed (D-246)', () => {
  const corrected = {
    dark: { bubble: '#257f75' },
    light: { accent: '#218075', glow: '#21807522', l0: '#437f58', ok: '#437f58', l1: '#218075', l2: '#9a6a17', warn: '#9a6a17', 'deco-a': '#218075' },
  };
  for (const mode of ['dark', 'light'] as const) {
    const css = Object.fromEntries(THEME_TOKENS.map((token) => [token, BASE[mode][token]]));
    assert.deepEqual(BASE_THEME.tokens[mode], { ...css, ...corrected[mode] }, mode);
    // style.css, the fallback, is under AA exactly on those seven pairs; theme.json on none.
    const low = lowContrast(BASE[mode], BASE[mode]).map((item) => item.pair);
    assert.deepEqual(low, mode === 'dark' ? ['bubble-ink su bubble'] : ['accent-ink su accent', 'l0 su surface', 'l1 su surface', 'l2 su surface', 'warn su surface', 'ok su surface']);
    assert.deepEqual(lowContrast(BASE_THEME.tokens[mode], {}), [], mode);
  }
  assert.equal(BASE_THEME.kind, 'base');
  assert.deepEqual(BASE_THEME.characters, {});
  assert.equal(CONTRAST_PAIRS.length, 16);
});

test('every feast is seasonal, has its days and dresses Arianna and the Coder in its costume (D-246)', () => {
  for (const id of FEASTS) {
    const theme = repoThemes.find((entry) => entry.id === id) as ChatTheme & { dates?: unknown };
    assert.equal(theme.kind, 'stagionale', id);
    assert.ok(theme.dates !== undefined, id);
    assert.deepEqual(theme.characters, { arianna: `originali/arianna-${id}`, coder: `originali/coder-${id}` }, id);
    // A full palette in both modes: no token falls back to style.css, which is under AA.
    for (const mode of ['dark', 'light'] as const) for (const [front, back] of CONTRAST_PAIRS) assert.ok(theme.tokens[mode][front] !== undefined && theme.tokens[mode][back] !== undefined, `${id} ${mode} ${front}/${back}`);
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

test('the characters a theme names are costumes of the originals or people of the series (D-103, D-211)', () => {
  const packs = Object.fromEntries(
    ['originali', 'serie'].map((id) => [id, (JSON.parse(readFileSync(join(HUD, 'characters', id, 'pack.json'), 'utf8')) as { characters: { id: string }[] }).characters]),
  );
  for (const theme of repoThemes) {
    for (const [agent, choice] of Object.entries(theme.characters)) {
      const [packId = '', character = ''] = choice.split('/');
      assert.ok(packs[packId]?.some((entry) => entry.id === character), `${theme.id}.${agent}: ${choice}`);
      // From the originals only the costumes of the same theme, never a plain original.
      if (packId === 'originali') assert.ok(character.endsWith(`-${theme.id}`), `${theme.id}.${agent}: ${choice}`);
    }
    // In every theme of the series Arianna, the Coder and GOD wear someone of the series (D-211, D-237, D-238).
    if (theme.kind !== 'serie') continue;
    for (const agent of ['arianna', 'coder', 'god']) assert.equal(theme.characters[agent]?.split('/')[0], 'serie', `${theme.id}.${agent}`);
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
  // Scrubs has no decor any more (D-214: the handrail across the window looked like a mistake).
  assert.deepEqual(Object.fromEntries(attributes), { 'data-pattern': 'nessuno', 'data-corners': 'off', 'data-radius': 'morbido' });
  applyTheme(target, { ...CORSIA, background: { ...CORSIA.background, decor: 'moquette' } }, 'light');
  assert.equal(attributes.get('data-decor'), 'moquette');
  applyTheme(target, undefined, 'light');
  assert.equal(set.size, 0);
  assert.equal(attributes.size, 0);
});

test('an attribute outside the closed lists is never set', () => {
  const odd = { ...CORSIA, background: { pattern: 'url(x)', decor: 'x' }, hud: { corners: true, glow: 'tenue', radius: 'x' } } as unknown as ChatTheme;
  assert.deepEqual(themeAttributes(odd), { 'data-pattern': undefined, 'data-decor': undefined, 'data-corners': undefined, 'data-radius': undefined });
});

test('the theme in use is the current one of the listing, Base otherwise, style.css with no listing', () => {
  assert.equal(activeTheme(null), undefined);
  assert.equal(activeTheme({ themes: repoThemes, refused: [], chosen: 'corsia', current: 'corsia' })?.id, 'corsia');
  assert.equal(activeTheme({ themes: repoThemes, refused: [], chosen: 'sparito', current: 'base' })?.id, 'base');
  // Base not served (its folder refused): the fallback of style.css.
  assert.equal(activeTheme({ themes: repoThemes.filter((theme) => theme.id !== 'base'), refused: [], chosen: 'base', current: 'base' }), undefined);
});

test('the feast in use is the one that took the place of the chosen theme, never one chosen by hand (D-246)', () => {
  assert.equal(feastInUse(null), undefined);
  assert.equal(feastInUse({ themes: repoThemes, refused: [], chosen: 'base', current: 'natale', seasonal: true })?.id, 'natale');
  assert.equal(feastInUse({ themes: repoThemes, refused: [], chosen: 'natale', current: 'natale', seasonal: true }), undefined);
  assert.equal(feastInUse({ themes: repoThemes, refused: [], chosen: 'base', current: 'base', seasonal: true }), undefined);
  assert.equal(feastInUse({ themes: repoThemes, refused: [], chosen: 'corsia', current: 'corsia', seasonal: true }), undefined);
});

test('the window of an automatic change of theme says what changed, and «Torna a» only at the start (D-315)', () => {
  const theme = (id: string, name: string): ChatTheme => ({
    id,
    name,
    kind: id === 'base' ? 'base' : 'stagionale',
    background: { pattern: 'nessuno' },
    hud: { corners: true, glow: 'medio', radius: 'hud' },
    characters: {},
    tokens: { dark: {}, light: {} },
  });
  const listing = { themes: [theme('base', 'Base'), theme('halloween', 'Halloween')], refused: [], chosen: 'base', current: 'halloween' };
  const start = themeNoticeText(listing, { kind: 'start', key: 'halloween@2026-10-25', theme: 'halloween', until: '2026-11-01' });
  assert.equal(start.text, 'Ho messo il tema «Halloween» 🎃, fino al 1° novembre: è il tema della festa di questi giorni. Ti va bene così?');
  assert.equal(start.back, 'Torna a Base');
  const end = themeNoticeText({ ...listing, current: 'base' }, { kind: 'end', key: 'base', theme: 'halloween' });
  assert.equal(end.text, 'I giorni di «Halloween» sono finiti: sono tornata al tema Base.');
  assert.equal(end.back, undefined);
  assert.deepEqual(['2027-01-06', '2026-12-08', '2026-11-11', '2026-08-31'].map(untilText), ['fino al 6 gennaio', 'fino all’8 dicembre', 'fino all’11 novembre', 'fino al 31 agosto']);
});
