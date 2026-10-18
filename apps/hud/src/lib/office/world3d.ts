import type { ColorName } from './draw.ts';
import { langleyCabinet } from './langley.ts';
import { foxRiverBars3d, foxRiverPhone3d } from './fox-river.ts';
import { planetExpressCabinet3d, planetExpressTube3d } from './planet-express.ts';
import { pasadenaBookcase3d, pasadenaLift3d } from './pasadena.ts';
import { inRoom, isWall, isWalkable, TILE, tileAt, type OfficeMap, type Point, type Room, type TileKind } from './map.ts';
import type { Actor, Facing } from './motion.ts';
import type { OfficeSkin } from './skins.ts';
import { FEAST_INK, FEAST_STYLE, type FeastDecor, type FeastProp } from './feasts.ts';
import type { OfficeSnapshot } from './snapshot.ts';
import { archiveCount, islandName } from './view.ts';
import type { Label } from '../types.ts';

/**
 * The office in 3D (D-230): the same map, walked in first person. This file
 * has no three.js in it: it turns the tiles into a list of floor tiles and
 * boxes (walls raised about 1.5 tiles, doors as gaps with a lintel, the
 * furniture as simple blocks in the colours of the theme and of the place),
 * and holds the rules the 3D view shares with the 2D one: the walk of the
 * keys turned by where the camera looks, which side of a sprite the camera
 * sees, what the user can see through the walls. The 3D view draws the same
 * state as the 2D one (the photograph, the actors, the user's point on the
 * map): nothing new comes from the core. One unit of the 3D world is one tile;
 * x is the column, z the row, y up.
 */

export const WALL_HEIGHT = 1.5;
/** The lower edge of a lintel: a door is a gap in the wall up to here. */
export const DOOR_HEIGHT = 1.3;
/** The camera of the user «Tu», at the height of the eyes of a character. */
export const EYE_HEIGHT = 1.05;
/**
 * A character standing: a sprite of a 16×32 frame, half as wide as it is
 * tall; the figure fills about three quarters of the frame, so a person is
 * about 1.1 tiles tall, under the walls.
 */
export const SPRITE_HEIGHT = 1.45;
export const SPRITE_WIDTH = SPRITE_HEIGHT / 2;
/** The handrail of the Sacro Cuore, halfway up its walls. */
const RAIL_HEIGHT = 0.62;
/** The hazard stripe of the power plant of Springfield (D-237), low on its walls. */
const STRIPE_HEIGHT = 0.42;
/** The skirting line at the foot of the walls. */
const SKIRTING = 0.1;
/** How far a desk's screen sits to the side of the seat. */
const MONITOR_SIDE = 0.32;
/** The farthest a name tag shows, in tiles. */
export const TAG_DISTANCE = 12;

/** A fixed colour of a thing (the decorations of the feasts, D-252): the same in light and dark. */
export type Ink = `#${string}`;

/** A box of the world: its centre on the floor (x, z), its size, from height y up by h. */
export interface Block {
  x: number;
  z: number;
  w: number;
  d: number;
  y: number;
  h: number;
  color: ColorName | Ink;
}

export interface FloorTile {
  c: number;
  r: number;
  alt: boolean;
}

/** The screen of a desk, turned on when someone works at the seat `key` ("c,r"), as in the 2D view. */
export interface Monitor {
  key: string;
  x: number;
  z: number;
  /** +1 the screen faces south (+z), -1 north. */
  facing: 1 | -1;
}

export interface World {
  width: number;
  depth: number;
  floors: FloorTile[];
  blocks: Block[];
  monitors: Monitor[];
  /** Where the bell of the Decisioni desk is, for the «!» that waits for the user. */
  bell: { x: number; z: number; y: number };
}

const SIDES: readonly { dc: number; dr: number }[] = [
  { dc: 0, dr: 1 },
  { dc: 0, dr: -1 },
  { dc: 1, dr: 0 },
  { dc: -1, dr: 0 },
];

