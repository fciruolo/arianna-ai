import type { Colors } from './draw.ts';
import { TILE, type OfficeMap, type TileKind } from './map.ts';
import type { Block } from './world3d.ts';

/**
 * The office of the theme Pasadena (D-243): the flat of Sheldon and Leonard
 * of The Big Bang Theory, drawn by the code as the places of D-216. A floor
 * of wooden planks, ochre walls, windows with their blinds, the whiteboard
 * with the equations in place of the shelf, the kitchen island with the
 * boxes of the takeaway at the Decisioni desk, the broken lift (the yellow
 * tape across its doors) in place of the coffee machine, the bookcases of
 * comics in place of the cabinets, and the brown couch with Sheldon's spot,
 * its left cushion, in place of the sofas; one couch more and two lifts more
 * in the hall (src/office/maps/pasadena.json). The same tiles and anchors as
 * the map `base`. In a file of its own so that the place comes and goes
 * whole; draw.ts, skins.ts and world3d.ts only call it. Fan art of the place
 * of the series for personal use, like the pack `serie` (D-211): to be removed
 * before the repository is shared. No number of the flat and no street: the
 * place has no address.
 */

type Palette = Partial<Colors>;

/** The colours of the place, light and dark, over those of the page (`skinColors`). */
export const PASADENA_PALETTES: { light: Palette; dark: Palette } = {
  light: {
    floor: '#c08a56',
    'floor-alt': '#a8743f',
    'wall-top': '#6e4a2e',
    'wall-face': '#e2b46e',
    'wall-line': '#b8874a',
    window: '#9cc4dc',
    'window-light': '#e4f1f8',
    desk: '#8a6242',
    'desk-top': '#b08660',
    'desk-shadow': '#94683e',
    chair: '#3f6f8a',
    sofa: '#8a5a36',
    'sofa-dark': '#64401f',
    counter: '#7a5a3e',
    'counter-top': '#d8cdb8',
    paper: '#fbf7ee',
  },
  dark: {
    floor: '#3e2c1e',
    'floor-alt': '#322317',
    'wall-top': '#16110c',
    'wall-face': '#5a4228',
    'wall-line': '#7a5a36',
    window: '#1c2c3c',
    'window-light': '#38546c',
    desk: '#4a3626',
    'desk-top': '#624834',
    'desk-shadow': '#0e0a07',
    chair: '#2c4e62',
    sofa: '#5e3e24',
    'sofa-dark': '#402a16',
    counter: '#4a3828',
    'counter-top': '#8a8070',
    paper: '#e6e0d2',
  },
};

/** Fixed colours of the place, the same in light and dark: they are things, not the page. */
export const PASADENA_INK = {
  board: '#f4f6f2',
  boardFrame: '#9aa0a6',
  markerBlue: '#2c5fa8',
  markerRed: '#c8302c',
  markerGreen: '#2f7a3e',
  blind: '#ece4d4',
  steel: '#a9b0b6',
  steelDark: '#6e767e',
  tape: '#f2d02c',
  tapeDark: '#2b2b2b',
  carton: '#f6f3ea',
  cartonInk: '#c8302c',
  spot: '#b5562e',
  comics: ['#c8302c', '#2c5fa8', '#f2c230', '#2f7a3e', '#7b3fa0'],
} as const;

export type Rect = (color: string, x: number, y: number, w: number, h: number) => void;

/** The wooden floor: planks along the rows, their joints staggered from row to row. */
export function pasadenaFloor(rect: Rect, C: Colors, map: Pick<OfficeMap, 'width' | 'height'>): void {
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const x = c * TILE;
      const y = r * TILE;
      rect(C.floor, x, y, TILE, TILE);
      rect(C['floor-alt'], x, y + 7, TILE, 1);
      rect(C['floor-alt'], x, y + TILE - 1, TILE, 1);
      rect(C['floor-alt'], x + ((c + r) % 2 === 0 ? 3 : 11), y, 1, 7);
      rect(C['floor-alt'], x + ((c + r) % 2 === 0 ? 11 : 5), y + 8, 1, 7);
    }
  }
}

/**
 * The face of a wall seen from the floor: a window with its blinds, the
 * whiteboard with the equations on the shelf. True when the tile is done;
 * false lets draw.ts go on (the cardwall, a plain wall).
 */
