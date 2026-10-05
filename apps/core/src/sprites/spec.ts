import { renderSheet, type CharacterArt, type Part } from '../../../hud/characters/compose.ts';
import { encodePng } from '../png.ts';

/**
 * A character drawn by a model (D-123, docs/D-123-sprite.md). The model
 * answers with a palette and nine parts at fixed sizes, the same rows as
 * Arianna and the Coder (head 7–16, body 17–25, legs 26–31); this module
 * checks every field, derives the poses from the parts and writes the sheet
 * of pixel-agents (112×128, with the fourth row) through compose.ts. The
 * same answer always gives the same PNG.
 */
export const HEAD_TOP = 7;
export const BODY_TOP = 17;
export const LEGS_TOP = 26;
const WIDTH = 16;
export const PIECE_ROWS = { head: 10, body: 9, legs: 6 } as const;
export const VIEWS = { head: ['front', 'side', 'back'], body: ['front', 'side', 'back'], legs: ['front', 'side', 'stride'] } as const;
/** Letters every palette has, with a fixed meaning the derived poses rely on. */
export const REQUIRED_LETTERS = { o: 'outline', e: 'eyes', E: 'closed eyes', s: 'skin and hands' } as const;
export const MIN_COLOURS = 4;
export const MAX_COLOURS = 16;
/** A piece with fewer drawn pixels is not a drawing. */
const MIN_PIXELS = 8;
/** The answer of the model, as text. */
export const MAX_REPLY_BYTES = 16 * 1024;

/** Colours of the code, never of the model: its letters are ASCII letters only. */
const PAPER = '1';
const LINE = '2';
const OWN_COLOURS: Readonly<Record<string, string>> = { [PAPER]: '#f4ecd8', [LINE]: '#c9b98f' };

const LETTER = /^[A-Za-z]$/;
const COLOUR = /^#[0-9A-Fa-f]{6}$/;
const ROW = /^[.A-Za-z]{16}$/;

type Group = keyof typeof PIECE_ROWS;
export interface SpriteSpec {
  palette: Record<string, string>;
  head: { front: string[]; side: string[]; back: string[] };
  body: { front: string[]; side: string[]; back: string[] };
  legs: { front: string[]; side: string[]; stride: string[] };
}

/** Why an answer is refused: the field and the rule, never the content. */
export class SpriteSpecError extends Error {
  override name = 'SpriteSpecError';
}

/** The JSON Schema of the answer: constrained decoding on the local model, and what the prompt describes. */
export const SPRITE_SCHEMA: Readonly<Record<string, unknown>> = (() => {
  const row = { type: 'string', pattern: ROW.source, minLength: WIDTH, maxLength: WIDTH };
  const group = (name: Group) => ({
    type: 'object',
    additionalProperties: false,
    required: [...VIEWS[name]],
    properties: Object.fromEntries(VIEWS[name].map((view) => [view, { type: 'array', items: row, minItems: PIECE_ROWS[name], maxItems: PIECE_ROWS[name] }])),
  });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['palette', 'head', 'body', 'legs'],
    properties: {
      palette: {
        type: 'object',
        minProperties: MIN_COLOURS,
        maxProperties: MAX_COLOURS,
        required: Object.keys(REQUIRED_LETTERS),
        propertyNames: { pattern: LETTER.source },
        additionalProperties: { type: 'string', pattern: COLOUR.source },
      },
      head: group('head'),
      body: group('body'),
      legs: group('legs'),
    },
  };
})();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  // The names are the model's: only their number is told.
  if (extra.length > 0) throw new SpriteSpecError(`${where}: ${String(extra.length)} field(s) not in the schema`);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new SpriteSpecError(`${where}: missing ${missing.join(', ')}`);
}

function checkPalette(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new SpriteSpecError('palette: expected an object');
  const entries = Object.entries(value);
  if (entries.length < MIN_COLOURS || entries.length > MAX_COLOURS) throw new SpriteSpecError(`palette: ${String(MIN_COLOURS)}-${String(MAX_COLOURS)} colours`);
  const palette: Record<string, string> = {};
  for (const [letter, colour] of entries) {
    if (!LETTER.test(letter)) throw new SpriteSpecError('palette: every key is one ASCII letter');
    if (typeof colour !== 'string' || !COLOUR.test(colour)) throw new SpriteSpecError(`palette.${letter}: a colour #rrggbb`);
    palette[letter] = colour.toLowerCase();
  }
  for (const [letter, meaning] of Object.entries(REQUIRED_LETTERS)) {
    if (palette[letter] === undefined) throw new SpriteSpecError(`palette: "${letter}" (${meaning}) is required`);
  }
  return palette;
}