/** The side of a tile that looks onto the floor (south first): where a panel on a wall hangs, where a sofa opens. */
export function openSide(map: Pick<OfficeMap, 'width' | 'height' | 'tiles'>, c: number, r: number): { dc: number; dr: number } | null {
  return SIDES.find(({ dc, dr }) => isWalkable(map, c + dc, r + dr)) ?? null;
}

const box = (x: number, z: number, w: number, d: number, y: number, h: number, color: ColorName | Ink): Block => ({ x, z, w, d, y, h, color });

/** A thin panel on the face of the wall tile (c, r) towards `side`, from y up by h. */
function panel(c: number, r: number, side: { dc: number; dr: number }, inset: number, y: number, h: number, color: ColorName): Block {
  const depth = 0.06;
  const x = c + 0.5 + side.dc * (0.5 + depth / 2);
  const z = r + 0.5 + side.dr * (0.5 + depth / 2);
  const along = 1 - inset * 2;
  return side.dc === 0 ? box(x, z, along, depth, y, h, color) : box(x, z, depth, along, y, h, color);
}

/** A note pinned on a panel: `offset` from the middle of the tile along the wall, a little in front of the sheet. */
function note(c: number, r: number, side: { dc: number; dr: number }, offset: number, width: number, y: number, h: number, color: ColorName): Block {
  // In front of the sheet of `panel` (0.06 from the wall): from 0.05 to 0.09.
  const depth = 0.04;
  const x = c + 0.5 + side.dc * 0.57 + (side.dc === 0 ? offset : 0);
  const z = r + 0.5 + side.dr * 0.57 + (side.dc === 0 ? 0 : offset);
  return side.dc === 0 ? box(x, z, width, depth, y, h, color) : box(x, z, depth, width, y, h, color);
}

/** The colours of the notes on the cardwall, as the 2D view draws them: a drawing, never the cards. */
const NOTES: readonly ColorName[] = ['accent', 'warn', 'info', 'ok', 'danger'];

/** A cabinet of the house of the Smiths in 3D (D-239), as lib/office/langley.ts chooses it for the 2D view. */
function langleyCabinet3d(map: OfficeMap, c: number, r: number, x: number, z: number): Block[] {
  switch (langleyCabinet(map, c, r)) {
    case 'bowl':
      return [box(x, z, 0.6, 0.6, 0, 0.55, 'desk'), box(x, z, 0.42, 0.42, 0.55, 0.36, 'window-light')];
    case 'tv':
      return [box(x, z, 0.9, 0.6, 0, 0.4, 'desk'), box(x, z, 0.8, 0.3, 0.4, 0.55, 'monitor')];
    case 'files':
      return [box(x, z, 0.9, 0.7, 0, 1.05, 'counter'), box(x, z, 0.92, 0.72, 1.05, 0.04, 'counter-top')];
  }
}

