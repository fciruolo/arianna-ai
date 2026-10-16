import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { BASE_THEME, CHARACTER_ID, THEME_ID } from '@arianna/config';

import { readSmall } from './characters.ts';
import { inWindow, windowLength, type CalendarDay } from './feasts.ts';

/**
 * The themes of the web chat (D-103): colours, background and costumes of the
 * characters, as data. A theme is a folder `apps/hud/themes/<id>/` with only
 * `theme.json`, read by the core in sole reading and served already checked
 * (`GET /api/themes`). The schema is closed: an unknown key, a colour that is
 * not `#rrggbb(aa)`, a value outside the lists refuse the whole theme; no
 * field ever reaches the CSS as written, and no text may carry an address or
 * an import, so a theme cannot become a way out for what the page shows.
 * Base is `apps/hud/themes/base` (D-246), kind `base`; when its folder is
 * missing or refused the chat is what style.css draws. The seasonal themes
 * (the feasts) take the place of Base in their window when the switch of
 * `[appearance]` is on, never the place of a theme chosen by hand.
 */

/** The tokens a theme may set: those of style.css, plus the two colours of the decorations. */
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

export const THEME_KINDS = ['base', 'serie', 'stagionale'] as const;
export const PATTERNS = ['griglia', 'puntini', 'righe', 'nessuno'] as const;
export const DECORS = ['neve', 'trifogli', 'pipistrelli', 'coriandoli', 'sole', 'puntini-pastello', 'corrimano', 'moquette', 'nuvole', 'carta-da-parati'] as const;
export const GLOWS = ['nessuno', 'tenue', 'medio', 'forte'] as const;
export const RADII = ['squadrato', 'hud', 'morbido'] as const;
export const FEASTS = ['carnevale', 'pasqua'] as const;

export type ThemeTokens = Partial<Record<ThemeToken, string>>;

export interface Theme {
  id: string;
  name: string;
  kind: (typeof THEME_KINDS)[number];
  /** One line under the name, shown as text. */
  description?: string;
  /** Only for the seasonal themes: a window of days, or a movable feast (D-103, punto 2). */
  dates?: { from: string; to: string } | { feast: (typeof FEASTS)[number] };
  background: { pattern: (typeof PATTERNS)[number]; decor?: (typeof DECORS)[number] };
  hud: { corners: boolean; glow: (typeof GLOWS)[number]; radius: (typeof RADII)[number] };
  /** Agent → `<pack>/<character>`; a choice in `[characters]` always wins. */
  characters: Record<string, string>;
  tokens: { dark: ThemeTokens; light: ThemeTokens };
}

export interface ThemeListing {
  themes: Theme[];
  /** Folders left out, with the reason (no content). */
  refused: { theme: string; reason: string }[];
}

