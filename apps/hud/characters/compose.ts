/**
 * Builds a character sheet in the format of pixel-agents (D-060) from pixel
 * maps written as text. A sheet is 7 columns of 16×32 frames; rows are the
 * directions down, up, right (left is right mirrored), plus a fourth row of
 * Arianna's own for think, wait and pause. Columns: 0–2 walk, 3–4 type,
 * 5–6 read; on the fourth row 0–1 think, 2–3 wait, 4–5 pause, 6 blink.
 *
 * A frame is a stack of parts. Each part is a small map placed at a row of
 * the frame; `.` is transparent and every other letter is a palette colour.
 * Parts are drawn in order, so a later one covers an earlier one.
 */
export const FRAME_WIDTH = 16;
export const FRAME_HEIGHT = 32;
export const COLUMNS = 7;
export const DIRECTIONS = ['down', 'up', 'right'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface Part {
  /** Row of the frame where the first line of the map goes. */
  top: number;
  rows: readonly string[];
}

export interface CharacterArt {
  id: string;
  /** Letter → `#rrggbb`. */
  palette: Readonly<Record<string, string>>;
  /** Parts of each direction by name (`head`, `body-type1`, `legs-step2`…). */
  parts: Readonly<Record<Direction, Readonly<Record<string, Part>>>>;
}

/** One part to draw: its name and an optional vertical shift. */
export interface Layer {
  part: string;
  dy?: number;
}

/**
 * The frames every original character has, by row and column. A name the
 * character does not define falls back to the name before the last `-`
 * (`head-blink` → `head`, `body-type2` → `body-type`), so a pose that changes nothing need not be drawn.
 */
const WALK: readonly (readonly Layer[])[] = [
  [{ part: 'legs-step1' }, { part: 'body-step1' }, { part: 'head' }],
  [{ part: 'legs' }, { part: 'body' }, { part: 'head' }],
  [{ part: 'legs-step2' }, { part: 'body-step2' }, { part: 'head' }],
];
const WORK: readonly (readonly Layer[])[] = [
  [{ part: 'legs' }, { part: 'body-type' }, { part: 'head-work' }],
  [{ part: 'legs' }, { part: 'body-type2' }, { part: 'head-work' }],
  [{ part: 'legs' }, { part: 'body-read' }, { part: 'head-read' }],
  [{ part: 'legs' }, { part: 'body-read2' }, { part: 'head-read2' }],
];
const DIRECTION_FRAMES: readonly (readonly Layer[])[] = [...WALK, ...WORK];

/** The fourth row, facing down: think, wait for the user, pause, blink. */
const EXTRA_FRAMES: readonly (readonly Layer[])[] = [
  [{ part: 'legs' }, { part: 'body-think' }, { part: 'head-up' }, { part: 'over-think' }],
  [{ part: 'legs' }, { part: 'body-think' }, { part: 'head-up2' }, { part: 'over-think' }],
  [{ part: 'legs' }, { part: 'body-wait' }, { part: 'head' }, { part: 'over-wait' }],
  [{ part: 'legs' }, { part: 'body-wait' }, { part: 'head-blink' }, { part: 'over-wait2' }],
  [{ part: 'legs' }, { part: 'body' }, { part: 'head-sleep' }],
  [{ part: 'legs' }, { part: 'body' }, { part: 'head-sleep', dy: 1 }],
  [{ part: 'legs' }, { part: 'body' }, { part: 'head-blink' }],
];

export function framesOf(row: number): readonly (readonly Layer[])[] {
  return row < DIRECTIONS.length ? DIRECTION_FRAMES : EXTRA_FRAMES;
}

function resolvePart(parts: Readonly<Record<string, Part>>, name: string): Part | undefined {
  let current = name;
  for (;;) {
    const found = parts[current];
    if (found !== undefined) return found;
    const cut = current.lastIndexOf('-');
    if (cut < 0) return undefined;
    current = current.slice(0, cut);
  }
}

/** Throws on a map whose lines are not 16 wide, leave the frame, or use a letter outside the palette. */
export function checkArt(art: CharacterArt): void {
  for (const direction of DIRECTIONS) {
    for (const [name, part] of Object.entries(art.parts[direction])) {
      const where = `${art.id}.${direction}.${name}`;
      if (part.top < 0 || part.top + part.rows.length > FRAME_HEIGHT) throw new Error(`${where}: outside the frame`);
      part.rows.forEach((line, index) => {
        if (line.length !== FRAME_WIDTH) throw new Error(`${where}[${String(index)}]: ${String(line.length)} columns, not ${String(FRAME_WIDTH)}`);
        for (const letter of line) {
          if (letter !== '.' && art.palette[letter] === undefined) throw new Error(`${where}[${String(index)}]: "${letter}" is not in the palette`);
        }
      });
    }
  }
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** The whole sheet as RGBA pixels: 112 × 128. */
export function renderSheet(art: CharacterArt): { width: number; height: number; rgba: Uint8Array } {
  checkArt(art);
  const rows = DIRECTIONS.length + 1;
  const width = FRAME_WIDTH * COLUMNS;
  const height = FRAME_HEIGHT * rows;
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < rows; row++) {
    const direction = DIRECTIONS[row] ?? 'down';
    const parts = art.parts[direction];
    framesOf(row).forEach((layers, column) => {
      for (const layer of layers) {
        const part = resolvePart(parts, layer.part);
        if (part === undefined) {
          // Overlays are optional; every other part must exist.
          if (layer.part.startsWith('over-')) continue;
          throw new Error(`${art.id}.${direction}: part "${layer.part}" is missing`);
        }
        part.rows.forEach((line, index) => {
          const y = part.top + index + (layer.dy ?? 0);
          if (y < 0 || y >= FRAME_HEIGHT) return;
          for (let x = 0; x < FRAME_WIDTH; x++) {
            const letter = line[x] ?? '.';
            if (letter === '.') continue;
            const [r, g, b] = rgb(art.palette[letter] ?? '#000000');
            const at = ((row * FRAME_HEIGHT + y) * width + column * FRAME_WIDTH + x) * 4;
            rgba[at] = r;
            rgba[at + 1] = g;
            rgba[at + 2] = b;
            rgba[at + 3] = 255;
          }
        });
      }
    });
  }
  return { width, height, rgba };
}