/** The blocks of a tile that is not floor. */
function tileBlocks(map: OfficeMap, kind: TileKind, c: number, r: number, skin: OfficeSkin): Block[] {
  const x = c + 0.5;
  const z = r + 0.5;
  const side = openSide(map, c, r);
  switch (kind) {
    case 'floor':
      return [];
    case 'door':
      return [box(x, z, 1, 1, DOOR_HEIGHT, WALL_HEIGHT - DOOR_HEIGHT, 'wall-face')];
    case 'wall':
    case 'window':
    case 'shelf':
    case 'board':
      return [];
    case 'desk':
      return [box(x, z, 1, 0.9, 0.42, 0.06, 'desk-top'), box(x, z, 0.92, 0.8, 0, 0.42, 'desk')];
    case 'counter':
      return [box(x, z, 1, 1, 0.55, 0.07, 'counter-top'), box(x, z, 1, 0.9, 0, 0.55, 'counter')];
    case 'sofa': {
      // The back on the side away from the floor; with the Sacro Cuore a bed: white sheet, blue blanket (the palette's sofa colours).
      const back = side === null ? { dc: 0, dr: -1 } : { dc: -side.dc, dr: -side.dr };
      const backBlock = back.dc === 0 ? box(x, z + back.dr * 0.4, 1, 0.2, 0, 0.62, 'sofa-dark') : box(x + back.dc * 0.4, z, 0.2, 1, 0, 0.62, 'sofa-dark');
      return [box(x, z, 1, 1, 0, 0.3, 'sofa'), backBlock];
    }
    case 'coffee':
      // The power plant (D-237): a cabinet with the box of doughnuts on top.
      if (skin === 'springfield') return [box(x, z, 0.8, 0.6, 0, 0.8, 'counter'), box(x, z, 0.7, 0.5, 0.8, 0.12, 'paper')];
      // The television of the Griffin house on its low cabinet (D-238).
      if (skin === 'quahog') return [box(x, z, 0.8, 0.5, 0, 0.45, 'desk'), box(x, z, 0.7, 0.5, 0.45, 0.5, 'monitor'), box(x, z, 0.5, 0.52, 0.52, 0.36, 'screen')];
      // The fridge of the Smiths (D-239): tall and white, a line between its two doors.
      if (skin === 'langley') return [box(x, z, 0.72, 0.62, 0, 1.3, 'paper'), box(x, z, 0.74, 0.64, 0.85, 0.03, 'desk-shadow')];
      // The payphone of the penitentiary (D-240).
      if (skin === 'fox-river') return foxRiverPhone3d(x, z);
      // The transport tube of the Planet Express (D-242).
      if (skin === 'planet-express') return planetExpressTube3d(x, z);
      // The broken lift of Pasadena (D-243).
      if (skin === 'pasadena') return pasadenaLift3d(x, z);
      return skin === 'ufficio'
        ? [box(x, z, 0.5, 0.5, 0, 0.9, 'paper'), box(x, z, 0.36, 0.36, 0.9, 0.34, 'window-light')]
        : [box(x, z, 0.7, 0.6, 0, 1.0, 'monitor'), box(x, z, 0.5, 0.62, 0.55, 0.3, 'screen')];
    case 'plant':
      return [box(x, z, 0.4, 0.4, 0, 0.32, 'pot'), box(x, z, 0.62, 0.62, 0.32, 0.45, 'plant'), box(x, z, 0.4, 0.4, 0.77, 0.25, 'plant-dark')];
    case 'cabinet':
      // The power plant (D-237): a yellow barrel with its glowing rod.
      if (skin === 'springfield') return [box(x, z, 0.6, 0.6, 0, 0.9, 'warn'), box(x, z, 0.14, 0.14, 0.9, 0.3, 'ok')];
      // The house of the Smiths (D-239): Klaus's bowl on its little table, the television, the files of the CIA.
      if (skin === 'langley') return langleyCabinet3d(map, c, r, x, z);
      // The crates and the ship parked in the hall of the Planet Express (D-242).
      if (skin === 'planet-express') return planetExpressCabinet3d(map, c, r, x, z);
      // The bookcases of comics of Pasadena (D-243).
      if (skin === 'pasadena') return pasadenaBookcase3d(x, z);
      return [box(x, z, 0.9, 0.7, 0, 1.05, skin === 'corsia' || skin === 'fox-river' ? 'counter' : 'desk'), box(x, z, 0.92, 0.72, 1.05, 0.04, 'desk-top')];
  }
}

