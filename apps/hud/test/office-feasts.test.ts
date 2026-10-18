// The decorations of the feasts in the office (D-252, stage 7 of D-106).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { COLOR_TOKENS, THEME_TOKENS, type Scene } from '../src/lib/office/draw.ts';
import { FEAST_STYLE, feastDecor, OFFICE_FEASTS, officeFeast, type OfficeFeast } from '../src/lib/office/feasts.ts';
import { isWall, tileAt, type OfficeMap } from '../src/lib/office/map.ts';
import { officeMapOf, OFFICE_SKINS, skinColors, skinOfTheme, type OfficeSkin } from '../src/lib/office/skins.ts';
import { buildWorld } from '../src/lib/office/world3d.ts';
import { activeTheme, type ChatTheme, type ThemeListing } from '../src/lib/themes.ts';
import { colorsOf, rasterize } from './support/office-raster.ts';

const HUD = join(import.meta.dirname, '..');
const css = readFileSync(join(HUD, 'src', 'style.css'), 'utf8');
const TEXTS = Object.fromEntries(OFFICE_SKINS.map((skin) => [skin, readFileSync(join(HUD, 'src', 'office', 'maps', `${skin}.json`), 'utf8')])) as Record<OfficeSkin, string>;
const BASE = ((): OfficeMap => {
  const { map } = officeMapOf('base', TEXTS);
  assert.ok(map !== null);
  return map;
})();

function theme(id: string, kind: ChatTheme['kind']): ChatTheme {
  return {
    id,
    name: id,
    kind,
    background: { pattern: 'griglia' },
    hud: { corners: true, glow: 'tenue', radius: 'hud' },
    characters: {},
    tokens: { dark: {}, light: {} },
  };
}

const THEMES = [theme('base', 'base'), ...OFFICE_FEASTS.map((id) => theme(id, 'stagionale')), theme('springfield', 'serie'), theme('corsia', 'serie')];
const listing = (chosen: string, current: string, seasonal: boolean): ThemeListing => ({ themes: THEMES, refused: [], chosen, current, seasonal });

test('the feast of the office is the seasonal theme in use, never a theme of the series nor Base', () => {
  for (const feast of OFFICE_FEASTS) assert.equal(officeFeast(theme(feast, 'stagionale')), feast);
  assert.equal(officeFeast(undefined), null);
  assert.equal(officeFeast(theme('base', 'base')), null);
  assert.equal(officeFeast(theme('springfield', 'serie')), null);
  // A theme of the series that took the name of a feast, and a seasonal theme the office does not know.
  assert.equal(officeFeast(theme('natale', 'serie')), null);
  assert.equal(officeFeast(theme('ferragosto', 'stagionale')), null);
  assert.equal(officeFeast(theme('Natale', 'stagionale')), null);
});

test('the office follows the choice of the core (D-246): the feast of the day on Base, none with the feasts off or a theme of the series', () => {
  // Base chosen, the feasts on, Christmas today: the core sends `current: natale`.
  assert.equal(officeFeast(activeTheme(listing('base', 'natale', true))), 'natale');
  // The feasts off: Base stays Base.
  assert.equal(officeFeast(activeTheme(listing('base', 'base', false))), null);
  // A theme of the series chosen by hand is never replaced, and its place has no decorations.
  assert.equal(officeFeast(activeTheme(listing('springfield', 'springfield', true))), null);
  // A feast chosen by hand wears its decorations, on any day.
  assert.equal(officeFeast(activeTheme(listing('halloween', 'halloween', false))), 'halloween');
  assert.equal(officeFeast(activeTheme(null)), null);
  // A feast has no place of its own: its office is the base one.
  for (const feast of OFFICE_FEASTS) assert.equal(skinOfTheme(feast), 'base');
});

