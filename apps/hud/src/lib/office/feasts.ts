import type { Colors } from './draw.ts';
import { isWall, tileAt, TILE, type OfficeMap, type Point } from './map.ts';

/**
 * The decorations of the feasts in the office (D-252, stage 7 of D-106): when
 * the theme in use is one of the six feasts of D-246 (the feast of the day in
 * place of Base, or a feast chosen by hand), the office wears its things:
 * Christmas trees and fairy lights, pumpkins and cobwebs, carnival masks,
 * streamers and confetti, Easter baskets, bunting and eggs, beach umbrellas
 * and balls, pots of gold with shamrocks. Which feast it is comes from the
 * theme the core chose (`activeTheme` of lib/themes.ts): nothing is worked out
 * again here. Every drawing is code, original pixel art and simple boxes for
 * the 3D view; nothing is downloaded. Without a feast the office is as it was,
 * pixel for pixel.
 */
export const OFFICE_FEASTS = ['natale', 'san-patrizio', 'halloween', 'carnevale', 'estate', 'pasqua'] as const;
export type OfficeFeast = (typeof OFFICE_FEASTS)[number];

/** The feast of the theme in use: one of the six seasonal themes, never a theme of the series nor Base. */
export function officeFeast(theme: { id: string; kind: string } | undefined): OfficeFeast | null {
  if (theme?.kind !== 'stagionale') return null;
  return OFFICE_FEASTS.find((feast) => feast === theme.id) ?? null;
}

export type FeastProp = 'tree' | 'pumpkin' | 'mask' | 'basket' | 'umbrella' | 'gold';
export type FeastGarland = 'lights' | 'webs' | 'streamers' | 'bunting' | null;
export type FeastScatter = 'confetti' | 'clover' | 'egg' | 'ball' | null;

/** What each feast puts in the office: a thing in place of every other plant, something on the walls, something on the floor. */
export const FEAST_STYLE: Readonly<Record<OfficeFeast, { prop: FeastProp; garland: FeastGarland; scatter: FeastScatter; every: number; specks: number }>> = {
  natale: { prop: 'tree', garland: 'lights', scatter: null, every: 0, specks: 0 },
  halloween: { prop: 'pumpkin', garland: 'webs', scatter: null, every: 0, specks: 0 },
  carnevale: { prop: 'mask', garland: 'streamers', scatter: 'confetti', every: 2, specks: 3 },
  pasqua: { prop: 'basket', garland: 'bunting', scatter: 'egg', every: 11, specks: 1 },
  estate: { prop: 'umbrella', garland: null, scatter: 'ball', every: 13, specks: 1 },
  'san-patrizio': { prop: 'gold', garland: 'bunting', scatter: 'clover', every: 9, specks: 1 },
};

/** A wall face over the floor that holds the garland; `first`/`last` where the run of faces begins or ends (a corner). */
export interface FeastFace {
  c: number;
  r: number;
  first: boolean;
  last: boolean;
}

/** A small thing on the floor: its tile, where inside it (pixels), which of the feast's colours. */
export interface FeastSpeck {
  c: number;
  r: number;
  dx: number;
  dy: number;
  tone: number;
}

export interface FeastDecor {
  feast: OfficeFeast;
  /** Plant tiles that hold the feast's thing instead of the plant (every other one, from the first). */
  props: Point[];
  /** The same tiles as keys "c,r", worked out once for the drawing of every frame. */
  propKeys: ReadonlySet<string>;
  /** Wall faces with the garland (none for a feast without one): walls, windows and shelves, never the cardwall. */
  faces: FeastFace[];
  specks: FeastSpeck[];
}

/** A wall tile drawn as a face: the floor (or furniture) below it, as draw.ts decides. */
function isFace(map: OfficeMap, c: number, r: number): boolean {
  const kind = tileAt(map, c, r);
  const below = tileAt(map, c, r + 1);
  return isWall(kind) && kind !== 'board' && below !== undefined && !isWall(below);
}

/** A fixed scramble of a tile and a number: the same tile always gets the same specks, spread without rows or columns. */
function mix(c: number, r: number, i: number): number {
  let h = Math.imul(c + 1, 0x9e3779b1) ^ Math.imul(r + 1, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 13)) >>> 0;
}

/** Where the decorations of `feast` go on `map`: a pure, fixed choice, the same at every frame and in 2D and 3D. */
export function feastDecor(map: OfficeMap, feast: OfficeFeast): FeastDecor {
  const style = FEAST_STYLE[feast];
  const props: Point[] = [];
  const faces: FeastFace[] = [];
  const specks: FeastSpeck[] = [];
  let plants = 0;
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const kind = tileAt(map, c, r);
      if (kind === 'plant') {
        if (plants % 2 === 0) props.push([c, r]);
        plants++;
      }
      if (style.garland !== null && isFace(map, c, r)) faces.push({ c, r, first: !isFace(map, c - 1, r), last: !isFace(map, c + 1, r) });
      if (style.scatter !== null && kind === 'floor' && mix(c, r, 0) % style.every === 0) {
        for (let i = 0; i < style.specks; i++) {
          const seed = mix(c, r, i + 1);
          specks.push({ c, r, dx: 2 + (seed % 11), dy: 2 + (Math.floor(seed / 11) % 11), tone: Math.floor(seed / 121) % 4 });
        }
      }
    }
  }
  return { feast, props, propKeys: new Set(props.map(([c, r]) => `${String(c)},${String(r)}`)), faces, specks };
}

