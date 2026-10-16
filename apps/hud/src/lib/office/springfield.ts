import type { Colors } from './draw.ts';
import { TILE } from './map.ts';

/**
 * The office of the theme «I Simpson» (D-237, as the places of D-216): the
 * nuclear power plant of Springfield. Concrete tiles with their plates, pale
 * green walls with the yellow and black hazard stripe, the radiation sign
 * where the base office has its shelves, the control console of sector 7G as
 * the Decisioni desk, the box of pink doughnuts in place of the coffee
 * machine, the barrels with a glowing rod in place of the cabinets, and the
 * family couch in the break room. In a file of its own, so it goes away whole
 * with the pack `serie` before the repository is shared (fan art for personal
 * use, D-211).
 */

type Palette = Partial<Colors>;
type Rect = (color: string, x: number, y: number, w: number, h: number) => void;

export const SPRINGFIELD_PALETTE: { light: Palette; dark: Palette } = {
  light: {
    floor: '#d9d4c3',
    'floor-alt': '#c4bea9',
    'wall-top': '#7f8f7a',
    'wall-face': '#b8c9a6',
    'wall-line': '#6f8a5c',
    window: '#9fd3f5',
    'window-light': '#e6f5ff',
    desk: '#8a8f99',
    'desk-top': '#b5bac2',
    'desk-shadow': '#6d7079',
    chair: '#c0503a',
    sofa: '#9a6aa0',
    'sofa-dark': '#6e4a74',
    counter: '#7d8a96',
    'counter-top': '#a9b6c2',
    paper: '#fbf8ef',
  },
  dark: {
    floor: '#23262b',
    'floor-alt': '#1b1d21',
    'wall-top': '#0d1310',
    'wall-face': '#2a3a2c',
    'wall-line': '#4a6a3e',
    window: '#1d3550',
    'window-light': '#3d6c9c',
    desk: '#3d424b',
    'desk-top': '#555b66',
    'desk-shadow': '#0b0c0e',
    chair: '#8a3426',
    sofa: '#6e4a74',
    'sofa-dark': '#4a3050',
    counter: '#36404a',
    'counter-top': '#4d5966',
    paper: '#ece6d6',
  },
};

/** Fixed colours of the plant, the same in light and dark: they are things, not the page. */
export const SPRINGFIELD_INK = {
  hazard: '#f2c200',
  hazardDark: '#1a1c2c',
  rod: '#8dff5a',
  rodDark: '#3fae2a',
  barrel: '#d8a21a',
  barrelDark: '#9a7210',
  donut: '#f4a3c4',
  dough: '#e0a868',
  box: '#f4f1e8',
  sprinkles: ['#e2574c', '#4fa3e0', '#7fd19a', '#f2b84b'],
  lights: ['#e2574c', '#7fd19a', '#f2b84b', '#4fa3e0'],
} as const;

const I = SPRINGFIELD_INK;

/** A tile of the floor: a concrete plate, its joints and a rivet in each corner. */
export function springfieldFloor(rect: Rect, C: Colors, c: number, r: number): void {
  const x = c * TILE;
  const y = r * TILE;
  rect(C.floor, x, y, TILE, TILE);
  rect(C['floor-alt'], x, y + TILE - 1, TILE, 1);
  rect(C['floor-alt'], x + TILE - 1, y, 1, TILE);
  for (const [dx, dy] of [[2, 2], [12, 2], [2, 12], [12, 12]] as const) rect(C['floor-alt'], x + dx, y + dy, 1, 1);
}

/** The hazard stripe along the face of a wall: yellow and black in steps of two pixels. */
export function springfieldStripe(rect: Rect, x: number, y: number): void {
  for (let i = 0; i < TILE; i += 2) rect((x / 2 + i / 2) % 2 === 0 ? I.hazard : I.hazardDark, x + i, y + 9, 2, 2);
}

/** The radiation sign on a yellow plate: the dot in the middle and the three blades. */
export function springfieldSign(rect: Rect, C: Colors, x: number, y: number): void {
  rect(C.outline, x + 2, y + 1, 12, 12);
  rect(I.hazard, x + 3, y + 2, 10, 10);
  rect(I.hazardDark, x + 7, y + 6, 2, 2);
  rect(I.hazardDark, x + 6, y + 3, 4, 2);
  rect(I.hazardDark, x + 4, y + 8, 3, 2);
  rect(I.hazardDark, x + 9, y + 8, 3, 2);
}

/** The control console of sector 7G on the Decisioni desk: a row of lights and the big lever. */
export function springfieldConsole(rect: Rect, C: Colors, x: number, y: number, w: number): void {
  rect(C.outline, x + 3, y - 7, w - 20, 6);
  rect(C.monitor, x + 4, y - 6, w - 22, 4);
  for (let i = 0; i < Math.floor((w - 24) / 3); i++) rect(I.lights[i % I.lights.length] ?? C.accent, x + 5 + i * 3, y - 5, 2, 2);
  rect(C.outline, x + w - 14, y - 9, 2, 8);
  rect(C.danger, x + w - 15, y - 11, 4, 3);
}

/** The box of pink doughnuts (for the coffee machine) and the barrel with its glowing rod (for the cabinet). */
export function springfieldItem(rect: Rect, C: Colors, kind: 'coffee' | 'cabinet', x: number, y: number): void {
  if (kind === 'coffee') {
    // A cabinet on legs with the open box on top.
    rect(C.outline, x + 1, y - 2, 14, 16);
    rect(C.counter, x + 2, y - 1, 12, 14);
    rect(C['counter-top'], x + 2, y - 1, 12, 2);
    rect(C.outline, x + 1, y - 9, 14, 8);
    rect(I.box, x + 2, y - 8, 12, 6);
    for (let i = 0; i < 2; i++) {
      const dx = x + 3 + i * 6;
      rect(I.dough, dx, y - 7, 4, 4);
      rect(I.donut, dx, y - 7, 4, 3);
      rect(I.box, dx + 1, y - 6, 2, 1);
      rect(I.sprinkles[i * 2] ?? C.accent, dx, y - 7, 1, 1);
      rect(I.sprinkles[i * 2 + 1] ?? C.accent, dx + 3, y - 6, 1, 1);
    }
    return;
  }
  rect(C.outline, x + 2, y - 8, 12, 22);
  rect(I.barrel, x + 3, y - 7, 10, 20);
  rect(I.barrelDark, x + 3, y - 2, 10, 1);
  rect(I.barrelDark, x + 3, y + 6, 10, 1);
  rect(I.hazardDark, x + 7, y + 1, 2, 2);
  // The rod that glows out of the lid.
  rect(C.outline, x + 6, y - 13, 4, 6);
  rect(I.rodDark, x + 7, y - 12, 2, 5);
  rect(I.rod, x + 7, y - 12, 1, 4);
}

/** A run of `sofa` tiles: the family couch, its cushions and the armrests. */
export function springfieldCouch(rect: Rect, C: Colors, x: number, y: number, w: number, tiles: number): void {
  rect(C.outline, x, y - 6, w, 20);
  rect(C['sofa-dark'], x + 1, y - 5, w - 2, 8);
  rect(C.sofa, x + 1, y + 3, w - 2, 10);
  for (let i = 0; i < tiles; i++) rect(C['sofa-dark'], x + i * TILE + 2, y + 4, TILE - 4, 1);
  rect(C.outline, x, y - 1, 4, 15);
  rect(C['sofa-dark'], x + 1, y, 2, 13);
  rect(C.outline, x + w - 4, y - 1, 4, 15);
  rect(C['sofa-dark'], x + w - 3, y, 2, 13);
}