/** The panels a wall tile wears on the side of the floor: the window's glass, the shelf's books, the cardwall's sheet. */
function wallFace(map: OfficeMap, kind: TileKind, c: number, r: number): Block[] {
  const side = openSide(map, c, r);
  if (side === null) return [];
  switch (kind) {
    case 'window':
      return [panel(c, r, side, 0.1, 0.55, 0.65, 'window'), panel(c, r, side, 0.25, 0.65, 0.45, 'window-light')];
    case 'shelf':
      return [panel(c, r, side, 0.04, 0.05, 1.15, 'desk'), panel(c, r, side, 0.1, 0.5, 0.06, 'desk-top'), panel(c, r, side, 0.1, 0.85, 0.06, 'desk-top')];
    case 'board': {
      // A sheet with two columns of notes per tile, 1 to 3 each, fixed as in 2D (lib/office/draw.ts).
      const blocks = [panel(c, r, side, 0.02, 0.5, 0.75, 'paper')];
      for (let k = 0; k < 2; k++) {
        const column = c * 2 + k;
        const count = 1 + ((column * 5 + c) % 3);
        for (let j = 0; j < count; j++) blocks.push(note(c, r, side, k === 0 ? -0.24 : 0.24, 0.38, 1.04 - j * 0.17, 0.12, NOTES[(column + j * 2) % NOTES.length] ?? 'accent'));
      }
      return blocks;
    }
    default:
      return [];
  }
}

/** The walls of a row, joined into runs: one box from the first wall tile to the last, whatever it wears. */
function wallRuns(map: OfficeMap, skin: OfficeSkin): Block[] {
  const runs: Block[] = [];
  for (let r = 0; r < map.height; r++) {
    let start = -1;
    for (let c = 0; c <= map.width; c++) {
      const wall = c < map.width && isWall(tileAt(map, c, r));
      if (wall && start < 0) start = c;
      if (!wall && start >= 0) {
        const w = c - start;
        // The face, a skirting line along the floor (the wall's line of the 2D view) and the top, darker as in 2D.
        runs.push(
          box(start + w / 2, r + 0.5, w, 1, 0, WALL_HEIGHT, 'wall-face'),
          box(start + w / 2, r + 0.5, w + 0.02, 1.02, 0, SKIRTING, 'wall-line'),
          box(start + w / 2, r + 0.5, w, 1, WALL_HEIGHT, 0.04, 'wall-top'),
        );
        // The Sacro Cuore's handrail halfway up the wall (D-216).
        if (skin === 'corsia') runs.push(box(start + w / 2, r + 0.5, w + 0.06, 1.06, RAIL_HEIGHT, 0.06, 'wall-line'));
        // The hazard stripe of the power plant of Springfield (D-237), in the yellow of the theme.
        if (skin === 'springfield') runs.push(box(start + w / 2, r + 0.5, w + 0.04, 1.04, STRIPE_HEIGHT, 0.08, 'warn'));
        start = -1;
      }
    }
  }
  return runs;
}

const ink = (value: string): Ink => value as Ink;
const K = FEAST_INK;

