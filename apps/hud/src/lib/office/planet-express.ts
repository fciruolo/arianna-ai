import type { Colors } from './draw.ts';
import { inRoom, TILE, tileAt, type OfficeMap, type TileKind } from './map.ts';
import type { Block } from './world3d.ts';

/**
 * The office of the theme Planet Express (D-242): the headquarters of the
 * delivery company of Futurama, drawn by the code as the places of D-216.
 * Metal floor plates with their rivets, mint walls with a purple stripe,
 * portholes for windows, the logo of the company in place of the shelf, the
 * meeting table at the Decisioni desk, the transport tubes in place of the
 * coffee machine, the delivery crates in place of the cabinets, the green
 * couch in place of the sofas, and the ship parked in the hall: a run of three
 * cabinets or more outside the archive (src/office/maps/planet-express.json).
 * The same tiles and anchors as the map `base`. In a file of its own so that
 * the place comes and goes whole; draw.ts, skins.ts and world3d.ts only call
 * it. Fan art of the place of the series for personal use, like the pack
 * `serie` (D-211): to be removed before the repository is shared.
 */

type Palette = Partial<Colors>;

/** The colours of the place, light and dark, over those of the page (`skinColors`). */
export const PLANET_EXPRESS_PALETTES: { light: Palette; dark: Palette } = {
  light: {
    floor: '#c9cfd6',
    'floor-alt': '#aeb6bf',
    'wall-top': '#5a4a78',
    'wall-face': '#d9e8dc',
    'wall-line': '#9fb8a6',
    window: '#2c3e6e',
    'window-light': '#8fb8f0',
    desk: '#7d8a99',
    'desk-top': '#a3afbd',
    'desk-shadow': '#9aa2ab',
    chair: '#6a3f96',
    sofa: '#9a8a5a',
    'sofa-dark': '#6e6238',
    counter: '#9a6a44',
    'counter-top': '#c08e60',
    paper: '#fbfaf4',
  },
  dark: {
    floor: '#24272e',
    'floor-alt': '#1b1e24',
    'wall-top': '#120f1f',
    'wall-face': '#2a3a32',
    'wall-line': '#3f5a4a',
    window: '#0e1630',
    'window-light': '#3c5a9a',
    desk: '#3a4250',
    'desk-top': '#4c5666',
    'desk-shadow': '#0a0b0e',
    chair: '#4a2c6a',
    sofa: '#6e6238',
    'sofa-dark': '#4a4226',
    counter: '#5a3e28',
    'counter-top': '#7a5638',
    paper: '#e6e3da',
  },
};

/** Fixed colours of the place, the same in light and dark: they are things, not the page. */
export const PLANET_EXPRESS_INK = {
  hull: '#5fae7c',
  hullDark: '#3f8058',
  hullLight: '#8fd4a6',
  cockpit: '#2a3f6a',
  glass: '#bfe6f2',
  glassLight: '#eef9fc',
  flame: '#f28c28',
  flameCore: '#ffe08a',
  purple: '#7b3fa0',
  plate: '#2b2340',
  logo: '#e8e4f4',
  ring: '#8a93a3',
  crate: '#c9a26a',
  crateDark: '#9a7848',
} as const;

export type Rect = (color: string, x: number, y: number, w: number, h: number) => void;

/** The metal plates of the floor: a seam on two sides, a rivet in each corner. */
export function planetExpressFloor(rect: Rect, C: Colors, map: Pick<OfficeMap, 'width' | 'height'>): void {
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const x = c * TILE;
      const y = r * TILE;
      rect(C.floor, x, y, TILE, TILE);
      rect(C['floor-alt'], x + TILE - 1, y, 1, TILE);
      rect(C['floor-alt'], x, y + TILE - 1, TILE, 1);
      for (const [dx, dy] of [[2, 2], [12, 2], [2, 12], [12, 12]] as const) rect(C['floor-alt'], x + dx, y + dy, 1, 1);
    }
  }
}

/**
 * The face of a wall seen from the floor: the purple stripe, a porthole for a
 * window, the logo of the company on the shelf. True when the tile is done;
 * false lets draw.ts go on (the cardwall).
 */