export function pasadenaWall(rect: Rect, C: Colors, kind: TileKind | undefined, x: number, y: number): boolean {
  const I = PASADENA_INK;
  if (kind === 'window') {
    rect(C.outline, x + 1, y + 2, 14, 11);
    rect(C.window, x + 2, y + 3, 12, 9);
    rect(C['window-light'], x + 3, y + 8, 4, 3);
    // The blinds, half drawn: slats on the upper part, the cord at the side.
    for (let slat = 0; slat < 3; slat++) rect(I.blind, x + 2, y + 3 + slat * 2, 12, 1);
    rect(C.outline, x + 12, y + 3, 1, 7);
    return true;
  }
  if (kind === 'shelf') {
    // The whiteboard: an aluminium frame, scribbles of equations in three markers, the tray at the bottom.
    rect(I.boardFrame, x + 1, y + 1, 14, 12);
    rect(I.board, x + 2, y + 2, 12, 10);
    rect(I.markerBlue, x + 3, y + 3, 3, 1);
    rect(I.markerBlue, x + 7, y + 3, 1, 1);
    rect(I.markerBlue, x + 9, y + 3, 4, 1);
    rect(I.markerRed, x + 3, y + 5, 5, 1);
    rect(I.markerRed, x + 9, y + 5, 2, 1);
    rect(I.markerBlue, x + 4, y + 7, 6, 1);
    rect(I.markerGreen, x + 11, y + 6, 2, 3);
    rect(I.markerBlue, x + 3, y + 9, 2, 1);
    rect(I.markerBlue, x + 6, y + 9, 5, 1);
    rect(C.outline, x + 2, y + 12, 12, 1);
    rect(I.markerRed, x + 4, y + 11, 2, 1);
    return true;
  }
  return false;
}

/** The kitchen island at the Decisioni desk: the boxes of the takeaway, chopsticks in one, and a stack of plates. */
export function pasadenaCounter(rect: Rect, C: Colors, x: number, y: number, w: number): void {
  const I = PASADENA_INK;
  for (const at of [3, 10]) {
    rect(C.outline, x + at, y - 8, 6, 7);
    rect(I.carton, x + at + 1, y - 7, 4, 5);
    rect(I.cartonInk, x + at + 2, y - 5, 2, 1);
  }
  rect(C.outline, x + 6, y - 12, 1, 4);
  rect(C.outline, x + 8, y - 11, 1, 3);
  rect(C.outline, x + w - 14, y - 4, 9, 4);
  rect(C.paper, x + w - 13, y - 3, 7, 2);
}

/** The broken lift in place of the coffee machine, a bookcase of comics in place of a cabinet. */
export function pasadenaItem(rect: Rect, C: Colors, kind: 'coffee' | 'cabinet', x: number, y: number): void {
  const I = PASADENA_INK;
  if (kind === 'coffee') {
    // Steel doors from the floor up, the line between them, the yellow tape across and the sign.
    rect(C.outline, x + 1, y - 14, 14, 28);
    rect(I.steel, x + 2, y - 13, 12, 26);
    rect(I.steelDark, x + 7, y - 13, 2, 26);
    rect(I.tape, x + 2, y - 4, 12, 2);
    rect(I.tapeDark, x + 4, y - 4, 2, 2);
    rect(I.tapeDark, x + 10, y - 4, 2, 2);
    rect(C.outline, x + 4, y - 11, 8, 5);
    rect(C.paper, x + 5, y - 10, 6, 3);
    rect(I.cartonInk, x + 6, y - 9, 4, 1);
    return;
  }
  // A bookcase of comics: three shelves of coloured spines, one of them a box of action figures.
  rect(C.outline, x + 1, y - 10, 14, 24);
  rect(C.counter, x + 2, y - 9, 12, 22);
  for (let shelf = 0; shelf < 3; shelf++) {
    const top = y - 8 + shelf * 7;
    for (let book = 0; book < 5; book++) rect(I.comics[(book + shelf) % I.comics.length] ?? C.paper, x + 3 + book * 2, top, 2, 5);
    rect(C['desk-shadow'], x + 2, top + 5, 12, 1);
  }
}

/** A run of `sofa` tiles: the brown couch, a cushion for each tile, the arms at the ends, Sheldon's spot on the left. */
export function pasadenaRun(rect: Rect, C: Colors, x: number, y: number, w: number, tiles: number): void {
  rect(C.outline, x, y - 6, w, 20);
  rect(C['sofa-dark'], x + 1, y - 5, w - 2, 8);
  rect(C.sofa, x + 1, y + 3, w - 2, 9);
  for (let i = 1; i < tiles; i++) rect(C['sofa-dark'], x + i * TILE, y + 3, 1, 9);
  // Sheldon's spot: the left cushion, a shade of its own.
  rect(PASADENA_INK.spot, x + 4, y + 4, TILE - 5, 7);
  rect(C['sofa-dark'], x + 1, y - 1, 3, 13);
  rect(C['sofa-dark'], x + w - 4, y - 1, 3, 13);
}

/** The 3D broken lift (D-230): tall steel doors with the yellow tape across. */
export function pasadenaLift3d(x: number, z: number): Block[] {
  return [
    { x, z, w: 0.86, d: 0.3, y: 0, h: 1.4, color: 'monitor' },
    { x, z, w: 0.9, d: 0.34, y: 0.8, h: 0.12, color: 'warn' },
  ];
}

/** The 3D bookcase of comics: a tall case, the spines a strip of colour on its front. */
export function pasadenaBookcase3d(x: number, z: number): Block[] {
  return [
    { x, z, w: 0.9, d: 0.5, y: 0, h: 1.2, color: 'counter' },
    { x, z, w: 0.8, d: 0.52, y: 0.3, h: 0.6, color: 'info' },
  ];
}