/** The thing of the feast standing on a plant tile in 3D (D-252), as lib/office/feasts.ts draws it in 2D. */
export function feastProp3d(prop: FeastProp, x: number, z: number): Block[] {
  switch (prop) {
    case 'tree':
      return [
        box(x, z, 0.36, 0.36, 0, 0.2, ink(K.potRed)),
        box(x, z, 0.1, 0.1, 0.2, 0.12, ink(K.trunk)),
        box(x, z, 0.8, 0.8, 0.32, 0.28, ink(K.green)),
        box(x, z, 0.6, 0.6, 0.6, 0.26, ink(K.greenDark)),
        box(x, z, 0.4, 0.4, 0.86, 0.22, ink(K.green)),
        box(x, z, 0.2, 0.2, 1.08, 0.16, ink(K.greenDark)),
        box(x, z, 0.12, 0.12, 1.24, 0.12, ink(K.gold)),
        box(x - 0.36, z + 0.2, 0.08, 0.08, 0.4, 0.08, ink(K.red)),
        box(x + 0.3, z - 0.1, 0.08, 0.08, 0.66, 0.08, ink(K.blue)),
        box(x + 0.1, z + 0.22, 0.08, 0.08, 0.9, 0.08, ink(K.gold)),
      ];
    case 'pumpkin':
      return [
        box(x, z, 0.56, 0.5, 0, 0.4, ink(K.orange)),
        box(x, z, 0.1, 0.1, 0.4, 0.1, ink(K.stem)),
        box(x - 0.12, z + 0.25, 0.1, 0.02, 0.24, 0.08, ink(K.glow)),
        box(x + 0.12, z + 0.25, 0.1, 0.02, 0.24, 0.08, ink(K.glow)),
        box(x, z + 0.25, 0.3, 0.02, 0.08, 0.06, ink(K.glow)),
      ];
    case 'mask':
      return [
        box(x, z, 0.3, 0.3, 0, 0.04, ink(K.stand)),
        box(x, z, 0.05, 0.05, 0.04, 0.86, ink(K.stand)),
        box(x, z, 0.46, 0.06, 0.88, 0.18, ink(K.gold)),
        box(x - 0.1, z + 0.035, 0.1, 0.01, 0.94, 0.06, ink(K.eyes)),
        box(x + 0.1, z + 0.035, 0.1, 0.01, 0.94, 0.06, ink(K.eyes)),
        box(x + 0.2, z, 0.05, 0.05, 1.06, 0.26, ink(K.purple)),
      ];
    case 'basket':
      return [
        box(x, z, 0.6, 0.45, 0, 0.24, ink(K.wicker)),
        box(x - 0.15, z, 0.12, 0.12, 0.24, 0.15, ink(K.pastel[0])),
        box(x, z, 0.12, 0.12, 0.24, 0.17, ink(K.pastel[1])),
        box(x + 0.15, z, 0.12, 0.12, 0.24, 0.15, ink(K.pastel[2])),
        box(x - 0.27, z, 0.04, 0.04, 0.24, 0.3, ink(K.wickerDark)),
        box(x + 0.27, z, 0.04, 0.04, 0.24, 0.3, ink(K.wickerDark)),
        box(x, z, 0.58, 0.04, 0.54, 0.04, ink(K.wickerDark)),
      ];
    case 'umbrella':
      return [
        box(x, z, 0.5, 0.5, 0, 0.03, ink(K.gold)),
        box(x, z, 0.05, 0.05, 0.03, 1.27, ink(K.trunk)),
        box(x, z, 1, 1, 1.3, 0.05, ink(K.red)),
        box(x, z, 0.7, 0.7, 1.35, 0.05, ink(K.white)),
        box(x, z, 0.36, 0.36, 1.4, 0.05, ink(K.red)),
      ];
    case 'gold':
      return [
        box(x, z, 0.5, 0.5, 0, 0.3, ink(K.iron)),
        box(x, z, 0.42, 0.42, 0.3, 0.05, ink(K.gold)),
        box(x, z, 0.04, 0.04, 0.35, 0.4, ink(K.stem)),
        box(x - 0.1, z, 0.16, 0.06, 0.72, 0.16, ink(K.green)),
        box(x + 0.1, z, 0.16, 0.06, 0.72, 0.16, ink(K.green)),
        box(x, z, 0.16, 0.06, 0.86, 0.16, ink(K.greenDark)),
      ];
  }
}

/** A small box on the south face of the wall tile (c, r): `offset` from the middle along the wall. */
function onFace(c: number, r: number, offset: number, width: number, y: number, h: number, color: Ink): Block {
  return box(c + 0.5 + offset, r + 1.03, width, 0.06, y, h, color);
}

