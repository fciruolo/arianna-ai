// The theme «I Griffin» (D-238): its characters in the pack `serie`, the
// Griffin house with the Drunken Clam in the pixel office, and its 3D view.
// The tests shared with the other themes (contrast, map, anchors, PNGs) cover
// it as well; here what is its own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { GRIFFIN } from '../characters/art/serie/griffin.ts';
import { SERIES } from '../characters/originals.ts';
import { COLOR_TOKENS, THEME_TOKENS } from '../src/lib/office/draw.ts';
import { parseMapText, tileAt, type OfficeMap } from '../src/lib/office/map.ts';
import { skinColors } from '../src/lib/office/skins.ts';
import { buildWorld } from '../src/lib/office/world3d.ts';
import { colorsOf } from './support/office-raster.ts';

const HUD = join(import.meta.dirname, '..');
const css = readFileSync(join(HUD, 'src', 'style.css'), 'utf8');
const theme = JSON.parse(readFileSync(join(HUD, 'themes', 'quahog', 'theme.json'), 'utf8')) as { id: string; name: string; kind: string; characters: Record<string, string> };

function quahogMap(): OfficeMap {
  const result = parseMapText(readFileSync(join(HUD, 'src', 'office', 'maps', 'quahog.json'), 'utf8'));
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.map;
}

test('the theme I Griffin dresses every agent as someone of the family, all in the pack serie (D-238)', () => {
  assert.deepEqual([theme.id, theme.name, theme.kind], ['quahog', 'I Griffin', 'serie']);
  assert.deepEqual(theme.characters, {
    arianna: 'serie/lois',
    coder: 'serie/peter',
    god: 'serie/stewie',
    reviewer: 'serie/brian',
    finanze: 'serie/meg',
    designer: 'serie/chris',
    'local-chat': 'serie/cleveland',
  });
  // The seven people are at the end of the pack, in the order of the file of the series.
  assert.deepEqual(
    SERIES.slice(-GRIFFIN.length).map(({ art, name }) => [art.id, name]),
    GRIFFIN.map(({ art, name }) => [art.id, name]),
  );
});

test('the Griffin house has its own colours, light or dark as the page, the theme tokens untouched (D-238)', () => {
  const light = colorsOf(css, 'light', COLOR_TOKENS, THEME_TOKENS);
  const dark = colorsOf(css, 'dark', COLOR_TOKENS, THEME_TOKENS);
  assert.notEqual(skinColors(light, 'quahog').floor, light.floor);
  assert.notEqual(skinColors(light, 'quahog').floor, skinColors(dark, 'quahog').floor);
  for (const token of THEME_TOKENS) assert.equal(skinColors(light, 'quahog')[token], light[token], token);
});

test('in 3D the Griffin house has floorboards of one colour, no handrail and a television on its cabinet (D-238)', () => {
  const map = quahogMap();
  const world = buildWorld(map, 'quahog');
  assert.ok(world.floors.every((tile) => !tile.alt));
  assert.equal(world.blocks.filter((block) => block.color === 'wall-line' && block.y > 0.2).length, 0);
  // Every coffee tile is a television: a screen block over a low cabinet.
  const coffee: [number, number][] = [];
  for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) if (tileAt(map, c, r) === 'coffee') coffee.push([c, r]);
  assert.ok(coffee.length > 0);
  for (const [c, r] of coffee) {
    const here = world.blocks.filter((block) => Math.abs(block.x - (c + 0.5)) < 0.01 && Math.abs(block.z - (r + 0.5)) < 0.01);
    assert.deepEqual(here.map((block) => block.color), ['desk', 'monitor', 'screen'], `${String(c)},${String(r)}`);
  }
  // Base keeps its coffee machine.
  assert.equal(buildWorld(map, 'base').blocks.filter((block) => block.color === 'screen').length, coffee.length);
});
