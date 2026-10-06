import { BODY_TOP, HEAD_TOP, LEGS_TOP, moveEyes, type SpriteSpec } from './spec.ts';

/**
 * How good a valid drawing looks (D-132): the checks Claude made by eye on
 * the Coder, in code. spec.ts says whether an answer can become a sheet;
 * this module says what is wrong with one that can, in words the model
 * reads in the second pass. The three hand-drawn characters (Arianna, the
 * Coder, the user) pass every check: the tests hold them to it.
 */
const WIDTH = 16;
const FRAME_ROWS = 32;
/** Pixels a symmetric view may break, by kind: an accessory on one side, a lock of hair. */
const MAX_SHAPE_ASYMMETRY = 2;
const MAX_COLOUR_ASYMMETRY = 6;
/** Edge pixels that may be something other than the outline: a hand, a shoe tip. */
const MAX_OPEN_EDGE = 4;
const MIN_COLOURS = 2;
const MAX_COLOURS = 10;
const MIN_HEAD_WIDTH = 8;
/** Relative luminance: the outline is dark, the eyes stand out from the face. */
const MAX_OUTLINE_LUMINANCE = 0.12;
const MIN_EYE_CONTRAST = 0.2;

export interface SpriteProblem {
  rule: 'symmetry' | 'outline' | 'eyes' | 'colours' | 'centre' | 'proportions' | 'pieces';
  /** For the model: English, our words, never the drawing's content. */
  text: string;
}

export type View = 'front' | 'side' | 'back';

/** The whole 16×32 frame of a view, as the code composes it. */
export function frameOf(spec: SpriteSpec, view: View): string[] {
  const empty = '.'.repeat(WIDTH);
  const rows = Array.from({ length: FRAME_ROWS }, () => empty);
  const legs = view === 'side' ? spec.legs.side : spec.legs.front;
  const pieces: [number, readonly string[]][] = [
    [HEAD_TOP, spec.head[view]],
    [BODY_TOP, spec.body[view]],
    [LEGS_TOP, legs],
  ];
  for (const [top, piece] of pieces) piece.forEach((line, index) => (rows[top + index] = line));
  return rows;
}

const drawn = (letter: string | undefined): boolean => letter !== undefined && letter !== '.';

