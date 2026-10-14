import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';

import { checkArt, dress, renderSheet, type CharacterArt, type Costume, type Part } from '../characters/compose.ts';
import { APP_ICONS, COSTUMED, headIconPng, NOTIFICATION_ICON, notificationIconPng, ORIGINALS, PACK_DIR, publicPath, SERIES, SERIES_DIR, SHEETS, sheetPng } from '../characters/originals.ts';

/** Every sheet built from the maps: the pack of the originals and the people of the series (D-211). */
const ALL: readonly CharacterArt[] = [...SHEETS, ...SERIES.map(({ art }) => art)];
import { encodePng } from '../characters/png.ts';

test('the sheets in git are the ones the pixel maps give, costumes of the themes included (run node apps/hud/characters/build.ts after a change)', () => {
  for (const art of SHEETS) {
    assert.deepEqual(readFileSync(join(PACK_DIR, `${art.id}.png`)), sheetPng(art), art.id);
  }
});

test('the sheets of the people of the series are the ones their maps give, and pack.json lists them with their name (D-211)', () => {
  for (const { art } of SERIES) assert.deepEqual(readFileSync(join(SERIES_DIR, `${art.id}.png`)), sheetPng(art), art.id);
  const pack = JSON.parse(readFileSync(join(SERIES_DIR, 'pack.json'), 'utf8')) as { source: string; characters: { id: string; name: string; file: string }[] };
  assert.deepEqual(
    pack.characters.map(({ id, name, file }) => [id, name, file]),
    SERIES.map(({ art, name }) => [art.id, name, `${art.id}.png`]),
  );
  // The pack says what it is and that it goes away before the repository is shared.
  assert.match(pack.source, /uso personale/);
  assert.match(pack.source, /condividere/);
  // No id taken twice across the two packs in git: a theme names "<pack>/<id>", the gallery shows both.
  assert.equal(new Set(ALL.map(({ id }) => id)).size, ALL.length);
});

test('every person of the series has all the poses, and they differ where they must (D-211)', () => {
  for (const { art } of SERIES) {
    const { width, rgba } = renderSheet(art);
    const frame = (row: number, column: number) => {
      const pixels: number[] = [];
      for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) pixels.push(...rgba.subarray(((row * 32 + y) * width + column * 16 + x) * 4, ((row * 32 + y) * width + column * 16 + x) * 4 + 4));
      return pixels.join(',');
    };
    // Walking, typing and reading change the frame, in every direction; blinking, thinking and waiting too.
    for (let row = 0; row < 3; row++) {
      assert.notEqual(frame(row, 0), frame(row, 1), `${art.id} row ${String(row)} walk`);
      assert.notEqual(frame(row, 3), frame(row, 1), `${art.id} row ${String(row)} type`);
    }
    for (const row of [0, 2]) assert.notEqual(frame(row, 5), frame(row, 1), `${art.id} row ${String(row)} read`);
    assert.notEqual(frame(3, 6), frame(0, 1), `${art.id} blink`);
    assert.notEqual(frame(3, 0), frame(0, 1), `${art.id} think`);
    assert.notEqual(frame(3, 2), frame(0, 1), `${art.id} wait`);
  }
});

test('the icon of the notifications in git is the head of Arianna the pixel maps give (I-1)', () => {
  assert.deepEqual(readFileSync(NOTIFICATION_ICON), notificationIconPng());
});

test('the icons of the installed app in git are the head the pixel maps give, and the manifest lists them (D-126)', () => {
  for (const icon of APP_ICONS) {
    assert.deepEqual(readFileSync(publicPath(icon.file)), headIconPng(icon.size, icon.scale), icon.file);
    assert.ok(16 * icon.scale <= icon.size, icon.file);
    // A maskable icon keeps only a safe circle of 80% of the side: the whole head stays inside it.
    if (icon.purpose === 'maskable') assert.ok(16 * icon.scale * Math.SQRT2 <= 0.8 * icon.size, icon.file);
  }
  const manifest = JSON.parse(readFileSync(publicPath('manifest.webmanifest'), 'utf8')) as {
    name: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };
  assert.equal(manifest.name, 'Arianna');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(
    manifest.icons.map(({ src, sizes, purpose }) => [src, sizes, purpose]),
    APP_ICONS.map((icon) => [`/${icon.file}`, `${String(icon.size)}x${String(icon.size)}`, icon.purpose]),
  );
});

test('pack.json lists every original sheet and every costume, with its name', () => {
  const pack = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as { characters: { id: string; name: string; file: string }[] };
  assert.deepEqual(
    pack.characters.map(({ id, file }) => [id, file]),
    SHEETS.map((art) => [art.id, `${art.id}.png`]),
  );
  for (const { art, name } of COSTUMED) assert.equal(pack.characters.find((entry) => entry.id === art.id)?.name, name);
});

test('a sheet is 112×128 in the format of pixel-agents, with a fourth row', () => {
  for (const art of ALL) {
    const png = sheetPng(art);
    assert.equal(png.readUInt32BE(16), 112);
    assert.equal(png.readUInt32BE(20), 128);
    assert.equal(png[25], 6, 'RGBA');
  }
});

