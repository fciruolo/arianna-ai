import { doorAcross, isWall, TILE, tileAt, type Desk, type OfficeMap, type Point, type Room } from './map.ts';
import { SKIN_INK, type OfficeSkin } from './skins.ts';
import { springfieldConsole, springfieldCouch, springfieldFloor, springfieldItem, springfieldSign, springfieldStripe } from './springfield.ts';
import { quahogBar, quahogCouch, quahogFloor, quahogItem, quahogSign, quahogWainscot } from './quahog.ts';
import type { Bubble } from './snapshot.ts';

/**
 * Drawing the office on a canvas (D-106): furniture from code, characters
 * from their sheets, at 1 pixel per pixel; the page scales the canvas by an
 * integer with `image-rendering: pixelated`. Colours come from the theme's
 * tokens (`--office-*` in style.css), so light, dark and the themes of D-103
 * apply. Ported from the preview docs/mockups/ufficio.html.
 */
export const COLOR_TOKENS = [
  'floor', 'floor-alt', 'wall-top', 'wall-face', 'wall-line', 'window', 'window-light', 'desk', 'desk-top', 'desk-shadow', 'monitor',
  'screen-off', 'screen', 'chair', 'rug-l2', 'rug-l1', 'rug-neutral', 'rug-line', 'plant', 'plant-dark', 'pot', 'pot-dark', 'sofa',
  'sofa-dark', 'paper', 'counter', 'counter-top', 'outline', 'speech', 'speech-ink', 'shadow',
] as const;
export const THEME_TOKENS = ['accent', 'warn', 'ok', 'info', 'danger', 'muted', 'ink'] as const;
export type ColorName = (typeof COLOR_TOKENS)[number] | (typeof THEME_TOKENS)[number];
export type Colors = Record<ColorName, string>;

export interface Figure {
  x: number;
  y: number;
  sheet: CanvasImageSource | null;
  column: number;
  row: number;
  mirror: boolean;
  bubble: Bubble | null;
  /** Underlined: within reach of the user. */
  near: boolean;
  /** Greyed while paused. */
  dim: boolean;
}

export interface Scene {
  map: OfficeMap;
  colors: Colors;
  now: number;
  reduceMotion: boolean;
  /** Rug of each island slot by label; null for a free slot. */
  islandRugs: readonly ('l1' | 'l2' | null)[];
  /** Desks whose screen is on (someone works at them), by seat key "c,r". */
  screens: ReadonlySet<string>;
  figures: readonly Figure[];
  decisionsWaiting: boolean;
  /** The cardwall within reach of the user (D-165): underlined like a figure. */
  boardNear: boolean;
  /** The place of the theme (D-216): absent or `base`, the office as it always was. */
  skin?: OfficeSkin;
}

const FRAME_W = 16;
const FRAME_H = 32;

const PLANT = ['....gg.g....', '..g.gGgg.g..', '.ggGgggGgg..', '..gGggGggGg.', '.gggGgGgggg.', '..ggggGggg..', '...gGggGg...', '....gggg....', '...pppppp...', '...pPPPPp...', '...pppppp...', '....pppp....'];
const BUBBLES: Record<Bubble, readonly string[]> = {
  dots: ['.........', '.........', '.x..x..x.', '.........', '.........', '.........'],
  bang: ['....x....', '....x....', '....x....', '....x....', '.........', '....x....'],
  zz: ['xxx......', '..x......', '.x..xxxx.', 'xxx...x..', '.....x...', '....xxxx.'],
};

export function readColors(style: CSSStyleDeclaration): Colors {
  const colors = {} as Colors;
  for (const name of COLOR_TOKENS) colors[name] = style.getPropertyValue(`--office-${name}`).trim() || '#808080';
  for (const name of THEME_TOKENS) colors[name] = style.getPropertyValue(`--${name}`).trim() || '#808080';
  return colors;
}