/** A fixed colour of a thing: the same in light and dark, never from the theme (the 3D view takes it as it is). */
export type Ink = `#${string}`;

/** Fixed colours of the decorations, the same in light and dark: they are things, not the page. */
export const FEAST_INK = {
  green: '#2f8f4e',
  greenDark: '#1f6b38',
  gold: '#f2c94c',
  red: '#d94a3d',
  blue: '#4f8fe0',
  trunk: '#7a4a2a',
  potRed: '#b0413a',
  potRedDark: '#7d2a25',
  wire: '#2a4a2a',
  orange: '#e8742a',
  orangeDark: '#b4521a',
  glow: '#ffd25a',
  stem: '#4f7a2a',
  purple: '#9b59c6',
  eyes: '#2b1a3a',
  stand: '#6b4a2a',
  wicker: '#c8914a',
  wickerDark: '#9a6a30',
  white: '#f4f1e8',
  iron: '#55555f',
  ironLight: '#8a8a96',
  /** Lights, streamers and confetti. */
  bright: ['#d94a3d', '#f2c94c', '#4f8fe0', '#7fd19a'],
  /** Eggs and the bunting of Easter. */
  pastel: ['#f2a7c3', '#8fc6ef', '#f5d76e', '#9ed99a'],
  /** The bunting of Saint Patrick: green, white, orange as the flag, and gold. */
  irish: ['#2f9e5b', '#f4f1e8', '#f08a2c', '#f2c94c'],
} as const satisfies Record<string, Ink | readonly Ink[]>;

const K = FEAST_INK;

type Rect = (color: string, x: number, y: number, w: number, h: number) => void;

function pixels(rect: Rect, lines: readonly string[], x: number, y: number, palette: Readonly<Record<string, string>>): void {
  lines.forEach((line, j) => {
    for (let i = 0; i < line.length; i++) {
      const color = palette[line.charAt(i)];
      if (color !== undefined) rect(color, x + i, y + j, 1, 1);
    }
  });
}

const TREE = [
  '.....y.....',
  '....yyy....',
  '.....g.....',
  '....ggg....',
  '...ggrgg...',
  '....ggg....',
  '...gggGg...',
  '..ggbgggg..',
  '...gggGg...',
  '..gggggyg..',
  '.ggrggGggg.',
  '..ggggggg..',
  '.gggGgggbg.',
  'gggggggrggg',
  '.....t.....',
  '....ttt....',
  '...ppppp...',
  '...pPPPp...',
  '....ppp....',
];
const PUMPKIN = [
  '.....s.....',
  '..oooOooo..',
  '.ooOoOoOoo.',
  'ooyyoOoyyoo',
  'ooOoOyOoOoo',
  'oyyyyyyyyyo',
  'ooyoyoyoyoo',
  '.ooOoOoOoo.',
  '..ooooooo..',
];
const MASK = [
  '........pp.',
  '.......pp..',
  '.yyyyyyyp..',
  'yykkyyykkyy',
  'yykkyyykkyy',
  '.yyyyyyyyy.',
  '..yy.y.yy..',
  '.....s.....',
  '.....s.....',
  '.....s.....',
  '.....s.....',
  '....sss....',
  '...sssss...',
];
const BASKET = [
  '...hhhhh...',
  '..h.....h..',
  '.h.......h.',
  '.hp.bb.yyh.',
  '.pppbbbyyy.',
  'hhhhhhhhhhh',
  'hHhHhHhHhHh',
  '.hHhHhHhHh.',
  '..hhhhhhh..',
];
const GOLD = [
  '....ggg....',
  '...gGggg...',
  '...ggggg...',
  '.gg.ggg.gg.',
  'gGgg.g.gGgg',
  'ggggg.ggggg',
  '.ggg.s.ggg.',
  '...yYyYy...',
  '..yyYyyYy..',
  '.KKKKKKKKK.',
  '.kKkkkkkKk.',
  '.kkkkkkkkk.',
  '..kkkkkkk..',
];
/** Plain ASCII, so it is split by characters safely when mirrored. */
const WEB = ['xxxxxxx', 'xx..x.x', 'x.x.xx.', 'x.xxx..', 'xxx.x..', 'x.x....', 'xx.....', 'x......'];

