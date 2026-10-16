import type { Colors } from './draw.ts';
import { TILE, type OfficeMap, type TileKind } from './map.ts';
import type { Block } from './world3d.ts';

/**
 * The office of the theme Fox River (D-240): the penitentiary of Prison
 * Break, drawn by the code as the places of D-216. Concrete floor with its
 * expansion joints, cinder-block walls, barred windows, the plate of the
 * state penitentiary in place of the shelf, the guard post at the Decisioni
 * desk, the payphone in place of the coffee machine, grey lockers in place of
 * the cabinets, steel cots in place of the sofas. The same tiles and anchors
 * as the map `base` (src/office/maps/fox-river.json). In a file of its own so
 * that the place comes and goes whole; draw.ts, skins.ts and world3d.ts only
 * call it. Fan art of the place of the series for personal use, like the pack
 * `serie` (D-211): to be removed before the repository is shared.
 */

type Palette = Partial<Colors>;

/** The colours of the place, light and dark, over those of the page (`skinColors`). */
export const FOX_RIVER_PALETTES: { light: Palette; dark: Palette } = {
  light: {
    floor: '#b9b7b1',
    'floor-alt': '#a6a49e',
    'wall-top': '#7d8187',
    'wall-face': '#cfcfca',
    'wall-line': '#9a9b97',
    window: '#a9bccb',
    'window-light': '#e3ecf2',
    desk: '#7c858e',
    'desk-top': '#9aa3ab',
    'desk-shadow': '#8f8d88',
    chair: '#3f5f8a',
    sofa: '#d9d6cc',
    'sofa-dark': '#5a6f8f',
    counter: '#8e969c',
    'counter-top': '#b3bac0',
    paper: '#f5f3ec',
  },
  dark: {
    floor: '#2a2b2c',
    'floor-alt': '#232425',
    'wall-top': '#121314',
    'wall-face': '#34363a',
    'wall-line': '#4a4d52',
    window: '#1f2c38',
    'window-light': '#3c5266',
    desk: '#3a4047',
    'desk-top': '#4c535b',
    'desk-shadow': '#0c0d0e',
    chair: '#2c4366',
    sofa: '#8f8c84',
    'sofa-dark': '#2f4366',
    counter: '#3b4046',
    'counter-top': '#525960',
    paper: '#e6e3da',
  },
};

/** Fixed colours of the place, the same in light and dark: they are things, not the page. */
export const FOX_RIVER_INK = {
  bars: '#3a3d42',
  barsLight: '#8a9098',
  orange: '#e8742a',
  plate: '#24344f',
  plateInk: '#f1efe6',
  steel: '#9aa3ab',
  steelDark: '#5d6670',
  handset: '#1f2124',
  radio: '#2b2e33',
  led: '#7fd19a',
} as const;

export type Rect = (color: string, x: number, y: number, w: number, h: number) => void;

/** The concrete floor: speckles of the aggregate, a joint every two tiles. */
export function foxRiverFloor(rect: Rect, C: Colors, map: Pick<OfficeMap, 'width' | 'height'>): void {
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const x = c * TILE;
      const y = r * TILE;
      rect(C.floor, x, y, TILE, TILE);
      for (let i = 0; i < 4; i++) rect(C['floor-alt'], x + ((c * 11 + r * 5 + i * 7) % TILE), y + ((c * 3 + r * 13 + i * 5) % TILE), 1, 1);
      if (c % 2 === 1) rect(C['floor-alt'], x + TILE - 1, y, 1, TILE);
      if (r % 2 === 1) rect(C['floor-alt'], x, y + TILE - 1, TILE, 1);
    }
  }
}

/**
 * The face of a wall seen from the floor: cinder blocks with their mortar, a
 * window with its bars, the plate of the penitentiary on the shelf. True when
 * the tile is done; false lets draw.ts go on (the cardwall, a plain wall).
 */
export function foxRiverWall(rect: Rect, C: Colors, kind: TileKind | undefined, x: number, y: number, row: number): boolean {
  const I = FOX_RIVER_INK;
  for (let course = 0; course < 3; course++) {
    const top = y + 1 + course * 4;
    rect(C['wall-line'], x, top + 3, TILE, 1);
    const shift = (course + row) % 2 === 0 ? 0 : 4;
    for (let joint = shift; joint < TILE; joint += 8) rect(C['wall-line'], x + joint, top, 1, 3);
  }
  if (kind === 'window') {
    rect(C.outline, x + 1, y + 2, 14, 11);
    rect(C.window, x + 2, y + 3, 12, 9);
    rect(C['window-light'], x + 3, y + 4, 3, 3);
    for (const bar of [4, 7, 10]) rect(I.bars, x + bar, y + 3, 1, 9);
    rect(I.bars, x + 2, y + 7, 12, 1);
    return true;
  }
  if (kind === 'shelf') {
    // The plate of the state penitentiary: a dark blue plate, a white seal, an orange stripe and two lines of writing.
    rect(C.outline, x + 1, y + 2, 14, 11);
    rect(I.plate, x + 2, y + 3, 12, 9);
    rect(I.plateInk, x + 3, y + 4, 4, 4);
    rect(I.plate, x + 4, y + 5, 2, 2);
    rect(I.plateInk, x + 8, y + 5, 5, 1);
    rect(I.plateInk, x + 8, y + 7, 4, 1);
    rect(I.orange, x + 2, y + 10, 12, 1);
    return true;
  }
  return false;
}

