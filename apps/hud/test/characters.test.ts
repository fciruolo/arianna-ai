import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';

import { checkArt, renderSheet, type CharacterArt, type Part } from '../characters/compose.ts';
import { NOTIFICATION_ICON, notificationIconPng, ORIGINALS, PACK_DIR, sheetPng } from '../characters/originals.ts';
import { encodePng } from '../characters/png.ts';

test('the sheets in git are the ones the pixel maps give (run node apps/hud/characters/build.ts after a change)', () => {
  for (const art of ORIGINALS) {
    assert.deepEqual(readFileSync(join(PACK_DIR, `${art.id}.png`)), sheetPng(art), art.id);
  }
});

test('the icon of the notifications in git is the head of Arianna the pixel maps give (I-1)', () => {
  assert.deepEqual(readFileSync(NOTIFICATION_ICON), notificationIconPng());
});

test('pack.json lists every original sheet', () => {
  const pack = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as { characters: { id: string; file: string }[] };
  assert.deepEqual(
    pack.characters.map(({ id, file }) => [id, file]),
    ORIGINALS.map((art) => [art.id, `${art.id}.png`]),
  );
});

test('a sheet is 112×128 in the format of pixel-agents, with a fourth row', () => {
  for (const art of ORIGINALS) {
    const png = sheetPng(art);
    assert.equal(png.readUInt32BE(16), 112);
    assert.equal(png.readUInt32BE(20), 128);
    assert.equal(png[25], 6, 'RGBA');
  }
});

test('every frame has a figure standing on the bottom line', () => {
  for (const art of ORIGINALS) {
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
