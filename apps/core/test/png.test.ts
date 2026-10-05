import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';

import { resolveHome } from '@arianna/config';

import { decodePng, encodePng } from '../src/png.ts';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CODER = readFileSync(join(resolveHome({}), 'apps', 'hud', 'characters', 'originali', 'coder.png'));

function chunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function ihdr(width: number, height: number, depth: number, colour: number, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = depth;
  data[9] = colour;
  data[12] = interlace;
  return chunk('IHDR', data);
}

/** A PNG from raw scanlines (filter byte included), with the chunks given between IHDR and IDAT. */
function png(header: Buffer, lines: number[][], extra: Buffer[] = [], after: Buffer[] = []): Buffer {
  return Buffer.concat([SIGNATURE, header, ...extra, chunk('IDAT', deflateSync(Buffer.from(lines.flat()))), ...after, chunk('IEND')]);
}

/** The sheets are at most 128 pixels per side: the bound the core uses. */
const decode = (file: Buffer) => decodePng(file, 128);
const pixels = (image: { rgba: Uint8Array }): number[] => [...image.rgba];

test('decodePng reads the originals, and encodePng writes the same pixels back', () => {
  const image = decode(CODER);
  assert.deepEqual([image.width, image.height], [112, 128]);
  const again = decode(encodePng(image));
  assert.deepEqual(pixels(again), pixels(image));
});

test('decodePng: every colour type, low bit depths and the five line filters', () => {
  // RGBA 8 bit, 2×2: filter None then Sub.
  const rgba = decode(png(ihdr(2, 2, 8, 6), [[0, 10, 20, 30, 255, 1, 2, 3, 255], [1, 10, 20, 30, 128, 5, 5, 5, 0]]));
  assert.deepEqual(pixels(rgba), [10, 20, 30, 255, 1, 2, 3, 255, 10, 20, 30, 128, 15, 25, 35, 128]);
  // Up, Average, Paeth on a 1×3 grey image.
  const grey = decode(png(ihdr(1, 3, 8, 0), [[0, 100], [2, 5], [4, 1]]));
  assert.deepEqual(pixels(grey), [100, 100, 100, 255, 105, 105, 105, 255, 106, 106, 106, 255]);
  const average = decode(png(ihdr(2, 2, 8, 0), [[0, 10, 20], [3, 1, 1]]));
  assert.deepEqual(pixels(average).filter((_v, index) => index % 4 === 0), [10, 20, 6, 14]);
  // Palette of 2 bits with tRNS: index 0 transparent.
  const palette = chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]));
  const indexed = decode(png(ihdr(3, 1, 2, 3), [[0, 0b00011000]], [palette, chunk('tRNS', Buffer.from([0]))]));
  assert.deepEqual(pixels(indexed), [0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255]);
  // Grey 1 bit, grey+alpha, RGB 16 bit with a transparent key.
  assert.deepEqual(pixels(decode(png(ihdr(2, 1, 1, 0), [[0, 0b10000000]]))), [255, 255, 255, 255, 0, 0, 0, 255]);
  assert.deepEqual(pixels(decode(png(ihdr(1, 1, 8, 4), [[0, 50, 60]]))), [50, 50, 50, 60]);
  const key = chunk('tRNS', Buffer.from([0, 1, 0, 2, 0, 3]));
  assert.deepEqual(pixels(decode(png(ihdr(2, 1, 16, 2), [[0, 0, 1, 0, 2, 0, 3, 0x80, 0, 0x40, 0, 0x20, 0]], [key]))), [0, 0, 0, 0, 0x80, 0x40, 0x20, 255]);
});

test('decodePng tolerates the standard metadata chunks; encodePng keeps none of them', () => {
  const file = png(ihdr(1, 1, 8, 6), [[0, 1, 2, 3, 4]], [chunk('pHYs', Buffer.alloc(9)), chunk('tEXt', Buffer.from('Comment\0hidden'))], [chunk('tIME', Buffer.alloc(7))]);
  const clean = encodePng(decode(file));
  assert.equal(clean.includes(Buffer.from('hidden')), false);
  const types: string[] = [];
  for (let at = 8; at < clean.length; at += 12 + clean.readUInt32BE(at)) types.push(clean.toString('latin1', at + 4, at + 8));
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
});

test('decodePng: a fully transparent pixel loses its colour', () => {
  assert.deepEqual(pixels(decode(png(ihdr(1, 1, 8, 6), [[0, 9, 9, 9, 0]]))), [0, 0, 0, 0]);
});

test('decodePng refuses what is not a clean PNG', () => {
  const good = png(ihdr(1, 1, 8, 6), [[0, 1, 2, 3, 4]]);
  const badCrc = Buffer.from(good);
  badCrc[29] = (badCrc[29] ?? 0) ^ 0xff;
  const twoIdat = Buffer.concat([SIGNATURE, ihdr(1, 1, 8, 6), chunk('IDAT', deflateSync(Buffer.from([0, 1]))), chunk('pHYs', Buffer.alloc(9)), chunk('IDAT', deflateSync(Buffer.from([2, 3, 4]))), chunk('IEND')]);
  const cases: [string, Buffer, RegExp][] = [
    ['not a png', Buffer.from('GIF89a and more bytes'), /not a PNG/],
    ['bad checksum', badCrc, /bad checksum/],
    ['private chunk', png(ihdr(1, 1, 8, 6), [[0, 1, 2, 3, 4]], [chunk('prVt', Buffer.from('payload'))]), /unknown chunk prVt/],
    ['data after IEND', Buffer.concat([good, Buffer.from('zip file here')]), /after the end/],
    ['cut short', good.subarray(0, good.length - 6), /cut short/],
    ['IHDR not first', Buffer.concat([SIGNATURE, chunk('pHYs', Buffer.alloc(9)), ihdr(1, 1, 8, 6), chunk('IEND')]), /IHDR must come first/],
    ['interlaced', png(ihdr(1, 1, 8, 6, 1), [[0, 1, 2, 3, 4]]), /interlaced/],
    ['bad depth', png(ihdr(1, 1, 4, 6), [[0, 1, 2]]), /bit depth/],
    ['too large', png(ihdr(5000, 1, 8, 6), [[0]]), /pixels per side/],
    ['short data', png(ihdr(2, 1, 8, 6), [[0, 1, 2, 3, 4]]), /does not match|decompress/],
    ['long data', png(ihdr(1, 1, 8, 6), [[0, 1, 2, 3, 4, 5, 6, 7]]), /does not match|decompress/],
    ['bad filter', png(ihdr(1, 1, 8, 6), [[7, 1, 2, 3, 4]]), /line filter/],
    ['palette missing', png(ihdr(1, 1, 8, 3), [[0, 0]]), /without PLTE/],
    ['index outside palette', png(ihdr(1, 1, 8, 3), [[0, 5]], [chunk('PLTE', Buffer.from([1, 2, 3]))]), /outside the palette/],
    ['IDAT split', twoIdat, /consecutive/],
    ['no IDAT', Buffer.concat([SIGNATURE, ihdr(1, 1, 8, 6), chunk('IEND')]), /no pixel data/],
    ['tRNS with alpha', png(ihdr(1, 1, 8, 6), [[0, 1, 2, 3, 4]], [chunk('tRNS', Buffer.alloc(2))]), /tRNS/],
  ];
  for (const [name, file, reason] of cases) assert.throws(() => decode(file), { name: 'PngError', message: reason }, name);
});