function checkPiece(value: unknown, rows: number, palette: Record<string, string>, where: string): string[] {
  if (!Array.isArray(value) || value.length !== rows) throw new SpriteSpecError(`${where}: ${String(rows)} rows`);
  let drawn = 0;
  const lines = value.map((line: unknown, index) => {
    if (typeof line !== 'string' || line.length !== WIDTH) throw new SpriteSpecError(`${where}[${String(index)}]: ${String(WIDTH)} characters`);
    for (const letter of line) {
      if (letter === '.') continue;
      if (!LETTER.test(letter) || palette[letter] === undefined) throw new SpriteSpecError(`${where}[${String(index)}]: a letter that is not in the palette`);
      drawn += 1;
    }
    return line;
  });
  if (drawn < MIN_PIXELS) throw new SpriteSpecError(`${where}: at least ${String(MIN_PIXELS)} drawn pixels`);
  return lines;
}

const hasEyes = (rows: readonly string[]): boolean => rows.some((line) => line.includes('e'));

/** Every field of a parsed answer, or SpriteSpecError with the first rule it breaks. */
export function checkSprite(value: unknown): SpriteSpec {
  if (!isRecord(value)) throw new SpriteSpecError('the answer is not a JSON object');
  onlyKeys(value, ['palette', 'head', 'body', 'legs'], 'answer');
  const palette = checkPalette(value.palette);
  const group = <G extends Group>(name: G): Record<(typeof VIEWS)[G][number], string[]> => {
    const raw = value[name];
    if (!isRecord(raw)) throw new SpriteSpecError(`${name}: expected an object`);
    onlyKeys(raw, VIEWS[name], name);
    return Object.fromEntries(VIEWS[name].map((view) => [view, checkPiece(raw[view], PIECE_ROWS[name], palette, `${name}.${view}`)])) as Record<(typeof VIEWS)[G][number], string[]>;
  };
  const head = group('head');
  if (!hasEyes(head.front) || !hasEyes(head.side)) throw new SpriteSpecError('head.front and head.side: the eyes ("e") are required');
  if (hasEyes(head.back)) throw new SpriteSpecError('head.back: no eyes ("e") seen from behind');
  return { palette, head, body: group('body'), legs: group('legs') };
}

/**
 * The model's text as a sprite: the JSON object alone, or inside one code
 * fence. A value already parsed (constrained decoding) is checked as it is.
 */
export function readSpriteReply(reply: unknown): SpriteSpec {
  if (typeof reply !== 'string') return checkSprite(reply);
  if (Buffer.byteLength(reply, 'utf8') > MAX_REPLY_BYTES) throw new SpriteSpecError(`the answer is over ${String(MAX_REPLY_BYTES / 1024)} KiB`);
  const fenced = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(reply);
  let value: unknown;
  try {
    value = JSON.parse(fenced?.[1] ?? reply);
  } catch {
    throw new SpriteSpecError('the answer is not JSON');
  }
  return checkSprite(value);
}

// The poses, derived from the parts.

// Rows are checked ASCII: one character is one pixel.
const grid = (rows: readonly string[]): string[][] => rows.map((line) => line.split(''));
const lines = (cells: readonly string[][]): string[] => cells.map((row) => row.join(''));

/** Pixels set over a copy: `[row, column, letter]`. */
function paint(rows: readonly string[], pixels: readonly (readonly [number, number, string])[]): string[] {
  const cells = grid(rows);
  for (const [y, x, letter] of pixels) {
    const row = cells[y];
    if (row !== undefined && x >= 0 && x < WIDTH) row[x] = letter;
  }
  return lines(cells);
}

const NOT_FILL = new Set(['e', 'E', 'o', '.']);

/** The colour around an eye: the most frequent neighbour that is face, never outline or transparent. */
function fillAt(cells: readonly string[][], y: number, x: number): string {
  const counts = new Map<string, number>();
  for (const [dy, dx] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    const letter = cells[y + dy]?.[x + dx];
    if (letter !== undefined && !NOT_FILL.has(letter)) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  }
  let best = 's';
  let most = 0;
  for (const [letter, count] of counts) {
    if (count > most) [best, most] = [letter, count];
  }
  return best;
}

/** The eyes one pixel away; unchanged when one would land on the outline, outside or off the head. */
export function moveEyes(rows: readonly string[], dy: number, dx: number): string[] {
  const cells = grid(rows);
  const eyes: [number, number][] = [];
  cells.forEach((row, y) => {
    row.forEach((letter, x) => {
      if (letter === 'e') eyes.push([y, x]);
    });
  });
  const out = grid(rows);
  for (const [y, x] of eyes) (out[y] ?? [])[x] = fillAt(cells, y, x);
  for (const [y, x] of eyes) {
    const target = cells[y + dy]?.[x + dx];
    if (target === undefined || target === '.' || target === 'o') return [...rows];
    (out[y + dy] ?? [])[x + dx] = 'e';
  }
  return lines(out);
}

