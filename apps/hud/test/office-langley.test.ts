// The office of the theme Langley (D-239): the house of the Smiths, in 2D and
// in 3D. Fan art of a place of the series for personal use: it goes away with
// the pack `serie`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { COLOR_TOKENS, THEME_TOKENS, type Scene } from '../src/lib/office/draw.ts';
import { LANGLEY_INK, LANGLEY_PALETTE, langleyCabinet } from '../src/lib/office/langley.ts';
import { inRoom, parseMapText, tileAt, type OfficeMap } from '../src/lib/office/map.ts';
import { skinColors, skinOfTheme } from '../src/lib/office/skins.ts';
import { buildWorld } from '../src/lib/office/world3d.ts';
import { colorsOf, rasterize } from './support/office-raster.ts';

const HUD = join(import.meta.dirname, '..');
const css = readFileSync(join(HUD, 'src', 'style.css'), 'utf8');

function mapOf(id: string): OfficeMap {
  const result = parseMapText(readFileSync(join(HUD, 'src', 'office', 'maps', `${id}.json`), 'utf8'));
  assert.ok(result.ok, `${id}: ${result.ok ? '' : result.reason}`);
  return result.map;
}
const LANGLEY = mapOf('langley');

function tiles(map: OfficeMap, kind: string): [number, number][] {
  const found: [number, number][] = [];
  for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) if (tileAt(map, c, r) === kind) found.push([c, r]);
  return found;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('American Dad has the house of the Smiths, with the anchors of the base office', () => {
  assert.equal(skinOfTheme('langley'), 'langley');
  assert.equal(LANGLEY.id, 'langley');
  assert.deepEqual(LANGLEY.anchors, mapOf('base').anchors);
  // Negative: a name that is not the id of the theme is the base office.
  for (const other of ['Langley', 'american-dad', 'langley ']) assert.equal(skinOfTheme(other), 'base', other);
});

test('the cabinets of the house: the files of the CIA in the archive, one bowl of Klaus by the kitchen counter, the television elsewhere', () => {
  const cabinets = tiles(LANGLEY, 'cabinet');
  const kinds = cabinets.map(([c, r]) => langleyCabinet(LANGLEY, c, r));
  assert.equal(kinds.filter((kind) => kind === 'bowl').length, 1);
  for (const [index, [c, r]] of cabinets.entries()) assert.equal(kinds[index] === 'files', inRoom(LANGLEY.anchors.archive.room, c, r), `${String(c)},${String(r)}`);
  assert.ok(kinds.includes('tv'));
  // The bowl is the cabinet closest to the kitchen counter: in this plan the one at 13,6.
  assert.equal(langleyCabinet(LANGLEY, 13, 6), 'bowl');
});

test('the house is drawn in its own colours, light and dark, the theme tokens untouched', () => {
  const scene = (mode: 'dark' | 'light'): Scene => ({
    map: LANGLEY,
    colors: skinColors(colorsOf(css, mode, COLOR_TOKENS, THEME_TOKENS), 'langley'),
    now: 0,
    reduceMotion: true,
    islandRugs: ['l1', null, null, null, null, null],
    screens: new Set(),
    figures: [],
    decisionsWaiting: false,
    boardNear: false,
    skin: 'langley',
  });
  assert.notEqual(sha(rasterize(scene('dark')).rgba), sha(rasterize(scene('light')).rgba));
  const page = colorsOf(css, 'light', COLOR_TOKENS, THEME_TOKENS);
  assert.equal(skinColors(page, 'langley').floor, LANGLEY_PALETTE.light.floor);
  assert.equal(skinColors(colorsOf(css, 'dark', COLOR_TOKENS, THEME_TOKENS), 'langley').floor, LANGLEY_PALETTE.dark.floor);
  for (const token of THEME_TOKENS) assert.equal(skinColors(page, 'langley')[token], page[token], token);
  // The flag is red, white and blue.
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(LANGLEY_INK.red.slice(at, at + 2), 16));
  assert.ok((r ?? 0) > (g ?? 0) * 2 && (r ?? 0) > (b ?? 0) * 2);
});

test('in 3D: a plain wooden floor, no handrail, a tall fridge at every coffee tile', () => {
  const world = buildWorld(LANGLEY, 'langley');
  assert.ok(world.floors.every((tile) => !tile.alt));
  assert.equal(world.blocks.filter((block) => block.color === 'wall-line' && block.y > 0.2).length, 0);
  for (const [c, r] of tiles(LANGLEY, 'coffee')) {
    const here = world.blocks.filter((block) => Math.floor(block.x) === c && Math.floor(block.z) === r);
    assert.ok(here.some((block) => block.color === 'paper' && block.h > 1.2), `${String(c)},${String(r)}`);
  }
  // Negative: the base office keeps its coffee machine.
  const [c0, r0] = tiles(LANGLEY, 'coffee')[0] ?? [0, 0];
  assert.ok(!buildWorld(LANGLEY, 'base').blocks.some((block) => Math.floor(block.x) === c0 && Math.floor(block.z) === r0 && block.color === 'paper'));
});