/** The decorations of the feast in 3D (D-252): the garland on the faces, the small things on the floor. */
function feastBlocks(decor: FeastDecor): Block[] {
  const style = FEAST_STYLE[decor.feast];
  const blocks: Block[] = [];
  const colors = decor.feast === 'san-patrizio' ? K.irish : decor.feast === 'pasqua' ? K.pastel : K.bright;
  for (const face of decor.faces) {
    const { c, r } = face;
    switch (style.garland) {
      case 'lights':
        blocks.push(onFace(c, r, 0, 1, 1.4, 0.02, ink(K.wire)));
        for (let i = 0; i < 3; i++) blocks.push(onFace(c, r, -0.32 + i * 0.32, 0.08, 1.3, 0.08, ink(colors[(c * 3 + i) % colors.length] ?? K.gold)));
        break;
      case 'bunting':
        blocks.push(onFace(c, r, 0, 1, 1.4, 0.02, ink(K.iron)));
        for (let i = 0; i < 2; i++) {
          const color = ink(colors[(c * 2 + i) % colors.length] ?? K.gold);
          blocks.push(onFace(c, r, -0.25 + i * 0.5, 0.3, 1.32, 0.08, color), onFace(c, r, -0.25 + i * 0.5, 0.12, 1.24, 0.08, color));
        }
        break;
      case 'streamers':
        blocks.push(onFace(c, r, 0, 1, 1.38, 0.04, ink(c % 2 === 0 ? K.bright[0] : K.bright[2])), onFace(c, r, 0, 1, 1.28, 0.04, ink(c % 2 === 0 ? K.bright[1] : K.bright[3])));
        break;
      case 'webs':
        for (const [end, sign] of [[face.first, -1], [face.last, 1]] as const) {
          if (!end) continue;
          for (let i = 0; i < 3; i++) blocks.push(onFace(c, r, sign * (0.5 - (0.3 - i * 0.1) / 2), 0.3 - i * 0.1, 1.44 - i * 0.07, 0.03, ink(K.white)));
        }
        break;
      case null:
        break;
    }
  }
  for (const speck of decor.specks) {
    const x = speck.c + (speck.dx + 1) / TILE;
    const z = speck.r + (speck.dy + 1) / TILE;
    switch (style.scatter) {
      case 'confetti':
        blocks.push(box(x, z, 0.07, 0.05, 0, 0.01, ink(K.bright[speck.tone % K.bright.length] ?? K.red)));
        break;
      case 'clover':
        blocks.push(box(x, z, 0.14, 0.14, 0, 0.02, ink(K.green)));
        break;
      case 'egg':
        blocks.push(box(x, z, 0.1, 0.13, 0, 0.1, ink(K.pastel[speck.tone % K.pastel.length] ?? K.gold)));
        break;
      case 'ball':
        blocks.push(box(x, z, 0.18, 0.18, 0, 0.18, ink(K.red)), box(x, z, 0.19, 0.19, 0.07, 0.04, ink(K.white)));
        break;
      case null:
        break;
    }
  }
  return blocks;
}

/**
 * From the map to the world: floor under every tile that is not a wall,
 * walls, lintels, furniture, screens; with a feast (D-252) its decorations,
 * its thing in place of every other plant.
 */
export function buildWorld(map: OfficeMap, skin: OfficeSkin, decor: FeastDecor | null = null): World {
  const floors: FloorTile[] = [];
  const blocks: Block[] = wallRuns(map, skin);
  const props = new Set(decor === null ? [] : decor.props.map(([c, r]) => `${String(c)},${String(r)}`));
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const kind = tileAt(map, c, r);
      if (kind === undefined) continue;
      if (isWall(kind)) {
        blocks.push(...wallFace(map, kind, c, r));
        // The bars of the windows of the penitentiary (D-240).
        const side = skin === 'fox-river' && kind === 'window' ? openSide(map, c, r) : null;
        if (side !== null) blocks.push(...foxRiverBars3d(c, r, side));
        continue;
      }
      // A checked floor for Base, as in 2D; the tiles of the Sacro Cuore and the carpet of the Dunder Mifflin are one colour.
      floors.push({ c, r, alt: skin === 'base' && (c + r) % 2 === 1 });
      if (decor !== null && kind === 'plant' && props.has(`${String(c)},${String(r)}`)) blocks.push(...feastProp3d(FEAST_STYLE[decor.feast].prop, c + 0.5, r + 0.5));
      else blocks.push(...tileBlocks(map, kind, c, r, skin));
    }
  }
  if (decor !== null) blocks.push(...feastBlocks(decor));
  const { anchors } = map;
  const monitors: Monitor[] = [];
  for (const island of [anchors.private, ...anchors.islands]) {
    const [sc, sr] = island.seat;
    // Beside the face of who sits there, not in front of it: from across the desk the user sees the agent.
    if (tileAt(map, sc, sr + 1) === 'desk') monitors.push({ key: `${String(sc)},${String(sr)}`, x: sc + 0.5 + MONITOR_SIDE, z: sr + 1.3, facing: -1 });
    else if (tileAt(map, sc, sr - 1) === 'desk') monitors.push({ key: `${String(sc)},${String(sr)}`, x: sc + 0.5 + MONITOR_SIDE, z: sr - 0.3, facing: 1 });
  }
  const desk = anchors.decisions.desk;
  return { width: map.width, depth: map.height, floors, blocks, monitors, bell: { x: desk[0] + desk[2] / 2, z: desk[1] + 0.5, y: 1.05 } };
}