/** The guard post at the Decisioni desk: a radio with its aerial and the screen of the cameras. */
export function foxRiverCounter(rect: Rect, C: Colors, x: number, y: number, w: number): void {
  const I = FOX_RIVER_INK;
  rect(I.orange, x + 1, y + 11, w - 2, 1);
  rect(C.outline, x + 3, y - 8, 5, 7);
  rect(I.radio, x + 4, y - 7, 3, 5);
  rect(I.led, x + 5, y - 6, 1, 1);
  rect(C.outline, x + 6, y - 12, 1, 4);
  rect(C.outline, x + w - 14, y - 9, 10, 8);
  rect(C.monitor, x + w - 13, y - 8, 8, 5);
  rect(C.screen, x + w - 12, y - 7, 3, 3);
  rect(C.screen, x + w - 8, y - 7, 2, 3);
}

/** The payphone of the corridor in place of the coffee machine, the grey lockers in place of the cabinets. */
export function foxRiverItem(rect: Rect, C: Colors, kind: 'coffee' | 'cabinet', x: number, y: number): void {
  const I = FOX_RIVER_INK;
  if (kind === 'coffee') {
    rect(C.outline, x + 3, y - 12, 10, 16);
    rect(I.steel, x + 4, y - 11, 8, 14);
    rect(I.steelDark, x + 5, y - 9, 6, 4);
    for (let i = 0; i < 3; i++) rect(C.outline, x + 5 + i * 2, y - 3, 1, 1);
    rect(I.handset, x + 2, y - 10, 2, 8);
    rect(I.handset, x + 3, y - 2, 1, 6);
    rect(C.outline, x + 7, y + 4, 2, 10);
    return;
  }
  rect(C.outline, x + 1, y - 10, 14, 24);
  rect(I.steel, x + 2, y - 9, 12, 22);
  rect(C.outline, x + 7, y - 9, 1, 22);
  for (const left of [3, 9]) {
    for (let i = 0; i < 3; i++) rect(I.steelDark, x + left, y - 7 + i * 2, 4, 1);
    rect(C.outline, x + left + 3, y + 2, 1, 2);
  }
}

/** A run of `sofa` tiles: steel cots with a thin mattress and the blue blanket folded at the foot. */
export function foxRiverRun(rect: Rect, C: Colors, x: number, y: number, tiles: number): void {
  const I = FOX_RIVER_INK;
  for (let i = 0; i < tiles; i++) {
    const bx = x + i * TILE;
    rect(C.outline, bx + 1, y - 3, 14, 15);
    rect(I.steelDark, bx + 2, y - 2, 12, 13);
    rect(C.sofa, bx + 3, y - 2, 10, 10);
    rect(C.paper, bx + 4, y - 1, 8, 2);
    rect(C['sofa-dark'], bx + 3, y + 5, 10, 3);
    rect(C.outline, bx + 2, y + 11, 2, 3);
    rect(C.outline, bx + 12, y + 11, 2, 3);
  }
}

/** The 3D payphone (D-230): a box on a post, the handset on its side. */
export function foxRiverPhone3d(x: number, z: number): Block[] {
  return [
    { x, z, w: 0.12, d: 0.12, y: 0, h: 0.75, color: 'outline' },
    { x, z, w: 0.45, d: 0.3, y: 0.75, h: 0.55, color: 'counter-top' },
    { x: x - 0.27, z, w: 0.08, d: 0.12, y: 0.85, h: 0.35, color: 'monitor' },
  ];
}

/** The bars of a window in 3D, in front of its glass on the side of the floor: three uprights and a crossbar. */
export function foxRiverBars3d(c: number, r: number, side: { dc: number; dr: number }): Block[] {
  const out = 0.575;
  const x = c + 0.5 + side.dc * out;
  const z = r + 0.5 + side.dr * out;
  const bar = (offset: number, width: number, y: number, h: number): Block =>
    side.dc === 0 ? { x: x + offset, z, w: width, d: 0.04, y, h, color: 'outline' } : { x, z: z + offset, w: 0.04, d: width, y, h, color: 'outline' };
  return [bar(-0.22, 0.04, 0.55, 0.65), bar(0, 0.04, 0.55, 0.65), bar(0.22, 0.04, 0.55, 0.65), bar(0, 0.62, 0.86, 0.04)];
}
