// The office of the themes (D-216): the Sacro Cuore with Scrubs, the Dunder
// Mifflin with The Office, the house of the Smiths with American Dad (D-239),
// Base as it was pixel for pixel.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { COLOR_TOKENS, THEME_TOKENS, type Scene } from '../src/lib/office/draw.ts';
import { boardPoint, decisionsPoint, archivePoint, tilesNear, DESK_WALK_REACH, WALK_REACH, type OfficeMap } from '../src/lib/office/map.ts';
import { findPath } from '../src/lib/office/path.ts';
import { OFFICE_SKINS, officeMapOf, officeView, SKIN_INK, skinColors, skinOfTheme, type OfficeSkin } from '../src/lib/office/skins.ts';
import { colorsOf, rasterize } from './support/office-raster.ts';

const HUD = join(import.meta.dirname, '..');
const css = readFileSync(join(HUD, 'src', 'style.css'), 'utf8');
const TEXTS = Object.fromEntries(OFFICE_SKINS.map((skin) => [skin, readFileSync(join(HUD, 'src', 'office', 'maps', `${skin}.json`), 'utf8')])) as Record<OfficeSkin, string>;

function mapOf(skin: OfficeSkin): OfficeMap {
  const { map, problem, fallback } = officeMapOf(skin, TEXTS);
  assert.ok(map !== null, `${skin}: ${String(problem)}`);
  assert.equal(fallback, false, skin);
  return map;
}

function scene(skin: OfficeSkin | undefined, mode: 'dark' | 'light'): Scene {
  const map = mapOf(skin ?? 'base');
  return {
    map,
    colors: skinColors(colorsOf(css, mode, COLOR_TOKENS, THEME_TOKENS), skin ?? 'base'),
    now: 0,
    reduceMotion: true,
    islandRugs: ['l1', 'l2', null, null, null, null],
    screens: new Set(['3,3']),
    figures: [],
    decisionsWaiting: true,
    boardNear: true,
    ...(skin === undefined ? {} : { skin }),
  };
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('the theme chooses the place: Scrubs the Sacro Cuore, The Office the Dunder Mifflin, anything else the base office', () => {
  assert.equal(skinOfTheme('corsia'), 'corsia');
  assert.equal(skinOfTheme('ufficio'), 'ufficio');
  assert.equal(skinOfTheme('springfield'), 'springfield');
  assert.equal(skinOfTheme('quahog'), 'quahog');
  assert.equal(skinOfTheme('langley'), 'langley');
  for (const other of [undefined, 'base', 'natale', 'Corsia', '', 'constructor']) assert.equal(skinOfTheme(other), 'base', String(other));
  assert.equal(skinOfTheme('fox-river'), 'fox-river');
  for (const other of [undefined, 'base', 'natale', 'Corsia', 'Fox-River', 'fox', '', 'constructor']) assert.equal(skinOfTheme(other), 'base', String(other));
});

test('Base is drawn the same, pixel for pixel, with or without the skin named (D-216, D-229)', () => {
  // The drawing of the base office, measured on the same canvas. Measure them again (and say why in the
  // commit) only when the base office changes on purpose: the --office-* colours of style.css or base.json.
  // Measured again for D-229: the base office with rooms, walls and doors.
  const before = { dark: '16a3fac0d63551d8f94e6fafe89b08ba53dcc2f42c250f51a28e385ef86913c3', light: '742d5163ae6fe760e9644fe48ab83d106d46f2c94e2508a7c7f319ff7e3c5bce' };
  for (const mode of ['dark', 'light'] as const) {
    assert.equal(sha(rasterize(scene(undefined, mode)).rgba), before[mode], mode);
    assert.equal(sha(rasterize(scene('base', mode)).rgba), before[mode], mode);
  }
  const colors = colorsOf(css, 'dark', COLOR_TOKENS, THEME_TOKENS);
  assert.equal(skinColors(colors, 'base'), colors, 'Base keeps the very colours of the page');
});

test('the places are drawn differently from Base and from each other, in light and dark', () => {
  for (const mode of ['dark', 'light'] as const) {
    const hashes = OFFICE_SKINS.map((skin) => sha(rasterize(scene(skin, mode)).rgba));
    assert.equal(new Set(hashes).size, OFFICE_SKINS.length, mode);
  }
  const page = colorsOf(css, 'light', COLOR_TOKENS, THEME_TOKENS);
  const corsia = skinColors(page, 'corsia');
  assert.notEqual(corsia.floor, page.floor);
  // The tokens of the theme (accent, warn…) stay those of the page.
  for (const token of THEME_TOKENS) assert.equal(corsia[token], page[token], token);
  // Light or dark as the page is.
  assert.notEqual(skinColors(colorsOf(css, 'dark', COLOR_TOKENS, THEME_TOKENS), 'ufficio').floor, skinColors(page, 'ufficio').floor);
  // The cross of the hospital is green, never red on white (D-103).
  const [r, g] = [Number.parseInt(SKIN_INK.cross.slice(1, 3), 16), Number.parseInt(SKIN_INK.cross.slice(3, 5), 16)];
  assert.ok(g > r * 2);
});

test('the power plant of Springfield (D-237): its own colours in light and dark, the theme tokens untouched, the hazard stripe on the plain walls only', () => {
  const page = colorsOf(css, 'light', COLOR_TOKENS, THEME_TOKENS);
  const plant = skinColors(page, 'springfield');
  assert.notEqual(plant.floor, page.floor);
  assert.notEqual(plant.floor, skinColors(page, 'ufficio').floor);
  for (const token of THEME_TOKENS) assert.equal(plant[token], page[token], token);
  assert.notEqual(skinColors(colorsOf(css, 'dark', COLOR_TOKENS, THEME_TOKENS), 'springfield').floor, plant.floor);
  // The yellow of the stripe is in the drawing of the plant, never in the other places.
  const hasYellow = (skin: OfficeSkin): boolean => {
    const { rgba } = rasterize(scene(skin, 'light'));
    for (let at = 0; at < rgba.length; at += 4) if (rgba[at] === 0xf2 && rgba[at + 1] === 0xc2 && rgba[at + 2] === 0x00) return true;
    return false;
  };
  assert.equal(hasYellow('springfield'), true);
  for (const skin of ['base', 'corsia', 'ufficio'] as const) assert.equal(hasYellow(skin), false, skin);
});

test('islands, desks, cardwall, Decisioni and the archive keep their place in every office, and every one is reached from the entrance', () => {
  const base = mapOf('base');
  for (const skin of OFFICE_SKINS) {
    const map = mapOf(skin);
    assert.deepEqual(map.anchors, base.anchors, `${skin}: the projects stay in the same islands`);
    assert.ok(boardPoint(map) !== null, `${skin}: the cardwall hangs on a wall`);
    const entrance = map.anchors.entrance;
    for (const island of [map.anchors.private, ...map.anchors.islands]) assert.ok(findPath(map, entrance, [island.seat]) !== null, `${skin}: seat ${island.seat.join(',')}`);
    const decisions = decisionsPoint(map);
    assert.ok(findPath(map, entrance, tilesNear(map, decisions[0], decisions[1], DESK_WALK_REACH)) !== null, `${skin}: Decisioni`);
    const archive = archivePoint(map);
    assert.ok(findPath(map, entrance, tilesNear(map, archive[0], archive[1], WALK_REACH)) !== null, `${skin}: archive`);
    for (const seat of map.anchors.pause.seats) assert.ok(findPath(map, entrance, [seat]) !== null, `${skin}: pause ${seat.join(',')}`);
  }
});

test('a place whose map does not pass falls back on the base map with its colours; a broken base map is an error', () => {
  const broken = { ...TEXTS, corsia: '{ "format": 2 }' };
  const fallback = officeMapOf('corsia', broken);
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.map?.id, 'base');
  assert.match(fallback.problem ?? '', /manca/);
  const none = officeMapOf('base', { ...TEXTS, base: 'nope' });
  assert.equal(none.map, null);
  assert.ok(none.problem !== null);
  const both = officeMapOf('ufficio', { ...TEXTS, base: 'nope', ufficio: 'nope' });
  assert.deepEqual([both.map, both.fallback], [null, true]);
  // A map whose private room lost its door is refused like any other (the validator of D-106, D-229).
  const walled = TEXTS.ufficio.replace('"#WWOOTTTTBOO', '"#WW##TTTTBOO');
  assert.notEqual(walled, TEXTS.ufficio);
  assert.equal(officeMapOf('ufficio', { ...TEXTS, ufficio: walled }).fallback, true);
});