/** A point of the map in pixels (a walker's feet) to the floor of the world: the middle of the box of its feet (lib/office/path.ts). */
export function toWorld(at: Point): { x: number; z: number } {
  return { x: at[0] / TILE, z: (at[1] - 3) / TILE };
}

/** A point of the floor of the world back to pixels of the map, as a click on the 2D canvas would give. */
export function toMap(x: number, z: number): Point {
  return [x * TILE, z * TILE];
}

/**
 * Where an agent stands in the world: seated, in the middle of its seat (in
 * 2D the drawing moves the feet behind the desk, here the desk is a block);
 * on the last step onto the seat, already there, so the sprite never jumps.
 */
export function standPoint(actor: Pick<Actor, 'x' | 'y' | 'walking' | 'path' | 'seat'>): { x: number; z: number } {
  if (!actor.walking || actor.path.length <= 1) return { x: actor.seat[0] + 0.5, z: actor.seat[1] + 0.5 };
  return toWorld([actor.x, actor.y]);
}

/** How far into a thing a click goes from the point it hit: past the sheet and the notes of the cardwall (0.09 out of its wall). */
export const PICK_DEPTH = 0.12;

/**
 * Where on the plan a click in 3D lands, from the point it hit and the normal
 * of the face (world units): on the floor, there; on a thing (a wall, its
 * panel, a desk, a cabinet), a little inside it, so the same rules as a click
 * on the 2D canvas find the cardwall, the archive or the Decisioni desk.
 */
export function pickedTile(point: { x: number; y: number; z: number }, normal: { x: number; z: number } | null): { x: number; z: number } {
  if (point.y <= 0.01 || normal === null) return { x: point.x, z: point.z };
  return { x: point.x - normal.x * PICK_DEPTH, z: point.z - normal.z * PICK_DEPTH };
}

/** The keys of the 3D view: forward and back, a step sideways, and turning with ← →. */
export interface WalkKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
}

/**
 * The direction of a step on the map (pixels: x right, y down) for the keys
 * held and where the camera looks: `yaw` 0 looks up the map (north), growing
 * to the left as three.js turns a camera. [0, 0] with nothing held or with
 * opposite keys.
 */
export function walkVector(keys: WalkKeys, yaw: number): Point {
  const ahead = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const side = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  if (ahead === 0 && side === 0) return [0, 0];
  const fx = -Math.sin(yaw);
  const fy = -Math.cos(yaw);
  // Right of where the camera looks: forward turned a quarter clockwise on the map.
  const rx = -fy;
  const ry = fx;
  const vx = fx * ahead + rx * side;
  const vy = fy * ahead + ry * side;
  return [Math.abs(vx) < 1e-9 ? 0 : vx, Math.abs(vy) < 1e-9 ? 0 : vy];
}

/** The facing of the map closest to where the camera looks: the 2D view shows the user turned that way. */
export function facingOfYaw(yaw: number): Facing {
  const [vx, vy] = walkVector({ forward: true, back: false, left: false, right: false }, yaw);
  return Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : vy > 0 ? 'down' : 'up';
}