export const MAX_THEME_BYTES = 16 * 1024;
const MAX_THEMES = 64;
const MAX_AGENTS = 16;
const COLOUR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;
const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** What no text of a theme may contain: an address, a CSS function that loads, an import. */
const FORBIDDEN = /:\/\/|url\(|@import|[<>]/i;

export class ThemeError extends Error {
  override name = 'ThemeError';
}

type Table = Record<string, unknown>;

function table(value: unknown, where: string): Table {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ThemeError(`${where}: expected an object`);
  return value as Table;
}

/** A key of the file in a message: shown in Impostazioni, so never longer than 40. */
function shown(key: string): string {
  return key.length > 40 ? `${key.slice(0, 40)}…` : key;
}

function only(value: Table, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ThemeError(`${where}: unknown key "${shown(key)}"`);
}

function oneOf<T extends string>(value: unknown, list: readonly T[], where: string): T {
  const found = list.find((item) => item === value);
  if (found === undefined) throw new ThemeError(`${where}: one of ${list.join(', ')}`);
  return found;
}

function text(value: unknown, max: number, where: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new ThemeError(`${where}: text of 1-${String(max)} characters`);
  if (/[\p{Cc}]/u.test(value) || FORBIDDEN.test(value)) throw new ThemeError(`${where}: no addresses, imports, markup or control characters`);
  return value.trim();
}

function monthDay(value: unknown, where: string): string {
  if (typeof value !== 'string' || !MONTH_DAY.test(value)) throw new ThemeError(`${where}: "MM-DD"`);
  const [month = 0, day = 0] = value.split('-').map(Number);
  if (day > (DAYS_IN_MONTH[month - 1] ?? 0)) throw new ThemeError(`${where}: no such day`);
  return value;
}

function tokens(value: unknown, where: string): ThemeTokens {
  const record = table(value, where);
  only(record, THEME_TOKENS, where);
  const result: ThemeTokens = {};
  for (const token of THEME_TOKENS) {
    const colour = record[token];
    if (colour === undefined) continue;
    if (typeof colour !== 'string' || !COLOUR.test(colour)) throw new ThemeError(`${where}.${token}: "#rrggbb" or "#rrggbbaa", lowercase`);
    result[token] = colour;
  }
  return result;
}

/** Checks the content of a theme.json; `folder` is the name of its folder, which the id must repeat. */
export function parseTheme(raw: string, folder: string): Theme {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ThemeError('theme.json is not valid JSON');
  }
  const root = table(value, 'theme.json');
  only(root, ['id', 'name', 'kind', 'description', 'dates', 'background', 'hud', 'characters', 'tokens'], 'theme.json');
  if (typeof root.id !== 'string' || !THEME_ID.test(root.id)) throw new ThemeError('id: lowercase letters, digits and -, at most 40');
  if (root.id !== folder) throw new ThemeError('id: the same as the name of the folder');

  let dates: Theme['dates'];
  if (root.dates !== undefined) {
    const record = table(root.dates, 'dates');
    if ('feast' in record) {
      only(record, ['feast'], 'dates');
      dates = { feast: oneOf(record.feast, FEASTS, 'dates.feast') };
    } else {
      only(record, ['from', 'to'], 'dates');
      dates = { from: monthDay(record.from, 'dates.from'), to: monthDay(record.to, 'dates.to') };
    }
  }

  const background = table(root.background, 'background');
  only(background, ['pattern', 'decor'], 'background');
  const hud = table(root.hud, 'hud');
  only(hud, ['corners', 'glow', 'radius'], 'hud');
  if (typeof hud.corners !== 'boolean') throw new ThemeError('hud.corners: true or false');

  const characters: Record<string, string> = {};
  if (root.characters !== undefined) {
    const record = table(root.characters, 'characters');
    if (Object.keys(record).length > MAX_AGENTS) throw new ThemeError(`characters: at most ${String(MAX_AGENTS)} agents`);
    for (const [agent, choice] of Object.entries(record)) {
      const where = `characters.${shown(agent)}`;
      if (!CHARACTER_ID.test(agent)) throw new ThemeError(`${where}: an agent id is lowercase letters, digits, - and _`);
      const parts = typeof choice === 'string' ? choice.split('/') : [];
      if (parts.length !== 2 || !parts.every((part) => CHARACTER_ID.test(part))) throw new ThemeError(`${where}: "<pack>/<character>"`);
      characters[agent] = choice as string;
    }
  }

  const palette = table(root.tokens, 'tokens');
  only(palette, ['dark', 'light'], 'tokens');

  const kind = oneOf(root.kind, THEME_KINDS, 'kind');
  if (dates !== undefined && kind !== 'stagionale') throw new ThemeError('dates: only a seasonal theme has dates');
  if (kind === 'stagionale' && dates === undefined) throw new ThemeError('dates: a seasonal theme has its days');
  if ((kind === 'base') !== (root.id === BASE_THEME)) throw new ThemeError('kind: "base" is the theme base alone');
  const decor = background.decor === undefined ? undefined : oneOf(background.decor, DECORS, 'background.decor');
  return {
    id: root.id,
    name: text(root.name, 40, 'name'),
    kind,
    ...(root.description === undefined ? {} : { description: text(root.description, 160, 'description') }),
    ...(dates === undefined ? {} : { dates }),
    background: { pattern: oneOf(background.pattern, PATTERNS, 'background.pattern'), ...(decor === undefined ? {} : { decor }) },
    hud: { corners: hud.corners, glow: oneOf(hud.glow, GLOWS, 'hud.glow'), radius: oneOf(hud.radius, RADII, 'hud.radius') },
    characters,
    tokens: { dark: tokens(palette.dark, 'tokens.dark'), light: tokens(palette.light, 'tokens.light') },
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof ThemeError) return error.message;
  if (error instanceof Error && error.name === 'PackError') return error.message;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return code === 'ENOENT' ? 'theme.json is missing' : 'unreadable';
}

/**
 * One folder: a real folder there (never a link), holding theme.json alone,
 * at most 16 KB, opened without following a link.
 */