/** The thing of the feast standing on a plant tile (x, y its top left corner), its foot where the pot of the plant is. */
export function feastProp(rect: Rect, prop: FeastProp, x: number, y: number): void {
  switch (prop) {
    case 'tree':
      pixels(rect, TREE, x + 2, y - 5, { y: K.gold, g: K.green, G: K.greenDark, r: K.red, b: K.blue, t: K.trunk, p: K.potRed, P: K.potRedDark });
      return;
    case 'pumpkin':
      pixels(rect, PUMPKIN, x + 2, y + 5, { o: K.orange, O: K.orangeDark, y: K.glow, s: K.stem });
      return;
    case 'mask':
      pixels(rect, MASK, x + 2, y + 1, { y: K.gold, k: K.eyes, p: K.purple, s: K.stand });
      return;
    case 'basket':
      pixels(rect, BASKET, x + 2, y + 5, { h: K.wicker, H: K.wickerDark, p: K.pastel[0], b: K.pastel[1], y: K.pastel[2] });
      return;
    case 'gold':
      pixels(rect, GOLD, x + 2, y + 1, { g: K.green, G: K.greenDark, s: K.stem, y: K.gold, Y: K.glow, k: K.iron, K: K.ironLight });
      return;
    case 'umbrella': {
      // The canopy in red and white stripes, wider than the tile, over its pole and a little sand.
      const widths = [3, 7, 11, 13];
      widths.forEach((w, row) => {
        for (let i = 0; i < w; i++) {
          const col = (13 - w) / 2 + i;
          rect(Math.floor(col / 2) % 2 === 0 ? K.red : K.white, x + 1 + col, y - 6 + row, 1, 1);
        }
      });
      rect(K.trunk, x + 7, y - 2, 1, 14);
      rect(K.gold, x + 3, y + 12, 9, 2);
      return;
    }
  }
}

/**
 * The garland on a wall face (x, y its top left corner). The fairy lights
 * change colour every 700 ms, never with reduced motion.
 */
export function feastFace(rect: Rect, C: Colors, garland: Exclude<FeastGarland, null>, face: FeastFace, x: number, y: number, now: number, reduceMotion: boolean, feast: OfficeFeast): void {
  switch (garland) {
    case 'lights': {
      rect(K.wire, x, y + 1, TILE, 1);
      const phase = reduceMotion ? 0 : Math.floor(now / 700);
      for (let i = 0; i < 3; i++) rect(K.bright[(face.c * 3 + i + phase) % K.bright.length] ?? K.gold, x + 2 + i * 5, y + 2, 2, 2);
      return;
    }
    case 'bunting': {
      const colors = feast === 'san-patrizio' ? K.irish : K.pastel;
      rect(C.outline, x, y + 1, TILE, 1);
      for (let i = 0; i < 2; i++) {
        const color = colors[(face.c * 2 + i) % colors.length] ?? K.gold;
        const fx = x + 1 + i * 8;
        rect(color, fx, y + 2, 5, 1);
        rect(color, fx + 1, y + 3, 3, 1);
        rect(color, fx + 2, y + 4, 1, 1);
      }
      return;
    }
    case 'streamers': {
      const wave = [0, 1, 2, 1];
      for (let i = 0; i < TILE; i++) {
        const at = face.c * TILE + i;
        const even = Math.floor(at / 4) % 2 === 0;
        rect(even ? K.bright[0] : K.bright[2], x + i, y + 1 + (wave[at % 4] ?? 0), 1, 1);
        rect(even ? K.bright[1] : K.bright[3], x + i, y + 3 - (wave[at % 4] ?? 0), 1, 1);
      }
      return;
    }
    case 'webs': {
      // A cobweb in the corners only, where a run of faces begins or ends.
      if (face.first) pixels(rect, WEB, x, y, { x: C.muted });
      if (face.last) pixels(rect, WEB.map((line) => line.split('').reverse().join('')), x + TILE - 7, y, { x: C.muted });
      if (face.first) {
        rect(C.muted, x + 3, y + 8, 1, 3);
        rect(C.outline, x + 2, y + 11, 3, 2);
      }
      return;
    }
  }
}

/** A small thing on the floor at (x, y), the speck's own point. */
export function feastSpeck(rect: Rect, scatter: Exclude<FeastScatter, null>, tone: number, x: number, y: number): void {
  switch (scatter) {
    case 'confetti':
      rect(K.bright[tone % K.bright.length] ?? K.red, x, y, tone % 2 === 0 ? 2 : 1, 1);
      return;
    case 'clover':
      rect(K.green, x + 1, y, 1, 1);
      rect(K.green, x, y + 1, 1, 1);
      rect(K.green, x + 2, y + 1, 1, 1);
      rect(K.greenDark, x + 1, y + 1, 1, 2);
      return;
    case 'egg': {
      // An egg of 3×4 pixels, narrow on top, with a white band.
      const color = K.pastel[tone % K.pastel.length] ?? K.gold;
      rect(color, x + 1, y, 1, 1);
      rect(color, x, y + 1, 3, 3);
      rect(K.white, x, y + 2, 3, 1);
      return;
    }
    case 'ball':
      rect(K.red, x, y, 3, 1);
      rect(K.white, x, y + 1, 3, 1);
      rect(K.blue, x, y + 2, 3, 1);
      return;
  }
}