/** The yaw that looks from `from` towards `to` (points of the world). */
export function yawTowards(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

const DIRECTION: Readonly<Record<Facing, { x: number; z: number }>> = {
  down: { x: 0, z: 1 },
  up: { x: 0, z: -1 },
  right: { x: 1, z: 0 },
  left: { x: -1, z: 0 },
};

/**
 * Which side of a character the camera sees: a sprite always faces the
 * camera, so the row of its sheet says where the character looks. Its face
 * ("down", the front row) when it looks towards the camera, its back ("up")
 * when it looks away, else its side, mirrored as the 2D view mirrors "left".
 */
export function viewFacing(facing: Facing, at: { x: number; z: number }, camera: { x: number; z: number }): Facing {
  const tx = camera.x - at.x;
  const tz = camera.z - at.z;
  const length = Math.hypot(tx, tz);
  if (length < 1e-6) return 'down';
  const look = DIRECTION[facing];
  const towards = (look.x * tx + look.z * tz) / length;
  if (towards > Math.SQRT1_2) return 'down';
  if (towards < -Math.SQRT1_2) return 'up';
  // Looking to the camera's right or left: the cross product says which.
  const cross = look.x * tz - look.z * tx;
  return cross > 0 ? 'right' : 'left';
}

/**
 * Whether the user sees a point of the world from another, over the plan: no
 * wall tile on the line between them (doors are open). Name tags show only
 * for who is in sight, never through a wall.
 */
export function inSight(map: Pick<OfficeMap, 'width' | 'height' | 'tiles'>, from: { x: number; z: number }, to: { x: number; z: number }): boolean {
  const steps = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) * 4);
  for (let index = 1; index < steps; index++) {
    const t = index / steps;
    const kind = tileAt(map, Math.floor(from.x + (to.x - from.x) * t), Math.floor(from.z + (to.z - from.z) * t));
    if (isWall(kind)) return false;
  }
  return true;
}

/** The area the user is in, as in the tags of the 2D view: the project of a room and its label, Privata, Pausa…; null in the corridor. */
export function areaAt(map: Pick<OfficeMap, 'anchors'>, snapshot: Pick<OfficeSnapshot, 'islands' | 'archived' | 'unnamed'>, tile: Point): { text: string; label: Label | null } | null {
  const { anchors } = map;
  const within = (room: Room): boolean => inRoom(room, tile[0], tile[1]);
  if (within(anchors.private.room)) return { text: 'Privata', label: 'L2' };
  const slot = anchors.islands.findIndex((island) => within(island.room));
  if (slot >= 0) {
    const project = snapshot.islands.find((item) => item.slot === slot);
    return project === undefined ? { text: 'Stanza libera', label: null } : { text: islandName(project.project), label: project.label };
  }
  if (within(anchors.pause.room)) return { text: 'Pausa', label: null };
  if (within(anchors.decisions.room)) return { text: 'Decisioni', label: null };
  if (within(anchors.archive.room)) {
    const archived = archiveCount(snapshot);
    return { text: archived > 0 ? `Archivio · ${String(archived)}` : 'Archivio', label: null };
  }
  return null;
}

/** The view of the office (D-230): the 2D plan by default; the 3D view is a choice of this browser. */
export type OfficeViewMode = '2d' | '3d';

const VIEW_KEY = 'arianna.office.view';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What this browser chose; anything else, a missing or refusing storage, is the 2D view. */
export function loadViewMode(storage: StorageLike | undefined): OfficeViewMode {
  try {
    return storage?.getItem(VIEW_KEY) === '3d' ? '3d' : '2d';
  } catch {
    return '2d';
  }
}

export function saveViewMode(storage: StorageLike | undefined, mode: OfficeViewMode): void {
  try {
    storage?.setItem(VIEW_KEY, mode);
  } catch {
    // A convenience of this browser: without storage the choice lasts until the page closes.
  }
}
