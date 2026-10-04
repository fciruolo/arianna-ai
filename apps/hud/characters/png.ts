import { crc32, deflateSync } from 'node:zlib';

/**
 * A minimal PNG encoder for the character sheets (D-060): 8-bit RGBA, no
 * interlace, filter 0 on every line. No dependency: node:zlib does the work.
 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** `rgba` holds width × height pixels, four bytes each, row by row. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error('encodePng: pixel buffer does not match the size');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const lines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (width * 4 + 1);
    lines[offset] = 0;
    lines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), offset + 1);
  }
  // Fixed level: the same art always gives the same bytes, which the test compares.
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(lines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
