import type { Colors } from './draw.ts';

/**
 * The office of the theme «I Griffin» (D-238): the Griffin house in Quahog
 * with the Drunken Clam. Wooden floorboards, warm walls with a wainscot,
 * the sign of the Clam on the walls, the bar with its taps at Decisioni, the
 * family couch with the television in front of it, the jukebox. In a file of
 * its own, called by draw.ts and skins.ts. Fan art of the places of the
 * series for personal use, like the pack `serie` (D-211, D-216): to be
 * removed before the repository is shared.
 */

type Palette = Partial<Colors>;

export const QUAHOG_PALETTE: { light: Palette; dark: Palette } = {
  light: {
    floor: '#c99b68',
    'floor-alt': '#a97c4e',
    'wall-top': '#8a6a4a',
    'wall-face': '#e8d9b0',
    'wall-line': '#7a5a3a',
    window: '#bcdcef',
    'window-light': '#f0f8fc',
    desk: '#8a5e3a',
    'desk-top': '#a8774c',
    'desk-shadow': '#8a6a46',
    chair: '#6a8a4a',
    sofa: '#9aa86a',
    'sofa-dark': '#6e7c48',
    counter: '#6a4228',
    'counter-top': '#8e5c38',
    paper: '#fbf6e8',
  },
  dark: {
    floor: '#3a2c1e',
    'floor-alt': '#2c2116',
    'wall-top': '#120d08',
    'wall-face': '#3c3424',
    'wall-line': '#5a4228',
    window: '#1e3448',
    'window-light': '#3a5f80',
    desk: '#4a3220',
    'desk-top': '#62442c',
    'desk-shadow': '#0c0906',
    chair: '#3e5230',
    sofa: '#5e6a3e',
    'sofa-dark': '#3e4828',
    counter: '#3e2616',
    'counter-top': '#5a3a22',
    paper: '#ece4cc',
  },
};

/** Fixed colours of the place, the same in light and dark: things, not the page. */
export const QUAHOG_INK = {
  clam: '#f0a07a',
  clamDark: '#c86a4a',
  sign: '#2a3a4a',
  beer: '#e8b23a',
  foam: '#fbf6e8',
  tap: '#c9ccd0',
  tv: '#5a4a3a',
  tvScreen: '#7fb4d8',
  jukebox: ['#e2574c', '#f2b84b', '#7fd19a', '#8fb5e6'],
} as const;

type Rect = (color: string, x: number, y: number, w: number, h: number) => void;

/** One tile of floorboards: three boards, their joints staggered from row to row. */
export function quahogFloor(rect: Rect, C: Colors, c: number, r: number, tile: number): void {
  const x = c * tile;
  const y = r * tile;
  rect(C.floor, x, y, tile, tile);
  for (const line of [0, 5, 10]) rect(C['floor-alt'], x, y + line, tile, 1);
  const joint = (c * 5 + r * 3) % tile;
  rect(C['floor-alt'], x + joint, y + 1, 1, 4);
  rect(C['floor-alt'], x + ((joint + 8) % tile), y + 6, 1, 4);
}

/** The wainscot on every face of a wall: the lower part of the wall in wood. */
export function quahogWainscot(rect: Rect, C: Colors, x: number, y: number, tile: number): void {
  rect(C.desk, x, y + 9, tile, tile - 11);
  rect(C['wall-line'], x, y + 9, tile, 1);
}

/** The sign of the Drunken Clam where a shelf hangs: a dark plate with a clam shell. */
export function quahogSign(rect: Rect, C: Colors, x: number, y: number): void {
  const I = QUAHOG_INK;
  rect(C.outline, x + 1, y + 1, 14, 11);
  rect(I.sign, x + 2, y + 2, 12, 9);
  rect(I.clamDark, x + 5, y + 4, 6, 5);
  rect(I.clam, x + 6, y + 4, 4, 4);
  rect(I.clamDark, x + 7, y + 4, 1, 4);
  rect(I.clam, x + 4, y + 7, 8, 1);
  rect(I.foam, x + 3, y + 9, 10, 1);
}

/** The bar of the Clam at Decisioni: the taps and a pint on the counter. */
export function quahogBar(rect: Rect, C: Colors, x: number, y: number, w: number): void {
  const I = QUAHOG_INK;
  for (let i = 0; i < 3; i++) {
    rect(C.outline, x + 4 + i * 4, y - 8, 3, 6);
    rect(I.tap, x + 5 + i * 4, y - 7, 1, 5);
  }
  rect(C.outline, x + w - 13, y - 8, 6, 7);
  rect(I.beer, x + w - 12, y - 6, 4, 5);
  rect(I.foam, x + w - 12, y - 7, 4, 1);
}

/** The television of the Griffins where the coffee machine stands, the jukebox of the Clam where the cabinet does. */
export function quahogItem(rect: Rect, C: Colors, kind: 'coffee' | 'cabinet', x: number, y: number): void {
  const I = QUAHOG_INK;
  if (kind === 'coffee') {
    // An old television on its low cabinet, the rabbit ears on top.
    rect(C.outline, x + 4, y - 12, 1, 3);
    rect(C.outline, x + 11, y - 12, 1, 3);
    rect(C.outline, x + 1, y - 9, 14, 12);
    rect(I.tv, x + 2, y - 8, 12, 10);
    rect(C.outline, x + 3, y - 7, 8, 7);
    rect(I.tvScreen, x + 4, y - 6, 6, 5);
    rect(C.paper, x + 12, y - 6, 1, 1);
    rect(C.paper, x + 12, y - 3, 1, 1);
    rect(C.outline, x + 1, y + 3, 14, 11);
    rect(C.desk, x + 2, y + 4, 12, 9);
    rect(C['desk-top'], x + 7, y + 5, 2, 7);
    return;
  }
  // The jukebox: a rounded top, the coloured lights, the grille.
  rect(C.outline, x + 3, y - 11, 10, 1);
  rect(C.outline, x + 1, y - 10, 14, 24);
  rect(C.counter, x + 2, y - 9, 12, 22);
  rect(I.tvScreen, x + 4, y - 8, 8, 4);
  for (let i = 0; i < 4; i++) rect(I.jukebox[i] ?? C.accent, x + 3 + i * 3, y - 3, 2, 2);
  for (let i = 0; i < 3; i++) rect(C['counter-top'], x + 4, y + 1 + i * 3, 8, 1);
}

/** A run of sofa tiles: the family couch, with a cushion on each tile. */
export function quahogCouch(rect: Rect, C: Colors, x: number, y: number, w: number, tiles: number, tile: number): void {
  rect(C.outline, x, y - 6, w, 20);
  rect(C['sofa-dark'], x + 1, y - 5, w - 2, 9);
  rect(C.sofa, x + 1, y + 4, w - 2, 9);
  for (let i = 0; i < tiles; i++) rect(C['sofa-dark'], x + 3 + i * tile, y - 3, tile - 6, 5);
  for (let i = 1; i < tiles; i++) rect(C['sofa-dark'], x + i * tile, y + 4, 1, 9);
  rect(C.outline, x, y - 2, 3, 16);
  rect(C.outline, x + w - 3, y - 2, 3, 16);
}