export function drawOffice(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { map, colors: C } = scene;
  const rect = (color: string, x: number, y: number, w: number, h: number): void => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  const pixels = (lines: readonly string[], x: number, y: number, palette: Readonly<Record<string, string>>): void => {
    lines.forEach((line, j) => {
      for (let i = 0; i < line.length; i++) {
        const color = palette[line.charAt(i)];
        if (color !== undefined) rect(color, x + i, y + j, 1, 1);
      }
    });
  };

  const skin = scene.skin ?? 'base';
  const I = SKIN_INK;

  // Floor and rugs. The Sacro Cuore has tiles with their joints, the Dunder Mifflin a flecked carpet (D-216).
  if (skin === 'corsia') {
    for (let r = 0; r < map.height; r++) {
      for (let c = 0; c < map.width; c++) {
        rect(C.floor, c * TILE, r * TILE, TILE, TILE);
        rect(C['floor-alt'], c * TILE + TILE - 1, r * TILE, 1, TILE);
        rect(C['floor-alt'], c * TILE, r * TILE + TILE - 1, TILE, 1);
        rect(C['floor-alt'], c * TILE + 7, r * TILE + 7, 1, 1);
      }
    }
  } else if (skin === 'ufficio') {
    for (let r = 0; r < map.height; r++) {
      for (let c = 0; c < map.width; c++) {
        rect(C.floor, c * TILE, r * TILE, TILE, TILE);
        for (let i = 0; i < 6; i++) rect(C['floor-alt'], c * TILE + ((c * 7 + r * 3 + i * 5) % TILE), r * TILE + ((c * 5 + r * 11 + i * 9) % TILE), 1, 1);
      }
    }
  } else if (skin === 'springfield') {
    for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) springfieldFloor(rect, C, c, r);
  } else if (skin === 'quahog') {
    // The floorboards of the Griffin house (D-238).
    for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) quahogFloor(rect, C, c, r, TILE);
  } else {
    for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) rect((c + r) % 2 === 1 ? C['floor-alt'] : C.floor, c * TILE, r * TILE, TILE, TILE);
  }
  const rug = (room: Room, color: string): void => {
    const x = room[0] * TILE + 2;
    const y = room[1] * TILE + 2;
    const w = (room[2] - room[0] + 1) * TILE - 4;
    const h = (room[3] - room[1] + 1) * TILE - 4;
    rect(color, x, y, w, h);
    rect(C['rug-line'], x, y, w, 1);
    rect(C['rug-line'], x, y + h - 1, w, 1);
    rect(C['rug-line'], x, y, 1, h);
    rect(C['rug-line'], x + w - 1, y, 1, h);
  };
  const { anchors } = map;

  /**
   * The cardwall (D-165), drawn once from the first tile of its run: a frame,
   * a column per tile with a line on top and fixed notes in the theme's
   * colours. A drawing, not the cards: nothing of them reaches the canvas.
   */
  const NOTES = [C.accent, C.warn, C.info, C.ok, C.danger];
  const board = (x: number, y: number, c: number, r: number): void => {
    let end = c;
    while (tileAt(map, end + 1, r) === 'board') end++;
    const w = (end - c + 1) * TILE;
    rect(C.outline, x + 1, y + 1, w - 2, 13);
    rect(C.paper, x + 2, y + 2, w - 4, 11);
    const columns = (end - c + 1) * 2;
    const step = (w - 4) / columns;
    for (let i = 0; i < columns; i++) {
      const left = Math.round(x + 2 + i * step);
      if (i > 0) rect(C['wall-line'], left, y + 2, 1, 11);
      const inner = Math.max(2, Math.round(step) - 2);
      rect(C.outline, left + 1, y + 3, inner, 1);
      const count = 1 + ((i * 5 + c) % 3);
      for (let j = 0; j < count; j++) rect(NOTES[(i + j * 2) % NOTES.length] ?? C.accent, left + 1, y + 5 + j * 3, inner, 2);
    }
    if (scene.boardNear) rect(C.accent, x + 2, y + TILE, w - 4, 1);
  };
  rug(anchors.private.room, C['rug-l2']);
  anchors.islands.forEach((island, slot) => {
    const kind = scene.islandRugs[slot];
    if (kind === 'l1') rug(island.room, C['rug-l1']);
    else if (kind === 'l2') rug(island.room, C['rug-l2']);
  });
  rug(anchors.pause.room, C['rug-neutral']);
  rug(anchors.decisions.room, C['rug-neutral']);
  rug(anchors.archive.room, C['rug-neutral']);
  /**
   * A door (D-229): an opening in the wall, the floor seen through it, the
   * wall's top over it as a lintel, the jambs where the wall goes on and the
   * line at the foot of the wall carried across as a threshold.
   */
  const door = (c: number, r: number, x: number, y: number): void => {
    if (doorAcross(map, c, r) === 'vertical') {
      rect(C['wall-top'], x, y, 2, TILE);
      rect(C['wall-top'], x + TILE - 2, y, 2, TILE);
      return;
    }
    // The opening: the floor in the shade of the lintel, the lintel, the jambs.
    rect(C['floor-alt'], x, y + 4, TILE, 5);
    rect(C['wall-top'], x, y, TILE, 4);
    rect(C.outline, x, y + 4, TILE, 1);
    if (tileAt(map, c - 1, r) !== 'door') {
      rect(C.outline, x, y, 1, TILE);
      rect(C['wall-face'], x + 1, y + 1, 3, TILE - 1);
      rect(C.outline, x + 4, y + 4, 1, TILE - 4);
      // The leaf, open against the jamb.
      rect(C.outline, x + 5, y + 5, 4, 10);
      rect(C.desk, x + 6, y + 6, 2, 8);
      rect(C['desk-top'], x + 6, y + 9, 1, 1);
    }
    if (tileAt(map, c + 1, r) !== 'door') {
      rect(C.outline, x + TILE - 1, y, 1, TILE);
      rect(C['wall-face'], x + TILE - 4, y + 1, 3, TILE - 1);
      rect(C.outline, x + TILE - 5, y + 4, 1, TILE - 4);
    }
    rect(C['wall-line'], x, y + TILE - 2, TILE, 2);
  };

  // Walls: a face where the floor is below, the top elsewhere; windows, a shelf and the cardwall on the faces.
  // The cardwall spans its run: drawn after every face, which would cover it.
  const boards: Point[] = [];
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const kind = tileAt(map, c, r);
      const x = c * TILE;
      const y = r * TILE;
      if (kind === 'door') {
        door(c, r, x, y);
        continue;
      }
      if (!isWall(kind)) continue;
      const below = tileAt(map, c, r + 1);
      if (below === undefined || isWall(below)) {
        rect(C['wall-top'], x, y, TILE, TILE);
        // The edge of a wall seen from above, where the floor is beside it (D-229: the walls of the rooms).
        if (!isWall(tileAt(map, c - 1, r)) && tileAt(map, c - 1, r) !== undefined) rect(C['wall-line'], x, y, 1, TILE);
        if (!isWall(tileAt(map, c + 1, r)) && tileAt(map, c + 1, r) !== undefined) rect(C['wall-line'], x + TILE - 1, y, 1, TILE);
        continue;
      }
      rect(C['wall-face'], x, y, TILE, TILE);
      rect(C['wall-line'], x, y + TILE - 2, TILE, 2);
      // The handrail halfway up the corridor's wall (D-216, the decor of the theme Corsia).
      if (skin === 'corsia') rect(C['wall-line'], x, y + 9, TILE, 1);
      // The wooden wainscot of the Griffin house (D-238).
      if (skin === 'quahog') quahogWainscot(rect, C, x, y, TILE);
      // The hazard stripe of the power plant (D-237), under the windows and the signs.
      if (skin === 'springfield' && kind === 'wall') springfieldStripe(rect, x, y);
      if (kind === 'shelf' && skin === 'springfield') {
        springfieldSign(rect, C, x, y);
      } else if (kind === 'shelf' && skin === 'corsia') {
        // The green cross of the hospital on a white plate.
        rect(C.outline, x + 2, y + 1, 12, 12);
        rect(C.paper, x + 3, y + 2, 10, 10);
        rect(I.cross, x + 7, y + 3, 2, 8);
        rect(I.cross, x + 4, y + 6, 8, 2);
      } else if (kind === 'shelf' && skin === 'ufficio') {
        // The sign of the paper company: a dark plate with a stack of paper and two lines of writing.
        rect(C.outline, x + 1, y + 2, 14, 10);
        rect(I.sign, x + 2, y + 3, 12, 8);
        rect(I.signInk, x + 3, y + 4, 3, 4);
        rect(I.sign, x + 4, y + 5, 1, 2);
        rect(I.signInk, x + 7, y + 5, 6, 1);
        rect(I.signInk, x + 7, y + 7, 4, 1);
        rect(I.signInk, x + 3, y + 9, 10, 1);
      } else if (kind === 'shelf' && skin === 'quahog') {
        quahogSign(rect, C, x, y);
      } else if (kind === 'window') {
        rect(C.outline, x + 1, y + 2, 14, 11);
        rect(C.window, x + 2, y + 3, 12, 9);
        rect(C['window-light'], x + 3, y + 4, 4, 3);
        rect(C.outline, x + 7, y + 3, 1, 9);
        rect(C.outline, x + 2, y + 7, 12, 1);
      } else if (kind === 'shelf') {
        rect(C.outline, x + 1, y + 1, 14, 13);
        rect(C.desk, x + 2, y + 2, 12, 11);
        const books = [C.accent, C.warn, C.info, C.ok, C.danger, C.paper];
        for (let i = 0; i < 5; i++) {
          rect(books[i] ?? C.paper, x + 3 + i * 2, y + 3, 2, 4);
          rect(books[(i + 2) % 6] ?? C.paper, x + 3 + i * 2, y + 8, 2, 4);
        }
      } else if (kind === 'board' && tileAt(map, c - 1, r) !== 'board') {
        boards.push([c, r]);
      }
    }
  }
  for (const [c, r] of boards) board(c * TILE, r * TILE, c, r);
  // The entrance: a door in the wall below it, a mat on the floor.
  const [ec, er] = anchors.entrance;
  if (isWall(tileAt(map, ec, er + 1))) {
    rect(C.outline, ec * TILE, (er + 1) * TILE, TILE * 2, 4);
    rect(C['rug-line'], ec * TILE + 2, er * TILE + 8, TILE * 2 - 4, 6);
  }

  // Everything that stands is drawn from the back to the front.
  const items: { y: number; draw: () => void }[] = [];
  const figures = scene.figures;

  const desk = (d: Desk, seat: Point): void => {
    const x = d[0] * TILE;
    const y = d[1] * TILE;
    const w = d[2] * TILE;
    const on = scene.screens.has(`${String(seat[0])},${String(seat[1])}`);
    rect(C['desk-shadow'], x + 1, y + 14, w - 2, 2);
    rect(C.outline, x, y - 3, w, 17);
    rect(C['desk-top'], x + 1, y - 2, w - 2, 7);
    rect(C.desk, x + 1, y + 5, w - 2, 8);
    rect(C['desk-shadow'], x + 1, y + 5, w - 2, 1);
    rect(C.outline, x + 2, y - 15, 12, 11);
    rect(C.monitor, x + 3, y - 14, 10, 9);
    rect(on ? C.screen : C['screen-off'], x + 4, y - 13, 8, 6);
    if (on) rect(C.monitor, x + 5, y - 13 + (scene.reduceMotion ? 2 : Math.floor(scene.now / 160) % 6), 5, 1);
    rect(C.outline, x + 7, y - 4, 2, 2);
    rect(C.paper, x + w - 13, y - 1, 7, 4);
    rect(C.outline, x + w - 12, y, 5, 1);
    rect(C.outline, x + w - 5, y - 4, 4, 5);
    rect(C.accent, x + w - 4, y - 3, 2, 3);
  };
  const chair = (seat: Point): void => {
    const px = seat[0] * TILE + 8;
    const py = (seat[1] + 1) * TILE + 2;
    rect(C.outline, px - 5, py - 17, 10, 1);
    rect(C.outline, px - 6, py - 16, 12, 9);
    rect(C.chair, px - 5, py - 16, 10, 7);
    rect(C['sofa-dark'], px - 5, py - 10, 10, 1);
  };
  for (const island of [anchors.private, ...anchors.islands]) {
    items.push({ y: island.desk[1] * TILE - 7, draw: () => { chair(island.seat); } });
    items.push({ y: (island.desk[1] + 1) * TILE, draw: () => { desk(island.desk, island.seat); } });
  }

  const counter = anchors.decisions.desk;
  const bell: Point = [((counter[0] * 2 + counter[2]) / 2) * TILE, counter[1] * TILE];
  items.push({
    y: counter[1] * TILE + 14,
    draw: () => {
      const x = counter[0] * TILE;
      const y = counter[1] * TILE;
      const w = counter[2] * TILE;
      rect(C['desk-shadow'], x + 1, y + 14, w - 2, 2);
      rect(C.outline, x, y - 3, w, 17);
      rect(C['counter-top'], x + 1, y - 2, w - 2, 6);
      rect(C.counter, x + 1, y + 4, w - 2, 9);
      for (let i = 0; i < counter[2] - 1; i++) rect(C['counter-top'], x + 8 + i * 18, y + 7, 10, 2);
      if (skin === 'corsia') {
        // The nurses' station: the green cross on the front, a clipboard and the files on top.
        rect(C.paper, x + 3, y + 5, 7, 7);
        rect(I.cross, x + 6, y + 6, 1, 5);
        rect(I.cross, x + 4, y + 8, 5, 1);
        rect(C.outline, x + w - 14, y - 6, 6, 8);
        rect(C.paper, x + w - 13, y - 5, 4, 6);
        rect(C.outline, x + w - 12, y - 7, 2, 1);
      } else if (skin === 'ufficio') {
        // The reception: the jar of sweets and the telephone.
        rect(C.outline, x + 3, y - 8, 6, 7);
        rect(I.glass, x + 4, y - 7, 4, 5);
        for (let i = 0; i < 4; i++) rect(I.candy[i] ?? C.accent, x + 4 + (i % 2) * 2, y - 5 + Math.floor(i / 2) * 2, 1, 1);
        rect(C.outline, x + w - 12, y - 5, 8, 4);
        rect(C.monitor, x + w - 11, y - 4, 6, 2);
        rect(C.outline, x + w - 12, y - 7, 8, 2);
      } else if (skin === 'springfield') {
        springfieldConsole(rect, C, x, y, w);
      } else if (skin === 'quahog') {
        // The bar of the Drunken Clam (D-238).
        quahogBar(rect, C, x, y, w);
      }
      const bx = bell[0] - 3;
      rect(C.outline, bx, y - 7, 7, 5);
      rect(scene.decisionsWaiting ? C.warn : C.muted, bx + 1, y - 6, 5, 3);
      rect(C.outline, bx + 3, y - 8, 1, 1);
    },
  });

  /** The vending machine and the cart of the Sacro Cuore, the water cooler and the photocopier of the Dunder Mifflin (D-216). */
  const skinItem = (kind: 'coffee' | 'cabinet', x: number, y: number): void => {
    if (skin === 'springfield') {
      springfieldItem(rect, C, kind, x, y);
    } else if (skin === 'quahog') {
      quahogItem(rect, C, kind, x, y);
    } else if (skin === 'corsia' && kind === 'coffee') {
      rect(C.outline, x + 1, y - 10, 14, 24);
      rect(I.metalDark, x + 2, y - 9, 12, 22);
      rect(I.glass, x + 3, y - 8, 7, 14);
      for (let row = 0; row < 4; row++) for (let col = 0; col < 2; col++) rect(I.snack[(row + col) % 4] ?? C.accent, x + 4 + col * 3, y - 7 + row * 3, 2, 2);
      rect(C.paper, x + 11, y - 6, 2, 4);
      rect(C.outline, x + 3, y + 8, 7, 3);
    } else if (skin === 'corsia') {
      // The medicine cart: drawers in three colours, the green cross on the side.
      rect(C.outline, x + 1, y - 6, 14, 18);
      rect(I.metal, x + 2, y - 5, 12, 16);
      const drawers = [I.blanket, I.crossLight, C.paper];
      for (let i = 0; i < 3; i++) rect(drawers[i] ?? C.paper, x + 3, y - 4 + i * 5, 10, 4);
      rect(I.cross, x + 7, y - 9, 2, 3);
      rect(I.cross, x + 6, y - 8, 4, 1);
      rect(C.outline, x + 2, y + 12, 2, 2);
      rect(C.outline, x + 12, y + 12, 2, 2);
    } else if (kind === 'coffee') {
      // The water cooler.
      rect(C.outline, x + 4, y - 12, 8, 9);
      rect(I.water, x + 5, y - 11, 6, 7);
      rect(C.outline, x + 3, y - 3, 10, 17);
      rect(C.paper, x + 4, y - 2, 8, 15);
      rect(I.water, x + 6, y + 2, 1, 2);
      rect(C.danger, x + 9, y + 2, 1, 2);
    } else {
      // The photocopier: the lid, the glass, the paper tray.
      rect(C.outline, x, y - 6, 16, 20);
      rect(I.copier, x + 1, y - 5, 14, 18);
      rect(I.copierDark, x + 1, y - 5, 14, 3);
      rect(C.monitor, x + 10, y - 1, 4, 2);
      rect(C.ok, x + 13, y - 1, 1, 1);
      rect(C.paper, x + 3, y + 5, 10, 3);
      rect(I.copierDark, x + 1, y + 9, 14, 1);
    }
  };
  /** A run of `sofa` tiles: hospital beds in the Sacro Cuore, the meeting table in the Dunder Mifflin (D-216). */
  const skinRun = (x: number, y: number, w: number, tiles: number): void => {
    if (skin === 'springfield') {
      springfieldCouch(rect, C, x, y, w, tiles);
    } else if (skin === 'quahog') {
      quahogCouch(rect, C, x, y, w, tiles, TILE);
    } else if (skin === 'corsia') {
      for (let i = 0; i < tiles; i++) {
        const bx = x + i * TILE;
        rect(C.outline, bx + 1, y - 4, 14, 17);
        rect(I.metal, bx + 2, y - 3, 12, 15);
        rect(C.sofa, bx + 3, y - 3, 10, 12);
        rect(C.paper, bx + 4, y - 2, 8, 3);
        rect(C['sofa-dark'], bx + 3, y + 3, 10, 6);
        rect(C.outline, bx + 2, y + 12, 2, 2);
        rect(C.outline, bx + 12, y + 12, 2, 2);
      }
    } else {
      rect(C.outline, x, y - 2, w, 14);
      rect(C['sofa-dark'], x + 1, y - 1, w - 2, 12);
      rect(C.sofa, x + 1, y - 1, w - 2, 9);
      for (let i = 0; i < tiles; i++) rect(C.paper, x + 4 + i * TILE, y + 1, 6, 4);
      for (let i = 0; i < tiles; i++) rect(C.chair, x + 4 + i * TILE, y - 6, 8, 4);
    }
  };

  // Single furniture tiles and runs of sofa.
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const kind = tileAt(map, c, r);
      const x = c * TILE;
      const y = r * TILE;
      if (skin !== 'base' && (kind === 'coffee' || kind === 'cabinet')) {
        items.push({ y: y + 14, draw: () => { skinItem(kind, x, y); } });
      } else if (kind === 'plant') {
        items.push({ y: y + 14, draw: () => { pixels(PLANT, x + 2, y + 2, { g: C.plant, G: C['plant-dark'], p: C.pot, P: C['pot-dark'] }); } });
      } else if (kind === 'coffee') {
        items.push({
          y: y + 14,
          draw: () => {
            rect(C.outline, x + 2, y - 8, 12, 22);
            rect(C.monitor, x + 3, y - 7, 10, 20);
            rect(C.danger, x + 5, y - 5, 2, 2);
            rect(C.ok, x + 9, y - 5, 2, 2);
            rect(C.paper, x + 6, y + 4, 4, 4);
          },
        });
      } else if (kind === 'cabinet') {
        items.push({
          y: y + 14,
          draw: () => {
            rect(C.outline, x + 1, y - 10, 14, 24);
            rect(C.counter, x + 2, y - 9, 12, 22);
            for (let i = 0; i < 3; i++) {
              rect(C['desk-shadow'], x + 2, y - 3 + i * 7, 12, 1);
              rect(C.paper, x + 6, y - 7 + i * 7, 4, 2);
            }
          },
        });
      } else if (kind === 'sofa' && tileAt(map, c - 1, r) !== 'sofa' && skin !== 'base') {
        let end = c;
        while (tileAt(map, end + 1, r) === 'sofa') end++;
        const w = (end - c + 1) * TILE;
        items.push({ y: y + 14, draw: () => { skinRun(x, y, w, end - c + 1); } });
      } else if (kind === 'sofa' && tileAt(map, c - 1, r) !== 'sofa') {
        let end = c;
        while (tileAt(map, end + 1, r) === 'sofa') end++;
        const w = (end - c + 1) * TILE;
        items.push({
          y: y + 4,
          draw: () => {
            rect(C.outline, x, y - 6, w, 20);
            rect(C['sofa-dark'], x + 1, y - 5, w - 2, 9);
            rect(C.sofa, x + 1, y + 4, w - 2, 9);
            for (let i = 1; i <= end - c; i++) rect(C['sofa-dark'], x + i * TILE, y + 4, 1, 9);
          },
        });
        items.push({
          y: y + 15,
          draw: () => {
            rect(C.outline, x, y - 2, 4, 16);
            rect(C['sofa-dark'], x + 1, y - 1, 2, 14);
            rect(C.outline, x + w - 4, y - 2, 4, 16);
            rect(C['sofa-dark'], x + w - 3, y - 1, 2, 14);
          },
        });
      }
    }
  }

  for (const figure of figures) {
    items.push({
      y: figure.y,
      draw: () => {
        const fx = Math.round(figure.x);
        const fy = Math.round(figure.y);
        rect(C.shadow, fx - 5, fy - 1, 10, 2);
        rect(C.shadow, fx - 3, fy - 2, 6, 1);
        if (figure.near) rect(C.accent, fx - 6, fy, 12, 1);
        if (figure.sheet === null) return;
        const dx = fx - 8;
        const dy = fy - 31;
        ctx.save();
        if (figure.dim) ctx.globalAlpha = 0.6;
        if (figure.mirror) {
          ctx.translate(dx + FRAME_W, dy);
          ctx.scale(-1, 1);
          ctx.drawImage(figure.sheet, figure.column * FRAME_W, figure.row * FRAME_H, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
        } else {
          ctx.drawImage(figure.sheet, figure.column * FRAME_W, figure.row * FRAME_H, FRAME_W, FRAME_H, dx, dy, FRAME_W, FRAME_H);
        }
        ctx.restore();
      },
    });
  }
  items.sort((a, b) => a.y - b.y).forEach((item) => { item.draw(); });

  // Bubbles over everything.
  const bubble = (kind: Bubble, x: number, y: number, still: boolean): void => {
    const bob = scene.reduceMotion || still ? 0 : Math.floor(scene.now / 500) % 2;
    const bx = Math.round(x) - 6;
    const by = Math.round(y) - bob;
    rect(C.outline, bx, by, 13, 10);
    rect(C.speech, bx + 1, by + 1, 11, 8);
    rect(C.outline, bx + 5, by + 10, 3, 1);
    rect(C.outline, bx + 6, by + 11, 1, 1);
    rect(C.speech, bx + 6, by + 9, 1, 1);
    const color = kind === 'bang' ? C.warn : kind === 'zz' ? C.info : C['speech-ink'];
    pixels(BUBBLES[kind], bx + 2, by + 2, { x: color });
  };
  for (const figure of figures) if (figure.bubble !== null) bubble(figure.bubble, figure.x, figure.y - 39, false);
  if (scene.decisionsWaiting && (scene.reduceMotion || Math.floor(scene.now / 600) % 2 === 0)) bubble('bang', bell[0], counter[1] * TILE - 22, true);
}
