import type { Colors } from './draw.ts';
import { inRoom, TILE, tileAt, type OfficeMap } from './map.ts';

/**
 * The house of the Smiths in Langley Falls, the office of the theme Langley
 * (D-239, American Dad!): a wooden floor of planks, cream walls with a red
 * skirting, the flag framed on the wall where the shelves are, the kitchen
 * counter with a pie and a mug as the Decisioni desk, the fridge in place of
 * the coffee machine, the family couch; the cabinets are the filing cabinets
 * of the CIA in the archive, Klaus's bowl on its little table for the one
 * closest to the kitchen counter, the television of the living room for the
 * others. In a file of its own, called by draw.ts and skins.ts. Fan art
 * of a place of the series for personal use, like the pack `serie` (D-211):
 * to be removed before the repository is shared.
 */

type Palette = Partial<Colors>;

export const LANGLEY_PALETTE: { light: Palette; dark: Palette } = {
  light: {
    floor: '#c9a27a',
    'floor-alt': '#a9825c',
    'wall-top': '#8e9ab3',
    'wall-face': '#ece6d6',
    'wall-line': '#a8424c',
    window: '#cfe0ee',
    'window-light': '#f1f7fb',
    desk: '#7a5638',
    'desk-top': '#9a7350',
    'desk-shadow': '#86664a',
    chair: '#2f4a7c',
    sofa: '#c8b48e',
    'sofa-dark': '#8e7a58',
    counter: '#d9d4c8',
    'counter-top': '#f4f2ec',
    paper: '#fbf8ef',
  },
  dark: {
    floor: '#3a2e24',
    'floor-alt': '#2c221a',
    'wall-top': '#10141f',
    'wall-face': '#262c3c',
    'wall-line': '#7a2a33',
    window: '#22334a',
    'window-light': '#3d5f8c',
    desk: '#4a3626',
    'desk-top': '#5f4632',
    'desk-shadow': '#0d0e10',
    chair: '#24365a',
    sofa: '#5e5240',
    'sofa-dark': '#3e3528',
    counter: '#3a3e48',
    'counter-top': '#525866',
    paper: '#ece6d6',
  },
};

/** Fixed colours of the house, the same in light and dark: they are things, not the page. */
export const LANGLEY_INK = {
  red: '#b22234',
  white: '#f4f1e8',
  blue: '#3c3b6e',
  fridge: '#eef0f2',
  fridgeDark: '#b9c0c8',
  glass: '#bfe1f0',
  water: '#8fc6ef',
  fish: '#f08a2c',
  pie: '#d9a25c',
  pieDark: '#a8742e',
} as const;

type Rect = (color: string, x: number, y: number, w: number, h: number) => void;

/** The wooden floor: four planks a tile, their joints staggered from row to row. */
export function langleyFloor(rect: Rect, C: Colors, map: OfficeMap): void {
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const x = c * TILE;
      const y = r * TILE;
      rect(C.floor, x, y, TILE, TILE);
      for (let plank = 0; plank < 4; plank++) {
        rect(C['floor-alt'], x, y + plank * 4 + 3, TILE, 1);
        rect(C['floor-alt'], x + ((c * 7 + r * 5 + plank * 9) % TILE), y + plank * 4, 1, 3);
      }
    }
  }
}

/** The flag in a frame on the wall: the blue canton with its white stars, red and white stripes. */
export function langleyShelf(rect: Rect, C: Colors, x: number, y: number): void {
  const I = LANGLEY_INK;
  rect(C.outline, x + 1, y + 2, 14, 11);
  for (let stripe = 0; stripe < 9; stripe++) rect(stripe % 2 === 0 ? I.red : I.white, x + 2, y + 3 + stripe, 12, 1);
  rect(I.blue, x + 2, y + 3, 5, 5);
  for (const [dx, dy] of [[3, 4], [5, 4], [4, 5], [3, 6], [5, 6]] as const) rect(I.white, x + dx, y + dy, 1, 1);
}

/** On the kitchen counter (the Decisioni desk): a pie on its plate and a mug. */
export function langleyCounter(rect: Rect, C: Colors, x: number, y: number, w: number): void {
  const I = LANGLEY_INK;
  rect(C.outline, x + 3, y - 4, 10, 3);
  rect(C.paper, x + 3, y - 2, 10, 1);
  rect(I.pie, x + 4, y - 5, 8, 3);
  rect(I.pieDark, x + 5, y - 5, 1, 1);
  rect(I.pieDark, x + 8, y - 5, 1, 1);
  rect(I.pieDark, x + 10, y - 4, 1, 1);
  rect(C.outline, x + w - 12, y - 7, 6, 6);
  rect(I.red, x + w - 11, y - 6, 4, 4);
  rect(I.white, x + w - 10, y - 5, 2, 1);
  rect(C.outline, x + w - 6, y - 5, 2, 2);
}

/** What a cabinet tile is in the house: a filing cabinet in the archive, Klaus's bowl, the television. */
export type LangleyCabinet = 'files' | 'bowl' | 'tv';

/**
 * The cabinet at `c,r`: in the archive's room the files of the CIA; outside
 * it Klaus's bowl for the one closest to the Decisioni desk (the kitchen
 * counter, where the bowl stands in the series), first in reading order on a
 * tie; the television for every other. The same in 2D and in 3D.
 */
