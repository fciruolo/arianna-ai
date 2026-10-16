import type { Colors } from './draw.ts';
import { parseMapText, type OfficeMap } from './map.ts';
import { SPRINGFIELD_PALETTE } from './springfield.ts';
import { QUAHOG_PALETTE } from './quahog.ts';

/**
 * The office of a theme (D-216): with Scrubs the Sacro Cuore (tiled floor,
 * nurses' station, beds, carts, the vending machine, the green cross), with
 * The Office the Dunder Mifflin (carpet, Pam's reception, Michael's glass
 * office, the photocopier, the meeting table, the sign), with I Simpson the
 * nuclear power plant of Springfield (D-237, `springfield.ts`). The same tile kinds
 * and anchors as the map `base`: the theme changes the plan a little (its map
 * in src/office/maps/) and how the code draws floor, walls and furniture.
 * Base stays as it was, pixel for pixel. Fan art of the places of the series
 * for personal use, like the pack `serie` (D-211): to be removed before the
 * repository is shared.
 */
export const OFFICE_SKINS = ['base', 'corsia', 'ufficio', 'springfield', 'quahog'] as const;
export type OfficeSkin = (typeof OFFICE_SKINS)[number];

/** The office of the theme in use: its own for the themes of the series (the id of the theme is the id of the place), otherwise the base. */
export function skinOfTheme(theme: string | undefined): OfficeSkin {
  return OFFICE_SKINS.find((skin) => skin !== 'base' && skin === theme) ?? 'base';
}

type Palette = Partial<Colors>;

const PALETTES: Readonly<Record<Exclude<OfficeSkin, 'base'>, { light: Palette; dark: Palette }>> = {
  corsia: {
    light: {
      floor: '#e9efee',
      'floor-alt': '#cfdcda',
      'wall-top': '#8fbab2',
      'wall-face': '#d3e8e4',
      'wall-line': '#5fae9c',
      window: '#bcdde6',
      'window-light': '#eef8fa',
      desk: '#c4cdd1',
      'desk-top': '#e8edf0',
      'desk-shadow': '#aeb9bd',
      chair: '#5f9fd8',
      sofa: '#ffffff',
      'sofa-dark': '#5f9fd8',
      counter: '#d3e2df',
      'counter-top': '#f3f7f6',
      paper: '#ffffff',
    },
    dark: {
      floor: '#15211f',
      'floor-alt': '#0f1817',
      'wall-top': '#07110f',
      'wall-face': '#1b3430',
      'wall-line': '#2f7d6a',
      window: '#1b3a42',
      'window-light': '#2c5d66',
      desk: '#2b393c',
      'desk-top': '#3e5155',
      'desk-shadow': '#050b0d',
      chair: '#3d6fa6',
      sofa: '#d6e0de',
      'sofa-dark': '#3d6fa6',
      counter: '#23403b',
      'counter-top': '#38615a',
      paper: '#dcebe8',
    },
  },
  ufficio: {
    light: {
      floor: '#9b968b',
      'floor-alt': '#8a857a',
      'wall-top': '#b4ac9c',
      'wall-face': '#e8e0cd',
      'wall-line': '#9e9683',
      window: '#cfe0ee',
      'window-light': '#f1f7fb',
      desk: '#8a7458',
      'desk-top': '#a98f6d',
      'desk-shadow': '#6d685e',
      chair: '#3b4152',
      sofa: '#8a6d4c',
      'sofa-dark': '#5a4632',
      counter: '#b9a784',
      'counter-top': '#d9c9a5',
      paper: '#fbf8ef',
    },
    dark: {
      floor: '#2b2d32',
      'floor-alt': '#232529',
      'wall-top': '#141519',
      'wall-face': '#302f33',
      'wall-line': '#47464a',
      window: '#22334a',
      'window-light': '#3d5f8c',
      desk: '#4a3e30',
      'desk-top': '#5f503e',
      'desk-shadow': '#0d0e10',
      chair: '#24272e',
      sofa: '#5a4834',
      'sofa-dark': '#3a2f22',
      counter: '#3b3429',
      'counter-top': '#51473a',
      paper: '#ece6d6',
    },
  },
  // The nuclear power plant of Springfield (D-237), in its own file.
  springfield: SPRINGFIELD_PALETTE,
  // The Griffin house and the Drunken Clam (D-238), in a file of its own.
  quahog: QUAHOG_PALETTE,
};

/** Fixed colours of the places, the same in light and dark: they are things, not the page. */
export const SKIN_INK = {
  /** The green cross of a hospital: never red on white, a protected emblem (D-103). */
  cross: '#2f9e5b',
  crossLight: '#7fd19a',
  metal: '#9aa6ad',
  metalDark: '#5d6670',
  blanket: '#5f9fd8',
  snack: ['#e2574c', '#f2b84b', '#4fa3e0', '#7fd19a'],
  water: '#8fc6ef',
  copier: '#d8d8d2',
  copierDark: '#8c8c86',
  sign: '#2b3a55',
  signInk: '#f4f1e8',
  candy: ['#e2574c', '#f2b84b', '#7fd19a', '#8fb5e6'],
  glass: '#bfe1f0',
} as const;

function luminance(hex: string): number {
  const value = /^#([0-9a-f]{6})/i.exec(hex)?.[1];
  if (value === undefined) return 0.5;
  const number = Number.parseInt(value, 16);
  return (0.2126 * ((number >> 16) & 0xff) + 0.7152 * ((number >> 8) & 0xff) + 0.0722 * (number & 0xff)) / 255;
}

/**
 * The colours of the office in `skin`: the base ones untouched for Base (the
 * same object), else the place's palette over them, light or dark as the
 * floor of the page is (the theme tokens, accent and the rest, stay).
 */
export function skinColors(colors: Colors, skin: OfficeSkin): Colors {
  if (skin === 'base') return colors;
  const palettes = PALETTES[skin];
  return { ...colors, ...(luminance(colors.floor) < 0.35 ? palettes.dark : palettes.light) };
}

/**
 * The map of the office in `skin` from the texts of the maps (D-216): the
 * place's own when it passes the validator, otherwise the base map, with the
 * place's colours and furniture all the same (the fallback of D-106). The
 * problem is the reason a map was refused: of the base map when even that one
 * does not pass, or of the place's when the base took its place.
 */
export function officeMapOf(skin: OfficeSkin, texts: Readonly<Record<OfficeSkin, string>>): { map: OfficeMap | null; problem: string | null; fallback: boolean } {
  const own = parseMapText(texts[skin]);
  if (own.ok) return { map: own.map, problem: null, fallback: false };
  if (skin === 'base') return { map: null, problem: own.reason, fallback: false };
  const base = parseMapText(texts.base);
  return base.ok ? { map: base.map, problem: own.reason, fallback: true } : { map: null, problem: base.reason, fallback: true };
}

/** What the page shows (D-216): an error without any map, else the office, with a notice when the base map stands in for the place's. */
export type OfficeView = { kind: 'error'; text: string } | { kind: 'office'; map: OfficeMap; notice: string | null };

export function officeView(chosen: ReturnType<typeof officeMapOf>): OfficeView {
  if (chosen.map === null) return { kind: 'error', text: `La mappa dell'ufficio non è valida: ${chosen.problem ?? 'motivo sconosciuto'}.` };
  const notice = chosen.fallback ? `La pianta del tema non è valida (${chosen.problem ?? 'motivo sconosciuto'}): l'ufficio usa quella di base con i colori del tema.` : null;
  return { kind: 'office', map: chosen.map, notice };
}
