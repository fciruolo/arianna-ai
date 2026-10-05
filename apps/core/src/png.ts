import { crc32, deflateSync, inflateSync } from 'node:zlib';

/**
 * A strict PNG decoder and a clean encoder for the character sheets the user
 * uploads (D-118). No dependency: node:zlib inflates and deflates. A file is
 * decoded to plain RGBA pixels and written again from those pixels only, so
 * nothing of the original file but the image survives: no text, no
 * metadata, no extra chunk, nothing after IEND.
 *
 * Accepted: every colour type and bit depth of the PNG standard, not
 * interlaced. Refused: a bad signature or CRC, chunks out of order, unknown
 * chunks (only the standard ancillary ones are tolerated, then dropped),
 * pixel data that does not inflate to exactly the size of the image.
 */
export class PngError extends Error {
  override name = 'PngError';
}

export interface Image {
  width: number;
  height: number;
  /** width × height pixels, four bytes each (RGBA, 8 bits), row by row. */
  rgba: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Standard ancillary chunks an editor may write (colour profile, resolution, text, time): read past, never kept. */
const TOLERATED = new Set(['cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'eXIf', 'tIME', 'tEXt', 'zTXt', 'iTXt']);
const MAX_CHUNKS = 256;
/** Colour type → bit depths allowed, and channels per pixel. */
const COLOUR_TYPES: Readonly<Record<number, { depths: readonly number[]; channels: number }>> = {
  0: { depths: [1, 2, 4, 8, 16], channels: 1 },
  2: { depths: [8, 16], channels: 3 },
  3: { depths: [1, 2, 4, 8], channels: 1 },
  4: { depths: [8, 16], channels: 2 },
  6: { depths: [8, 16], channels: 4 },
};

interface Header {
  width: number;
  height: number;
  depth: number;
  colour: number;
}

function parseHeader(data: Buffer, maxSide: number): Header {
  if (data.length !== 13) throw new PngError('IHDR has the wrong length');
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const [depth = 0, colour = 0, compression, filter, interlace] = data.subarray(8);
  if (width === 0 || height === 0 || width > maxSide || height > maxSide) throw new PngError(`the image must be 1-${String(maxSide)} pixels per side`);
  const type = COLOUR_TYPES[colour];
  if (type === undefined || !type.depths.includes(depth)) throw new PngError('unknown colour type or bit depth');
  if (compression !== 0 || filter !== 0) throw new PngError('unknown compression or filter method');
  if (interlace !== 0) throw new PngError('interlaced PNGs are not accepted: save it without interlacing');
  return { width, height, depth, colour };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes the filters of the scanlines in place; returns the lines without their filter byte. */
function unfilter(raw: Buffer, height: number, stride: number, bytesPerPixel: number): Buffer {
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const at = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? (out[at + x - bytesPerPixel] ?? 0) : 0;
      const up = y > 0 ? (out[at - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? (out[at - stride + x - bytesPerPixel] ?? 0) : 0;
      const value = line[x] ?? 0;
      let predicted: number;
      switch (type) {
        case 0: predicted = 0; break;
        case 1: predicted = left; break;
        case 2: predicted = up; break;
        case 3: predicted = (left + up) >> 1; break;
        case 4: predicted = paeth(left, up, upLeft); break;
        default: throw new PngError('unknown line filter');
      }
      out[at + x] = (value + predicted) & 0xff;
    }
  }
  return out;
}

/**
 * Decodes `file` to RGBA, checking every chunk; throws PngError on anything
 * out of the standard. `maxSide` bounds both sides before anything is
 * inflated: the caller passes the largest image it accepts.
 */
export function decodePng(file: Buffer, maxSide: number): Image {
  if (file.length < SIGNATURE.length || !file.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new PngError('not a PNG');
  let offset = SIGNATURE.length;
  let header: Header | undefined;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const data: Buffer[] = [];
  let idatDone = false;
  let ended = false;
  for (let count = 0; !ended; count++) {
    if (count >= MAX_CHUNKS) throw new PngError('too many chunks');
    if (offset + 12 > file.length) throw new PngError('the file is cut short');
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError('a chunk has an invalid name');
    if (length > file.length - offset - 12) throw new PngError('the file is cut short');
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (crc32(file.subarray(offset + 4, offset + 8 + length)) !== file.readUInt32BE(offset + 8 + length)) throw new PngError(`chunk ${type}: bad checksum`);
    offset += 12 + length;

    if (count === 0 && type !== 'IHDR') throw new PngError('IHDR must come first');
    if (data.length > 0 && type !== 'IDAT') idatDone = true;
    switch (type) {
      case 'IHDR':
        if (header !== undefined) throw new PngError('IHDR appears twice');
        header = parseHeader(body, maxSide);
        break;
      case 'PLTE':
        if (palette !== undefined || data.length > 0 || transparency !== undefined) throw new PngError('PLTE out of place');
        if (header?.colour === 0 || header?.colour === 4) throw new PngError('PLTE is not allowed in a grey image');
        if (length === 0 || length % 3 !== 0 || length / 3 > 256) throw new PngError('PLTE has the wrong length');
        palette = body;
        break;
      case 'tRNS':
        if (transparency !== undefined || data.length > 0) throw new PngError('tRNS out of place');
        transparency = body;
        break;
      case 'IDAT':
        if (idatDone) throw new PngError('IDAT chunks must be consecutive');
        data.push(body);
        break;
      case 'IEND':
        if (length !== 0) throw new PngError('IEND must be empty');
        ended = true;
        break;
      default:
        if (!TOLERATED.has(type)) throw new PngError(`unknown chunk ${type}`);
    }
  }
  if (offset !== file.length) throw new PngError('data after the end of the image');
  if (header === undefined) throw new PngError('IHDR is missing');
  if (data.length === 0) throw new PngError('the image has no pixel data');
  const { width, height, depth, colour } = header;
  if (colour === 3 && palette === undefined) throw new PngError('a palette image without PLTE');
  if ((colour === 4 || colour === 6) && transparency !== undefined) throw new PngError('tRNS is not allowed with an alpha channel');

  const channels = COLOUR_TYPES[colour]?.channels ?? 0;
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const expected = (stride + 1) * height;
  let raw: Buffer;
  try {
    // Never more than the image needs: a deflate bomb stops at the limit.
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 });
  } catch {
    throw new PngError('the pixel data does not decompress to the size of the image');
  }
  if (raw.length !== expected) throw new PngError('the pixel data does not match the size of the image');
  const lines = unfilter(raw, height, stride, Math.max(1, bitsPerPixel >> 3));

  const rgba = new Uint8Array(width * height * 4);
  const max = (1 << depth) - 1;
  /** Sample `index` of line `y`, as read (not scaled). */
  const sample = (y: number, index: number): number => {
    const at = y * stride;
    if (depth === 8) return lines[at + index] ?? 0;
    if (depth === 16) return ((lines[at + index * 2] ?? 0) << 8) | (lines[at + index * 2 + 1] ?? 0);
    const bit = index * depth;
    return ((lines[at + (bit >> 3)] ?? 0) >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = (value: number): number => (depth === 16 ? value >> 8 : Math.round((value * 255) / max));
  const key = (index: number): number | undefined => (transparency === undefined || transparency.length < (index + 1) * 2 ? undefined : transparency.readUInt16BE(index * 2));
  if (colour === 0 && transparency !== undefined && transparency.length !== 2) throw new PngError('tRNS has the wrong length');
  if (colour === 2 && transparency !== undefined && transparency.length !== 6) throw new PngError('tRNS has the wrong length');
  if (colour === 3 && palette !== undefined && transparency !== undefined && transparency.length > palette.length / 3) throw new PngError('tRNS has the wrong length');

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const first = x * channels;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      switch (colour) {
        case 0: {
          const value = sample(y, first);
          r = g = b = to8(value);
          if (value === key(0)) a = 0;
          break;
        }
        case 2: {
          const [vr, vg, vb] = [sample(y, first), sample(y, first + 1), sample(y, first + 2)];
          [r, g, b] = [to8(vr), to8(vg), to8(vb)];
          if (vr === key(0) && vg === key(1) && vb === key(2)) a = 0;
          break;
        }
        case 3: {
          const index = sample(y, first);
          if (palette === undefined || index * 3 + 2 >= palette.length) throw new PngError('a pixel points outside the palette');
          [r, g, b] = [palette[index * 3] ?? 0, palette[index * 3 + 1] ?? 0, palette[index * 3 + 2] ?? 0];
          a = transparency?.[index] ?? 255;
          break;
        }
        case 4:
          r = g = b = to8(sample(y, first));
          a = to8(sample(y, first + 1));
          break;
        default:
          [r, g, b, a] = [to8(sample(y, first)), to8(sample(y, first + 1)), to8(sample(y, first + 2)), to8(sample(y, first + 3))];
      }
      // A fully transparent pixel carries no colour: hidden data cannot ride on it.
      if (a === 0) r = g = b = 0;
      rgba[out] = r;
      rgba[out + 1] = g;
      rgba[out + 2] = b;
      rgba[out + 3] = a;
    }
  }
  return { width, height, rgba };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * 8-bit RGBA, not interlaced, filter 0 on every line: IHDR, one IDAT, IEND
 * and nothing else. The same encoder as `apps/hud/characters/png.ts`, which
 * writes the originals; kept apart so the core does not import the chat.
 */
export function encodePng({ width, height, rgba }: Image): Buffer {
  if (rgba.length !== width * height * 4) throw new PngError('the pixel buffer does not match the size');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const lines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) lines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(lines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