function luminance(colour: string): number {
  const channel = (index: number): number => {
    const value = Number.parseInt(colour.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * Each piece mirrored around its own centre: legs one column off the
 * middle still read as symmetric; the frame's centring is its own check.
 */
function symmetry(spec: SpriteSpec, view: 'front' | 'back'): SpriteProblem[] {
  let shape = 0;
  let colour = 0;
  for (const rows of [spec.head[view], spec.body[view], spec.legs.front]) {
    const columns = rows.flatMap((line) => Array.from(line).flatMap((letter, x) => (drawn(letter) ? [x] : [])));
    // Never empty: checkSprite wants pixels in every piece.
    const axis = Math.min(...columns) + Math.max(...columns);
    for (const line of rows) {
      for (let x = 0; x < WIDTH; x += 1) {
        const mirror = axis - x;
        if (mirror <= x) continue;
        const [left, right] = [line[x], line[mirror]];
        if (drawn(left) !== drawn(right)) shape += 1;
        else if (drawn(left) && left !== right) colour += 1;
      }
    }
  }
  const problems: SpriteProblem[] = [];
  if (shape > MAX_SHAPE_ASYMMETRY) problems.push({ rule: 'symmetry', text: `the ${view} view is not symmetric left to right: ${String(shape)} pixels of the silhouette have no mirror pixel` });
  if (colour > MAX_COLOUR_ASYMMETRY) problems.push({ rule: 'symmetry', text: `the ${view} view is not symmetric left to right: ${String(colour)} pixels have a different colour from their mirror pixel` });
  return problems;
}

/** Drawn pixels on the edge of the figure (next to transparent or the frame's border) that are not the outline. */
function openEdge(rows: readonly string[]): number {
  let open = 0;
  rows.forEach((line, y) => {
    for (let x = 0; x < WIDTH; x += 1) {
      const letter = line[x];
      if (!drawn(letter) || letter === 'o') continue;
      const around = [rows[y - 1]?.[x], rows[y + 1]?.[x], x === 0 ? undefined : line[x - 1], line[x + 1]];
      if (around.some((neighbour) => !drawn(neighbour))) open += 1;
    }
  });
  return open;
}

function eyesAt(rows: readonly string[]): [number, number][] {
  const eyes: [number, number][] = [];
  rows.forEach((line, y) => {
    Array.from(line).forEach((letter, x) => {
      if (letter === 'e') eyes.push([y, x]);
    });
  });
  return eyes;
}

/** The colour that surrounds an eye most, never outline or transparent. */
function faceAround(rows: readonly string[], [y, x]: [number, number]): string {
  const counts = new Map<string, number>();
  for (const letter of [rows[y - 1]?.[x], rows[y + 1]?.[x], rows[y]?.[x - 1], rows[y]?.[x + 1]]) {
    if (letter !== undefined && drawn(letter) && letter !== 'o' && letter !== 'e') counts.set(letter, (counts.get(letter) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 's';
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.every((line, index) => line === b[index]);

function eyes(spec: SpriteSpec): SpriteProblem[] {
  const problems: SpriteProblem[] = [];
  const front = eyesAt(spec.head.front);
  const [first, second] = front;
  if (front.length !== 2 || first === undefined || second === undefined) {
    problems.push({ rule: 'eyes', text: `head.front has ${String(front.length)} eye pixels ("e"): it needs exactly 2, one per eye` });
  } else if (first[0] !== second[0]) {
    problems.push({ rule: 'eyes', text: 'the two eyes of head.front are not on the same row' });
  } else if (Math.abs(first[1] - second[1]) < 3) {
    problems.push({ rule: 'eyes', text: 'the two eyes of head.front are too close: leave at least two pixels of face between them' });
  }
  const side = eyesAt(spec.head.side);
  if (side.length !== 1) problems.push({ rule: 'eyes', text: `head.side has ${String(side.length)} eye pixels ("e"): seen from the side only one eye shows` });
  else if ((side[0]?.[1] ?? 0) < WIDTH / 2) problems.push({ rule: 'eyes', text: 'the eye of head.side is on the left half: the side view faces right' });
  // The poses look down, down-left, up and up-right: the eyes need face around them.
  const moves: [number, number][] = [[1, 0], [1, -1], [-1, 0], [-1, 1]];
  if (front.length === 2 && moves.some(([dy, dx]) => same(moveEyes(spec.head.front, dy, dx), spec.head.front))) {
    problems.push({ rule: 'eyes', text: 'the eyes of head.front cannot move one pixel up, down and sideways: put face colour (not outline, not transparent) all around each eye' });
  }
  if (side.length === 1 && same(moveEyes(spec.head.side, 1, 0), spec.head.side)) {
    problems.push({ rule: 'eyes', text: 'the eye of head.side cannot move one pixel down: put face colour below it' });
  }
  const eye = spec.palette.e;
  const face = first === undefined ? undefined : spec.palette[faceAround(spec.head.front, first)];
  if (eye !== undefined && face !== undefined && Math.abs(luminance(eye) - luminance(face)) < MIN_EYE_CONTRAST) {
    problems.push({ rule: 'eyes', text: 'the eye colour "e" is too close to the face colour around it: the eyes do not show' });
  }
  return problems;
}

function colours(spec: SpriteSpec): SpriteProblem[] {
  const problems: SpriteProblem[] = [];
  const used = new Set<string>();
  for (const group of [spec.head, spec.body, spec.legs]) {
    for (const rows of Object.values(group)) for (const line of rows) for (const letter of line) used.add(letter);
  }
  const own = [...used].filter((letter) => !['.', 'o', 'e', 'E', 's'].includes(letter));
  if (own.length < MIN_COLOURS) problems.push({ rule: 'colours', text: `only ${String(own.length)} colour(s) besides outline, eyes and skin: use 3 to 6, each with a darker shade where it needs one` });
  if (own.length > MAX_COLOURS) problems.push({ rule: 'colours', text: `${String(own.length)} colours besides outline, eyes and skin: too many for 16 pixels, keep 3 to 6 with their shades` });
  const outline = spec.palette.o;
  if (outline !== undefined && luminance(outline) > MAX_OUTLINE_LUMINANCE) problems.push({ rule: 'colours', text: 'the outline "o" is too light: use a very dark colour' });
  return problems;
}

function centre(rows: readonly string[], view: View): SpriteProblem[] {
  let left = WIDTH;
  let right = -1;
  for (const line of rows) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (drawn(line[x])) [left, right] = [Math.min(left, x), Math.max(right, x)];
    }
  }
  const margin = [left, WIDTH - 1 - right] as const;
  if (Math.abs(margin[0] - margin[1]) > 1) return [{ rule: 'centre', text: `the ${view} view is not centred: ${String(margin[0])} empty columns on the left, ${String(margin[1])} on the right` }];
  return [];
}

function proportions(spec: SpriteSpec): SpriteProblem[] {
  const problems: SpriteProblem[] = [];
  const width = (rows: readonly string[]): number => {
    const columns = new Set<number>();
    for (const line of rows) Array.from(line).forEach((letter, x) => drawn(letter) && columns.add(x));
    return columns.size;
  };
  if (width(spec.head.front) < MIN_HEAD_WIDTH) problems.push({ rule: 'proportions', text: `head.front is ${String(width(spec.head.front))} pixels wide: the head is big, at least ${String(MIN_HEAD_WIDTH)}` });
  for (const view of ['front', 'side', 'back'] as const) {
    if (!Array.from(spec.head[view][0] ?? '').some(drawn)) problems.push({ rule: 'proportions', text: `the first row of head.${view} is empty: it is the top of the hair or the hat` });
  }
  for (const view of ['front', 'side', 'stride'] as const) {
    if (!Array.from(spec.legs[view].at(-1) ?? '').some(drawn)) problems.push({ rule: 'proportions', text: `the last row of legs.${view} is empty: it is the shoes, the feet touch the bottom of the frame` });
  }
  return problems;
}

/** Each piece touches the next one: no head floating over the body. */
function pieces(rows: readonly string[], view: View): SpriteProblem[] {
  const touches = (upper: number): boolean => Array.from(rows[upper] ?? '').some((letter, x) => drawn(letter) && drawn(rows[upper + 1]?.[x]));
  const gaps: string[] = [];
  if (!touches(BODY_TOP - 1)) gaps.push('the head and the body');
  if (!touches(LEGS_TOP - 1)) gaps.push('the body and the legs');
  return gaps.length === 0 ? [] : [{ rule: 'pieces', text: `in the ${view} view ${gaps.join(' and ')} do not touch: the pieces float apart` }];
}

/** What looks wrong in a valid drawing; empty when nothing does. */
export function spriteProblems(spec: SpriteSpec): SpriteProblem[] {
  const views = (['front', 'side', 'back'] as const).map((view) => [view, frameOf(spec, view)] as const);
  return [
    ...symmetry(spec, 'front'),
    ...symmetry(spec, 'back'),
    ...views.flatMap(([view, rows]) => {
      const open = openEdge(rows);
      return open > MAX_OPEN_EDGE ? [{ rule: 'outline' as const, text: `the ${view} view has ${String(open)} pixels on the edge of the figure that are not the outline "o": close the outline all around` }] : [];
    }),
    ...eyes(spec),
    ...colours(spec),
    ...views.filter(([view]) => view !== 'side').flatMap(([view, rows]) => centre(rows, view)),
    ...proportions(spec),
    ...views.flatMap(([view, rows]) => pieces(rows, view)),
  ];
}

/** The three views side by side with row numbers: what the model looks at in the second pass. */
export function spritePreview(spec: SpriteSpec): string {
  const [front, side, back] = (['front', 'side', 'back'] as const).map((view) => frameOf(spec, view));
  const lines = ['row  front             side              back'];
  for (let y = HEAD_TOP; y < FRAME_ROWS; y += 1) {
    lines.push(`${String(y).padStart(3)}  ${front?.[y] ?? ''}  ${side?.[y] ?? ''}  ${back?.[y] ?? ''}`);
  }
  return lines.join('\n');
}