export function langleyCabinet(map: OfficeMap, c: number, r: number): LangleyCabinet {
  const archive = map.anchors.archive.room;
  if (inRoom(archive, c, r)) return 'files';
  const bowl = bowlOf(map);
  return bowl !== null && bowl[0] === c && bowl[1] === r ? 'bowl' : 'tv';
}

/** The tile of Klaus's bowl, found once per map (the 2D view asks at every frame). */
const BOWLS = new WeakMap<OfficeMap, [number, number] | null>();
function bowlOf(map: OfficeMap): [number, number] | null {
  const known = BOWLS.get(map);
  if (known !== undefined) return known;
  const archive = map.anchors.archive.room;
  const desk = map.anchors.decisions.desk;
  const [dx, dy] = [desk[0] + desk[2] / 2, desk[1] + 0.5];
  let best: [number, number] | null = null;
  let distance = Infinity;
  for (let rr = 0; rr < map.height; rr++) {
    for (let cc = 0; cc < map.width; cc++) {
      if (tileAt(map, cc, rr) !== 'cabinet' || inRoom(archive, cc, rr)) continue;
      const d = Math.hypot(cc + 0.5 - dx, rr + 0.5 - dy);
      if (d < distance) [best, distance] = [[cc, rr], d];
    }
  }
  BOWLS.set(map, best);
  return best;
}

/** The fridge in place of the coffee machine. */
export function langleyFridge(rect: Rect, C: Colors, x: number, y: number): void {
  const I = LANGLEY_INK;
  rect(C.outline, x + 1, y - 12, 14, 26);
  rect(I.fridge, x + 2, y - 11, 12, 24);
  rect(I.fridgeDark, x + 2, y - 3, 12, 1);
  rect(I.fridgeDark, x + 11, y - 9, 1, 4);
  rect(I.fridgeDark, x + 11, y, 1, 6);
  // A drawing on the door, held by a magnet.
  rect(C.paper, x + 4, y - 9, 4, 4);
  rect(I.red, x + 5, y - 10, 2, 1);
  rect(I.blue, x + 5, y - 8, 2, 2);
}

/** A cabinet of the house, as `langleyCabinet` says. */
export function langleyCabinetItem(rect: Rect, C: Colors, x: number, y: number, cabinet: LangleyCabinet): void {
  const I = LANGLEY_INK;
  if (cabinet === 'files') {
    // A grey filing cabinet of the CIA, the red label of the secret files on its drawers.
    rect(C.outline, x + 1, y - 10, 14, 24);
    rect(I.fridgeDark, x + 2, y - 9, 12, 22);
    for (let i = 0; i < 3; i++) {
      rect(C.outline, x + 2, y - 3 + i * 7, 12, 1);
      rect(I.red, x + 5, y - 7 + i * 7, 6, 2);
    }
    return;
  }
  if (cabinet === 'tv') {
    // The television of the living room on its low cabinet.
    rect(C.outline, x + 1, y + 3, 14, 11);
    rect(C.desk, x + 2, y + 4, 12, 9);
    rect(C['desk-top'], x + 2, y + 4, 12, 1);
    rect(C.outline, x + 2, y - 8, 12, 11);
    rect(C.monitor, x + 3, y - 7, 10, 9);
    rect(C['screen-off'], x + 4, y - 6, 8, 6);
    rect(C.outline, x + 7, y + 3, 2, 1);
    return;
  }
  // The table.
  rect(C.outline, x + 2, y + 2, 12, 12);
  rect(C.desk, x + 3, y + 3, 10, 3);
  rect(C['desk-top'], x + 3, y + 3, 10, 1);
  rect(C.desk, x + 4, y + 6, 2, 7);
  rect(C.desk, x + 10, y + 6, 2, 7);
  // The bowl, the water, the goldfish.
  rect(C.outline, x + 3, y - 9, 10, 11);
  rect(I.glass, x + 4, y - 8, 8, 9);
  rect(I.water, x + 4, y - 6, 8, 7);
  rect(I.fish, x + 6, y - 4, 4, 2);
  rect(I.fish, x + 10, y - 5, 1, 4);
  rect(C.outline, x + 7, y - 4, 1, 1);
  rect(I.white, x + 5, y - 7, 1, 2);
}

/** A run of `sofa` tiles: the family couch, its back, a cushion a tile and the arms. */
export function langleyRun(rect: Rect, C: Colors, x: number, y: number, w: number, tiles: number): void {
  rect(C.outline, x, y - 6, w, 20);
  rect(C['sofa-dark'], x + 1, y - 5, w - 2, 8);
  rect(C.sofa, x + 1, y + 3, w - 2, 10);
  for (let i = 0; i < tiles; i++) {
    rect(C.sofa, x + 3 + i * TILE, y - 3, TILE - 6, 5);
    if (i > 0) rect(C['sofa-dark'], x + i * TILE, y + 3, 1, 10);
  }
  rect(C['sofa-dark'], x + 1, y - 1, 2, 14);
  rect(C['sofa-dark'], x + w - 3, y - 1, 2, 14);
  rect(LANGLEY_INK.red, x + 4, y - 2, 4, 3);
}
