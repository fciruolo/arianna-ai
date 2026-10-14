/**
 * The themes of the chat (D-103): colours, background and costumes, as the
 * core serves them already checked (`GET /api/themes`). The page applies
 * only the tokens of its own list, with `style.setProperty`, and the closed
 * values of background and HUD as attributes on <html>, read by style.css:
 * nothing of a theme reaches the CSS as written. Base has no file: removing
 * every property gives back the colours of style.css.
 */

/** The same list as THEME_TOKENS of the core (apps/core/src/themes.ts), repeated: the page does not import the core. */
export const THEME_TOKENS = [
  'bg',
  'surface',
  'surface-2',
  'line',
  'line-strong',
  'ink',
  'muted',
  'accent',
  'accent-ink',
  'bubble',
  'bubble-ink',
  'glow',
  'warn',
  'danger',
  'ok',
  'info',
  'l0',
  'l1',
  'l2',
  'l3',
  'graph-1',
  'graph-2',
  'graph-3',
  'graph-4',
  'graph-5',
  'graph-6',
  'deco-a',
  'deco-b',
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeTokens = Partial<Record<ThemeToken, string>>;

export const PATTERNS = ['griglia', 'puntini', 'righe', 'nessuno'] as const;
export const DECORS = ['neve', 'trifogli', 'pipistrelli', 'coriandoli', 'sole', 'puntini-pastello', 'corrimano', 'moquette', 'nuvole', 'carta-da-parati'] as const;
export const GLOWS = ['nessuno', 'tenue', 'medio', 'forte'] as const;
export const RADII = ['squadrato', 'hud', 'morbido'] as const;

export interface ChatTheme {
  id: string;
  name: string;
  kind: 'serie' | 'stagionale';
  description?: string;
  background: { pattern: (typeof PATTERNS)[number]; decor?: (typeof DECORS)[number] };
  hud: { corners: boolean; glow: (typeof GLOWS)[number]; radius: (typeof RADII)[number] };
  characters: Record<string, string>;
  tokens: { dark: ThemeTokens; light: ThemeTokens };
}

export interface ThemeListing {
  themes: ChatTheme[];
  refused: { theme: string; reason: string }[];
  /** As written in `[appearance]`. */
  chosen: string;
  /** In use: the chosen one, or Base when it is missing or refused. */
  current: string;
}

export const BASE_THEME = 'base';
export const BASE_NAME = 'Base';

const COLOUR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

/** The properties a theme sets on <html> for one mode: listed tokens with a valid colour only. */
export function themeProperties(theme: ChatTheme | undefined, mode: 'dark' | 'light'): Map<string, string> {
  const properties = new Map<string, string>();
  if (theme === undefined) return properties;
  const tokens = theme.tokens[mode];
  for (const token of THEME_TOKENS) {
    const value = tokens[token];
    if (typeof value === 'string' && COLOUR.test(value)) properties.set(`--${token}`, value);
  }
  // The glow of the HUD (D-103, punto 1) is the accent at a fixed strength, or none.
  const accent = properties.get('--accent');
  const strength: Record<string, string> = { tenue: '22', medio: '33', forte: '55' };
  const alpha = strength[theme.hud.glow];
  if (theme.hud.glow === 'nessuno') properties.set('--glow', 'transparent');
  else if (accent !== undefined && alpha !== undefined && !properties.has('--glow')) properties.set('--glow', `${accent.slice(0, 7)}${alpha}`);
  return properties;
}

/** The attributes of <html> that style.css reads: pattern, decoration, corners, radius. */
export function themeAttributes(theme: ChatTheme | undefined): Record<string, string | undefined> {
  if (theme === undefined) return { 'data-pattern': undefined, 'data-decor': undefined, 'data-corners': undefined, 'data-radius': undefined };
  return {
    'data-pattern': PATTERNS.includes(theme.background.pattern) ? theme.background.pattern : undefined,
    'data-decor': theme.background.decor !== undefined && DECORS.includes(theme.background.decor) ? theme.background.decor : undefined,
    'data-corners': theme.hud.corners ? undefined : 'off',
    'data-radius': RADII.includes(theme.hud.radius) && theme.hud.radius !== 'hud' ? theme.hud.radius : undefined,
  };
}

interface StyleTarget {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): string };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Every custom property a theme may have set, so Base removes them all. */
const ALL_PROPERTIES = THEME_TOKENS.map((token) => `--${token}`);