async function readTheme(dir: string, folder: string): Promise<Theme> {
  if (!THEME_ID.test(folder)) throw new ThemeError('the folder name is lowercase letters, digits and -');
  const path = join(dir, folder);
  if (!(await lstat(path)).isDirectory()) throw new ThemeError('not a folder');
  if ((await realpath(path)) !== join(await realpath(dir), folder)) throw new ThemeError('not a folder');
  const entries = await readdir(path);
  if (entries.length !== 1 || entries[0] !== 'theme.json') throw new ThemeError('the folder holds theme.json alone');
  return parseTheme((await readSmall(join(path, 'theme.json'), MAX_THEME_BYTES)).toString('utf8'), folder);
}

/** Every theme that passes the checks, by id; read again at each call. A missing folder means no theme but Base. */
export async function listThemes(dir: string): Promise<ThemeListing> {
  let folders: string[];
  try {
    folders = (await readdir(dir)).filter((name) => !name.startsWith('.')).sort();
  } catch {
    return { themes: [], refused: [] };
  }
  const themes: Theme[] = [];
  const refused: ThemeListing['refused'] = [];
  for (const folder of folders.slice(MAX_THEMES)) refused.push({ theme: folder.slice(0, 64), reason: `more than ${String(MAX_THEMES)} themes` });
  for (const folder of folders.slice(0, MAX_THEMES)) {
    try {
      themes.push(await readTheme(dir, folder));
    } catch (error) {
      refused.push({ theme: folder.slice(0, 64), reason: reasonOf(error) });
    }
  }
  return { themes, refused };
}

/** The feast of `today` (D-246): the seasonal theme whose window holds it, the shorter window first when two meet. */
export function feastOf(themes: readonly Theme[], today: CalendarDay): Theme | undefined {
  let found: { theme: Theme; length: number } | undefined;
  for (const theme of themes) {
    if (theme.kind !== 'stagionale' || theme.dates === undefined || !inWindow(theme.dates, today)) continue;
    const length = windowLength(theme.dates, today);
    if (found === undefined || length < found.length) found = { theme, length };
  }
  return found?.theme;
}

/**
 * The theme in use: the one chosen when it is served, otherwise Base; with
 * the feasts on (D-246), Base gives way to the feast of the day. A theme
 * chosen by hand, seasonal ones included, is never replaced.
 */
export function currentTheme(chosen: string, themes: readonly Theme[], feasts?: { on: boolean; today: CalendarDay }): string {
  const served = themes.some((theme) => theme.id === chosen) ? chosen : BASE_THEME;
  if (served !== BASE_THEME || feasts?.on !== true) return served;
  return feastOf(themes, feasts.today)?.id ?? BASE_THEME;
}

/**
 * The characters the theme `id` gives the agents (D-214), read at once for a
 * step of the model: the same checks as `listThemes` for that one folder (a
 * real folder, theme.json alone, at most 16 KB, never through a link, the
 * closed schema). A missing or refused theme: none.
 */
export function themeCharactersSync(dir: string, id: string): Record<string, string> {
  return readThemeSync(dir, id)?.characters ?? {};
}

/** One theme read at once with the checks of `listThemes`; undefined when missing or refused. */
function readThemeSync(dir: string, id: string): Theme | undefined {
  if (!THEME_ID.test(id)) return undefined;
  try {
    const path = join(dir, id);
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== join(realpathSync(dir), id)) return undefined;
    const entries = readdirSync(path);
    if (entries.length !== 1 || entries[0] !== 'theme.json') return undefined;
    const handle = openSync(join(path, 'theme.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(handle);
      if (!info.isFile() || info.size > MAX_THEME_BYTES) return undefined;
      const buffer = Buffer.alloc(info.size);
      readSync(handle, buffer, 0, info.size, 0);
      return parseTheme(buffer.toString('utf8'), id);
    } catch {
      return undefined;
    } finally {
      closeSync(handle);
    }
  } catch {
    return undefined;
  }
}

/**
 * The theme in use, read at once (D-246), for a step of the model: the same
 * answer as `currentTheme` over `listThemes`, so the prompt names the costume
 * the chat shows. The folders are read only when Base gives way to a feast.
 */
export function currentThemeSync(dir: string, chosen: string, feasts?: { on: boolean; today: CalendarDay }): string {
  const served = readThemeSync(dir, chosen) === undefined ? BASE_THEME : chosen;
  if (served !== BASE_THEME || feasts?.on !== true) return served;
  let folders: string[];
  try {
    folders = readdirSync(dir).filter((name) => !name.startsWith('.')).sort().slice(0, MAX_THEMES);
  } catch {
    return BASE_THEME;
  }
  const themes = folders.flatMap((folder) => readThemeSync(dir, folder) ?? []);
  return feastOf(themes, feasts.today)?.id ?? BASE_THEME;
}