export function planetExpressWall(rect: Rect, C: Colors, kind: TileKind | undefined, x: number, y: number): boolean {
  const I = PLANET_EXPRESS_INK;
  rect(I.purple, x, y + 9, TILE, 2);
  if (kind === 'window') {
    // A round porthole on the stars: a metal ring, the dark glass, a star and the light on the glass.
    rect(C.outline, x + 4, y + 1, 8, 13);
    rect(C.outline, x + 2, y + 3, 12, 9);
    rect(C.outline, x + 3, y + 2, 10, 11);
    rect(I.ring, x + 4, y + 2, 8, 11);
    rect(I.ring, x + 3, y + 3, 10, 9);
    rect(C.window, x + 5, y + 4, 6, 7);
    rect(C.window, x + 4, y + 5, 8, 5);
    rect(C['window-light'], x + 5, y + 5, 2, 2);
    rect(I.logo, x + 9, y + 8, 1, 1);
    return true;
  }
  if (kind === 'shelf') {
    // The logo of the company: the planet with its ring and the little ship flying round it, on a dark plate.
    rect(C.outline, x + 1, y + 2, 14, 11);
    rect(I.plate, x + 2, y + 3, 12, 9);
    rect(I.logo, x + 6, y + 4, 4, 6);
    rect(I.logo, x + 5, y + 5, 6, 4);
    rect(I.hull, x + 3, y + 7, 10, 1);
    rect(I.hull, x + 10, y + 4, 3, 2);
    rect(I.flame, x + 9, y + 5, 1, 1);
    return true;
  }
  return false;
}

/** The meeting table at the Decisioni desk: the logo on its front, the papers of the briefing and a mug on top. */
export function planetExpressCounter(rect: Rect, C: Colors, x: number, y: number, w: number): void {
  const I = PLANET_EXPRESS_INK;
  rect(I.logo, x + 5, y + 5, 4, 6);
  rect(I.logo, x + 4, y + 6, 6, 4);
  rect(I.hull, x + 2, y + 8, 10, 1);
  rect(C.outline, x + 14, y - 3, 10, 4);
  rect(C.paper, x + 15, y - 2, 8, 2);
  rect(C.outline, x + w - 8, y - 6, 5, 6);
  rect(I.hull, x + w - 7, y - 5, 3, 4);
}

/** What a cabinet tile is at the Planet Express: a delivery crate, or a piece of the ship parked in the hall. */
export type PlanetExpressCabinet = 'crate' | 'ship-tail' | 'ship-body' | 'ship-nose';

/** The ship is a run of three cabinets or more in a row, outside the archive (whose cabinet the engine walks to); any other cabinet is a crate. */
export function planetExpressCabinet(map: OfficeMap, c: number, r: number): PlanetExpressCabinet {
  if (tileAt(map, c, r) !== 'cabinet' || inRoom(map.anchors.archive.room, c, r)) return 'crate';
  let start = c;
  while (tileAt(map, start - 1, r) === 'cabinet') start--;
  let end = c;
  while (tileAt(map, end + 1, r) === 'cabinet') end++;
  if (end - start + 1 < 3) return 'crate';
  return c === start ? 'ship-tail' : c === end ? 'ship-nose' : 'ship-body';
}