/** Applies a theme (or Base, with undefined) to <html> for the mode the page shows. */
export function applyTheme(target: StyleTarget, theme: ChatTheme | undefined, mode: 'dark' | 'light'): void {
  const properties = themeProperties(theme, mode);
  for (const name of ALL_PROPERTIES) {
    const value = properties.get(name);
    if (value === undefined) target.style.removeProperty(name);
    else target.style.setProperty(name, value);
  }
  for (const [name, value] of Object.entries(themeAttributes(theme))) {
    if (value === undefined) target.removeAttribute(name);
    else target.setAttribute(name, value);
  }
}

/** The theme in use, from the listing: undefined is Base. */
export function activeTheme(listing: ThemeListing | null): ChatTheme | undefined {
  if (listing === null || listing.current === BASE_THEME) return undefined;
  return listing.themes.find((theme) => theme.id === listing.current);
}

// Contrast (WCAG 2.x), for the test of every theme and the preview of Impostazioni.

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbOf(hex: string): [number, number, number, number] {
  const value = hex.slice(1);
  const at = (index: number) => Number.parseInt(value.slice(index, index + 2), 16);
  return [at(0), at(2), at(4), value.length === 8 ? at(6) / 255 : 1];
}

/** A colour with alpha laid over an opaque one. */
export function over(top: string, bottom: string): string {
  const [r, g, b, a] = rgbOf(top);
  const [br, bg, bb] = rgbOf(bottom);
  const mix = (front: number, back: number) => Math.round(front * a + back * (1 - a)).toString(16).padStart(2, '0');
  return `#${mix(r, br)}${mix(g, bg)}${mix(b, bb)}`;
}

export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast ratio of two colours, the front laid over the back when it has alpha. */
export function contrast(front: string, back: string): number {
  const solid = over(front, back);
  const [a, b] = [luminance(solid), luminance(over(back, '#000000'))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The pairs of D-103 (punto 4): front, back, minimum. */
export const CONTRAST_PAIRS: readonly [ThemeToken, ThemeToken, number][] = [
  ['ink', 'bg', 4.5],
  ['ink', 'surface', 4.5],
  ['ink', 'surface-2', 4.5],
  ['muted', 'surface', 4.5],
  ['muted', 'surface-2', 4.5],
  ['bubble-ink', 'bubble', 4.5],
  ['accent-ink', 'accent', 4.5],
  ['l0', 'surface', 4.5],
  ['l1', 'surface', 4.5],
  ['l2', 'surface', 4.5],
  ['l3', 'surface', 4.5],
  ['warn', 'surface', 4.5],
  ['danger', 'surface', 4.5],
  ['ok', 'surface', 4.5],
  ['info', 'surface', 4.5],
  ['accent', 'bg', 3],
];

/** The pairs under their minimum, with tokens missing from the theme taken from `base`. */
export function lowContrast(tokens: ThemeTokens, base: ThemeTokens): { pair: string; ratio: number; minimum: number }[] {
  const value = (token: ThemeToken) => tokens[token] ?? base[token];
  const low: { pair: string; ratio: number; minimum: number }[] = [];
  for (const [front, back, minimum] of CONTRAST_PAIRS) {
    const [a, b] = [value(front), value(back)];
    if (a === undefined || b === undefined) {
      low.push({ pair: `${front} su ${back}`, ratio: 0, minimum });
      continue;
    }
    const ratio = contrast(a, b);
    if (ratio < minimum) low.push({ pair: `${front} su ${back}`, ratio: Math.round(ratio * 100) / 100, minimum });
  }
  return low;
}