test('the page shows the office with a notice when the base map stands in, the error alone without any map', () => {
  const own = officeView(officeMapOf('corsia', TEXTS));
  assert.ok(own.kind === 'office');
  assert.equal(own.map.id, 'corsia');
  assert.equal(own.notice, null);
  // The fallback: the office is there, with the notice above it (the bug of the first version showed the notice alone).
  const fallback = officeView(officeMapOf('corsia', { ...TEXTS, corsia: '{}' }));
  assert.ok(fallback.kind === 'office');
  assert.equal(fallback.map.id, 'base');
  assert.match(fallback.notice ?? '', /^La pianta del tema non è valida \(.+\): l'ufficio usa quella di base con i colori del tema\.$/);
  const broken = officeView(officeMapOf('base', { ...TEXTS, base: 'nope' }));
  assert.ok(broken.kind === 'error');
  assert.match(broken.text, /^La mappa dell'ufficio non è valida: /);
});

test('Fox River (D-240): its own colours over the page, light or dark as the page is, the theme tokens kept; the base map takes its place when its map breaks', () => {
  const light = colorsOf(css, 'light', COLOR_TOKENS, THEME_TOKENS);
  const dark = colorsOf(css, 'dark', COLOR_TOKENS, THEME_TOKENS);
  const prison = skinColors(light, 'fox-river');
  assert.notEqual(prison.floor, light.floor);
  assert.notEqual(skinColors(dark, 'fox-river').floor, prison.floor);
  for (const token of THEME_TOKENS) assert.equal(prison[token], light[token], token);
  assert.equal(mapOf('fox-river').id, 'fox-river');
  // Two barred windows more than in Base, on the corridor's wall; the same anchors (the test above).
  const windows = (map: OfficeMap): number => map.tiles.filter((kind) => kind === 'window').length;
  assert.equal(windows(mapOf('fox-river')), windows(mapOf('base')) + 2);
  const broken = officeMapOf('fox-river', { ...TEXTS, 'fox-river': '{}' });
  assert.deepEqual([broken.fallback, broken.map?.id], [true, 'base']);
});