const closeEyes = (rows: readonly string[]): string[] => rows.map((line) => line.replaceAll('e', 'E'));

/** One half of the legs lifted by a pixel: a step. */
function lift(rows: readonly string[], half: 'left' | 'right'): string[] {
  const [from, to] = half === 'left' ? [0, WIDTH / 2] : [WIDTH / 2, WIDTH];
  return rows.map((line, index) => {
    const below = rows[index + 1] ?? '.'.repeat(WIDTH);
    return line.slice(0, from) + below.slice(from, to) + line.slice(to);
  });
}

const s = 's';
/** Hands on the keyboard, one higher than the other, then swapped. */
const typeFront = (body: readonly string[], swap: boolean): string[] => {
  const [left, right] = swap ? [5, 4] : [4, 5];
  return paint(body, [[left, 4, s], [left, 5, s], [right, 10, s], [right, 11, s]]);
};
/** A sheet of paper held in both hands; the line read moves. */
const readFront = (body: readonly string[], second: boolean): string[] =>
  paint(body, [
    ...[5, 6, 7, 8, 9, 10].flatMap((x) => [[3, x, PAPER] as const, [5, x, PAPER] as const]),
    ...(second ? '111221' : '122111').split('').map((letter, index) => [4, 5 + index, letter] as const),
    [4, 4, s],
    [4, 11, s],
  ]);
const thinkFront = (body: readonly string[]): string[] => paint(body, [[0, 9, s], [0, 10, s], [1, 10, s]]);
const typeSide = (body: readonly string[], row: number): string[] => paint(body, [[row, 11, s], [row, 12, s]]);
const readSide = (body: readonly string[], row: number): string[] => paint(body, [[3, 11, PAPER], [3, 12, PAPER], [4, 11, PAPER], [4, 12, PAPER], [row, 12, LINE]]);

/** The right arm raised, waiting for the user: Arianna's shape, in outline and skin. */
const ARM = ['..............oo', ...Array.from({ length: 6 }, () => '.............oso')];
const OVER_WAIT: Part = { top: 10, rows: [...ARM, '............oso.', '............oso.'] };
const OVER_WAIT2: Part = { top: 9, rows: [...ARM, '.............oso', '............oso.', '............oso.'] };

/** The parts of every pose, from the nine of the model. */
export function spriteArt(spec: SpriteSpec, id = 'generated'): CharacterArt {
  const { head, body, legs } = spec;
  const at = (top: number, rows: readonly string[]): Part => ({ top, rows });
  const H = (rows: readonly string[]) => at(HEAD_TOP, rows);
  const B = (rows: readonly string[]) => at(BODY_TOP, rows);
  const L = (rows: readonly string[]) => at(LEGS_TOP, rows);
  const walking = { legs: L(legs.front), 'legs-step1': L(lift(legs.front, 'left')), 'legs-step2': L(lift(legs.front, 'right')) };
  return {
    id,
    palette: { ...spec.palette, ...OWN_COLOURS },
    parts: {
      down: {
        head: H(head.front),
        'head-blink': H(closeEyes(head.front)),
        'head-sleep': H(closeEyes(head.front)),
        'head-work': H(moveEyes(head.front, 1, 0)),
        'head-read': H(moveEyes(head.front, 1, 0)),
        'head-read2': H(moveEyes(head.front, 1, -1)),
        'head-up': H(moveEyes(head.front, -1, 0)),
        'head-up2': H(moveEyes(head.front, -1, 1)),
        body: B(body.front),
        'body-type': B(typeFront(body.front, false)),
        'body-type2': B(typeFront(body.front, true)),
        'body-read': B(readFront(body.front, false)),
        'body-read2': B(readFront(body.front, true)),
        'body-think': B(thinkFront(body.front)),
        'over-wait': OVER_WAIT,
        'over-wait2': OVER_WAIT2,
        ...walking,
      },
      up: { head: H(head.back), body: B(body.back), ...walking },
      right: {
        head: H(head.side),
        'head-blink': H(closeEyes(head.side)),
        'head-work': H(moveEyes(head.side, 1, 0)),
        body: B(body.side),
        'body-type': B(typeSide(body.side, 3)),
        'body-type2': B(typeSide(body.side, 4)),
        'body-read': B(readSide(body.side, 3)),
        'body-read2': B(readSide(body.side, 4)),
        legs: L(legs.side),
        'legs-step1': L(legs.stride),
        'legs-step2': L(legs.stride),
      },
    },
  };
}

/** The sheet of a checked sprite: 112×128, four rows. */
export function spriteSheet(spec: SpriteSpec): { png: Buffer; rows: 4 } {
  const { width, height, rgba } = renderSheet(spriteArt(spec));
  return { png: encodePng({ width, height, rgba }), rows: 4 };
}