/** The transport tube in place of the coffee machine; a crate or a piece of the ship in place of a cabinet. */
export function planetExpressItem(rect: Rect, C: Colors, kind: 'coffee' | 'cabinet', x: number, y: number, map: OfficeMap): void {
  const I = PLANET_EXPRESS_INK;
  if (kind === 'coffee') {
    // A glass tube from the floor up, with its metal rings.
    rect(C.outline, x + 2, y - 16, 12, 30);
    rect(I.ring, x + 3, y - 15, 10, 3);
    rect(I.glass, x + 4, y - 12, 8, 21);
    rect(I.glassLight, x + 5, y - 11, 2, 18);
    rect(I.ring, x + 3, y + 9, 10, 4);
    return;
  }
  const piece = planetExpressCabinet(map, x / TILE, y / TILE);
  if (piece === 'crate') {
    // A cardboard crate of the deliveries: the tape and the green mark of the company.
    rect(C.outline, x + 1, y - 6, 14, 20);
    rect(I.crate, x + 2, y - 5, 12, 18);
    rect(I.crateDark, x + 2, y + 3, 12, 1);
    rect(I.crateDark, x + 7, y - 5, 2, 8);
    rect(I.hull, x + 4, y + 6, 3, 3);
    return;
  }
  // The ship, one tile at a time: the green hull with its dark band, the legs, the fin and the flame at the tail, the cockpit at the nose.
  const left = piece === 'ship-tail' ? 3 : 0;
  const right = piece === 'ship-nose' ? 3 : 0;
  rect(C.outline, x + left, y - 7, TILE - left - right, 17);
  // Inside the outline: one pixel in at a rounded end, none where the hull goes on into the next tile.
  const from = x + left + (left > 0 ? 1 : 0);
  const width = TILE - left - right - (left > 0 ? 1 : 0) - (right > 0 ? 1 : 0);
  rect(I.hull, from, y - 6, width, 15);
  rect(I.hullLight, from, y - 6, width, 2);
  rect(I.hullDark, from, y + 3, width, 2);
  rect(C.outline, x + 6, y + 10, 2, 4);
  if (piece === 'ship-tail') {
    rect(C.outline, x + 5, y - 13, 6, 7);
    rect(I.hull, x + 6, y - 12, 4, 6);
    rect(I.flame, x, y - 2, 3, 6);
    rect(I.flameCore, x + 1, y, 2, 2);
  }
  if (piece === 'ship-nose') {
    rect(C.outline, x + 4, y - 6, 8, 7);
    rect(I.cockpit, x + 5, y - 5, 6, 5);
    rect(I.glass, x + 6, y - 4, 2, 2);
    rect(C.outline, x + 13, y - 4, 1, 12);
  }
}

/** A run of `sofa` tiles: the green couch of the lounge, a cushion for each tile, the arms at the ends. */
export function planetExpressRun(rect: Rect, C: Colors, x: number, y: number, w: number, tiles: number): void {
  rect(C.outline, x, y - 6, w, 20);
  rect(C['sofa-dark'], x + 1, y - 5, w - 2, 8);
  rect(C.sofa, x + 1, y + 3, w - 2, 9);
  for (let i = 1; i < tiles; i++) rect(C['sofa-dark'], x + i * TILE, y + 3, 1, 9);
  rect(C['sofa-dark'], x + 1, y - 1, 3, 13);
  rect(C['sofa-dark'], x + w - 4, y - 1, 3, 13);
}

/** The 3D transport tube (D-230): a glass column between two metal rings. */
export function planetExpressTube3d(x: number, z: number): Block[] {
  return [
    { x, z, w: 0.5, d: 0.5, y: 0, h: 0.15, color: 'outline' },
    { x, z, w: 0.42, d: 0.42, y: 0.15, h: 1.15, color: 'window-light' },
    { x, z, w: 0.5, d: 0.5, y: 1.3, h: 0.12, color: 'outline' },
  ];
}

/** A cabinet in 3D: a crate, or a piece of the ship in the green of the theme (the fin and the flame at the tail, the cockpit at the nose). */
export function planetExpressCabinet3d(map: OfficeMap, c: number, r: number, x: number, z: number): Block[] {
  const piece = planetExpressCabinet(map, c, r);
  switch (piece) {
    case 'crate':
      return [
        { x, z, w: 0.8, d: 0.8, y: 0, h: 0.55, color: 'counter' },
        { x, z, w: 0.6, d: 0.6, y: 0.55, h: 0.4, color: 'counter-top' },
      ];
    case 'ship-tail':
      return [
        { x: x + 0.05, z, w: 0.9, d: 0.7, y: 0.25, h: 0.5, color: 'ok' },
        { x, z, w: 0.3, d: 0.1, y: 0.75, h: 0.45, color: 'ok' },
        { x: x - 0.42, z, w: 0.12, d: 0.4, y: 0.35, h: 0.3, color: 'warn' },
      ];
    case 'ship-body':
      return [
        { x, z, w: 1, d: 0.8, y: 0.2, h: 0.6, color: 'ok' },
        { x, z, w: 1, d: 0.82, y: 0.42, h: 0.08, color: 'sofa-dark' },
        { x, z, w: 0.1, d: 0.1, y: 0, h: 0.2, color: 'outline' },
      ];
    case 'ship-nose':
      return [
        { x: x - 0.05, z, w: 0.9, d: 0.75, y: 0.2, h: 0.55, color: 'ok' },
        { x: x + 0.1, z, w: 0.5, d: 0.5, y: 0.75, h: 0.25, color: 'window' },
      ];
  }
}