test('every frame has a figure standing on the bottom line', () => {
  for (const art of ALL) {
    const { width, rgba } = renderSheet(art);
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 7; column++) {
        let opaque = 0;
        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 16; x++) if ((rgba[((row * 32 + y) * width + column * 16 + x) * 4 + 3] ?? 0) > 0) opaque += 1;
        }
        assert.ok(opaque > 100, `${art.id} row ${String(row)} column ${String(column)}`);
      }
    }
  }
});

test('the encoder writes pixels a PNG decoder reads back', () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]);
  const png = encodePng(2, 1, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idatAt = png.indexOf('IDAT');
  const length = png.readUInt32BE(idatAt - 4);
  const lines = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + length));
  assert.deepEqual([...lines], [0, ...rgba]);
  assert.throws(() => encodePng(2, 2, rgba), /does not match/);
});

test('checkArt refuses a line of the wrong width, a letter outside the palette, a part outside the frame', () => {
  const base = ORIGINALS[0];
  assert.ok(base !== undefined);
  const withPart = (part: { top: number; rows: string[] }): CharacterArt => ({
    ...base,
    parts: { ...base.parts, down: { ...base.parts.down, head: part } },
  });
  assert.throws(() => { checkArt(withPart({ top: 0, rows: ['....'] })); }, /4 columns/);
  assert.throws(() => { checkArt(withPart({ top: 0, rows: ['Z...............'] })); }, /not in the palette/);
  assert.throws(() => { checkArt(withPart({ top: 31, rows: ['................', '................'] })); }, /outside the frame/);
  assert.doesNotThrow(() => { checkArt(base); });
});

test('a missing part is an error, a missing overlay is not', () => {
  const base = ORIGINALS[1];
  assert.ok(base !== undefined);
  const without = (parts: Readonly<Record<string, Part>>, names: string[]) =>
    Object.fromEntries(Object.entries(parts).filter(([name]) => !names.includes(name)));
  assert.throws(() => renderSheet({ ...base, parts: { ...base.parts, right: without(base.parts.right, ['legs']) } }), /"legs" is missing/);
  assert.doesNotThrow(() => renderSheet({ ...base, parts: { ...base.parts, down: without(base.parts.down, ['over-wait', 'over-wait2']) } }));
});

const ARIANNA = ORIGINALS[0] as CharacterArt;
const cap = (top = 6): Part => ({ top, rows: ['.....oooooo.....'] });
const costume = (layers: Costume['layers'], extra: Partial<Costume> = {}): Costume => ({ theme: 'prova', layers, ...extra });

test('a costume of a theme is drawn on every pose, in all three directions, and moves with its layer (D-103)', () => {
  const layer = { name: 'cap', after: 'head' as const, part: cap(0) };
  const dressed = dress(ARIANNA, costume({ down: [layer], up: [layer], right: [layer] }));
  assert.equal(dressed.id, 'arianna-prova');
  const { width, rgba } = renderSheet(dressed);
  const opaque = (row: number, column: number, y: number) => (rgba[((row * 32 + y) * width + column * 16 + 7) * 4 + 3] ?? 0) > 0;
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 7; column++) {
      // The pause frame nods the head one line down, and the cap with it.
      const nod = row === 3 && column === 5 ? 1 : 0;
      assert.ok(opaque(row, column, nod), `row ${String(row)} column ${String(column)}`);
    }
  }
  // The original has nothing on the top line.
  const plain = renderSheet(ARIANNA).rgba;
  assert.ok(![...Array(7).keys()].some((column) => (plain[(column * 16 + 7) * 4 + 3] ?? 0) > 0));
});

test('a costume layer skips the frames named in skip (D-103)', () => {
  const tie = { name: 'tie', after: 'body' as const, skip: ['body-read'], part: { top: 0, rows: ['.......o........'] } };
  const { rgba } = renderSheet(dress(ARIANNA, costume({ down: [tie], up: [tie], right: [tie] })));
  const opaque = (column: number) => (rgba[(column * 16 + 7) * 4 + 3] ?? 0) > 0;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(opaque), [true, true, true, true, true, false, false]);
});

test('a costume by half, a recolor of a letter the character lacks or a new letter that is already its own are refused (D-103)', () => {
  const layer = { name: 'cap', after: 'head' as const, part: cap() };
  assert.throws(() => dress(ARIANNA, costume({ down: [layer], up: [layer], right: [] })), /down, up and right/);
  assert.throws(() => dress(ARIANNA, costume({ down: [layer, layer], up: [layer, layer], right: [layer, layer] })), /named twice/);
  const whole = { down: [layer], up: [layer], right: [layer] };
  assert.throws(() => dress(ARIANNA, costume(whole, { recolor: { Z: '#ffffff' } })), /not in the palette/);
  assert.throws(() => dress(ARIANNA, costume(whole, { recolor: { d: 'red' } })), /#rrggbb/);
  assert.throws(() => dress(ARIANNA, costume(whole, { palette: { d: '#ffffff' } })), /use recolor/);
  const stray = { ...layer, part: { top: 0, rows: ['Z...............'] } };
  assert.throws(() => renderSheet(dress(ARIANNA, costume({ down: [stray], up: [layer], right: [layer] }))), /not in the palette/);
  assert.doesNotThrow(() => renderSheet(dress(ARIANNA, costume(whole, { recolor: { d: '#5f9fd8' }, palette: { c: '#6aa8de' } }))));
});
