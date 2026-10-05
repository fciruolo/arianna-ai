import { isWall, TILE, tileAt, type Desk, type OfficeMap, type Point, type Room } from './map.ts';
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

  // Floor and rugs.
  for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) rect((c + r) % 2 === 1 ? C['floor-alt'] : C.floor, c * TILE, r * TILE, TILE, TILE);
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
  rug(anchors.private.room, C['rug-l2']);
  anchors.islands.forEach((island, slot) => {
    const kind = scene.islandRugs[slot];
    if (kind === 'l1') rug(island.room, C['rug-l1']);
    else if (kind === 'l2') rug(island.room, C['rug-l2']);
  });
  rug(anchors.pause.room, C['rug-neutral']);
  rug(anchors.decisions.room, C['rug-neutral']);
  rug(anchors.archive.room, C['rug-neutral']);

  // Walls: a face where the floor is below, the top elsewhere; windows and a shelf on the faces.
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const kind = tileAt(map, c, r);
      if (!isWall(kind)) continue;
      const x = c * TILE;
      const y = r * TILE;
      const below = tileAt(map, c, r + 1);
      if (below === undefined || isWall(below)) {
        rect(C['wall-top'], x, y, TILE, TILE);
        continue;
      }
      rect(C['wall-face'], x, y, TILE, TILE);
      rect(C['wall-line'], x, y + TILE - 2, TILE, 2);
      if (kind === 'window') {
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
      }
    }
  }
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
      const bx = bell[0] - 3;
      rect(C.outline, bx, y - 7, 7, 5);
      rect(scene.decisionsWaiting ? C.warn : C.muted, bx + 1, y - 6, 5, 3);
      rect(C.outline, bx + 3, y - 8, 1, 1);
    },
  });

  // Single furniture tiles and runs of sofa.
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const kind = tileAt(map, c, r);
      const x = c * TILE;
      const y = r * TILE;
      if (kind === 'plant') {
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