test('each feast has its own thing, and the decorations sit where the map allows them', () => {
  assert.equal(new Set(OFFICE_FEASTS.map((feast) => FEAST_STYLE[feast].prop)).size, OFFICE_FEASTS.length);
  const plants = BASE.tiles.filter((kind) => kind === 'plant').length;
  for (const feast of OFFICE_FEASTS) {
    const decor = feastDecor(BASE, feast);
    const style = FEAST_STYLE[feast];
    assert.equal(decor.props.length, Math.ceil(plants / 2), feast);
    for (const [c, r] of decor.props) assert.equal(tileAt(BASE, c, r), 'plant', feast);
    assert.equal(decor.faces.length > 0, style.garland !== null, feast);
    for (const face of decor.faces) {
      const kind = tileAt(BASE, face.c, face.r);
      assert.ok(isWall(kind) && kind !== 'board', `${feast}: ${String(face.c)},${String(face.r)}`);
      assert.ok(!isWall(tileAt(BASE, face.c, face.r + 1)));
    }
    assert.equal(decor.specks.length > 0, style.scatter !== null, feast);
    for (const speck of decor.specks) {
      assert.equal(tileAt(BASE, speck.c, speck.r), 'floor', feast);
      assert.ok(speck.dx >= 0 && speck.dx + 3 <= 16 && speck.dy >= 0 && speck.dy + 3 <= 16, feast);
    }
    assert.deepEqual(feastDecor(BASE, feast), decor, `${feast}: the same at every call`);
  }
});

function scene(feast: OfficeFeast | null, mode: 'dark' | 'light', now = 0, reduceMotion = true): Scene {
  return {
    map: BASE,
    colors: skinColors(colorsOf(css, mode, COLOR_TOKENS, THEME_TOKENS), 'base'),
    now,
    reduceMotion,
    islandRugs: ['l1', 'l2', null, null, null, null],
    screens: new Set(),
    figures: [],
    decisionsWaiting: false,
    boardNear: false,
    skin: 'base',
    decor: feast === null ? null : feastDecor(BASE, feast),
  };
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('without a feast the office is drawn as it was; every feast draws it differently, in light and dark', () => {
  for (const mode of ['dark', 'light'] as const) {
    const plain = { ...scene(null, mode) };
    delete plain.decor;
    assert.equal(sha(rasterize(scene(null, mode)).rgba), sha(rasterize(plain).rgba), mode);
    const hashes = [null, ...OFFICE_FEASTS].map((feast) => sha(rasterize(scene(feast, mode)).rgba));
    assert.equal(new Set(hashes).size, OFFICE_FEASTS.length + 1, mode);
  }
});

test('the fairy lights twinkle, never with reduced motion', () => {
  const at = (now: number, reduce: boolean): string => sha(rasterize(scene('natale', 'dark', now, reduce)).rgba);
  assert.equal(at(0, true), at(5000, true));
  assert.notEqual(at(0, false), at(700, false));
  // Nothing else of the feasts moves.
  for (const feast of OFFICE_FEASTS.filter((item) => item !== 'natale')) assert.equal(sha(rasterize(scene(feast, 'dark', 0, false)).rgba), sha(rasterize(scene(feast, 'dark', 700, false)).rgba), feast);
});

test('in 3D the same decorations: none without a feast, the thing of the feast in place of every other plant', () => {
  assert.deepEqual(buildWorld(BASE, 'base', null), buildWorld(BASE, 'base'));
  const plain = buildWorld(BASE, 'base');
  for (const feast of OFFICE_FEASTS) {
    const decor = feastDecor(BASE, feast);
    const world = buildWorld(BASE, 'base', decor);
    assert.ok(world.blocks.length > plain.blocks.length, feast);
    // The fixed colours of the decorations, never on the furniture of the plain office.
    assert.ok(world.blocks.some((block) => block.color.startsWith('#')), feast);
    assert.ok(!plain.blocks.some((block) => block.color.startsWith('#')));
    for (const [c, r] of decor.props) {
      const own = world.blocks.filter((block) => Math.floor(block.x) === c && Math.floor(block.z) === r);
      assert.ok(own.length > 0 && !own.some((block) => block.color === 'plant'), `${feast}: ${String(c)},${String(r)}`);
      for (const block of own) assert.ok(block.y + block.h <= 1.5, `${feast}: under the walls`);
    }
    assert.deepEqual(world.floors, plain.floors, feast);
  }
});
