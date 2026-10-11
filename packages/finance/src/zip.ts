// A minimal zip reader for .xlsx files (D-183): the central directory, then
// only the entries asked for, stored (method 0) or deflated (method 8) with
// `node:zlib`. Encryption, zip64, multi-disk archives, odd paths and
// duplicate names are refused; the decompressed size has a hard cap that
// `inflateRawSync` enforces while inflating, so a zip bomb stops early.
import { inflateRawSync } from 'node:zlib';

import { FinanceImportError } from './table.ts';

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3), the checksum zip uses. */
export function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function bad(message: string): FinanceImportError {
  return new FinanceImportError('bad-zip', message);
}

/** Names a real .xlsx never has: absolute, parent segments, backslashes, control characters. */
function isOddPath(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name === '' || name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f]/.test(name) || /^[A-Za-z]:/.test(name) || name.split('/').some((part) => part === '..' || part === '.');
}

export class ZipReader {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #budget: number;

  constructor(bytes: Uint8Array, maxEntries: number, maxUnzippedBytes: number) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#budget = maxUnzippedBytes;
    this.entries = this.#readCentralDirectory(maxEntries);
  }

  #u16(offset: number): number {
    if (offset + 2 > this.#bytes.length) throw bad('Truncated archive');
    return this.#view.getUint16(offset, true);
  }

  #u32(offset: number): number {
    if (offset + 4 > this.#bytes.length) throw bad('Truncated archive');
    return this.#view.getUint32(offset, true);
  }

  #readCentralDirectory(maxEntries: number): Map<string, ZipEntry> {
    const bytes = this.#bytes;
    // The end record is 22 bytes plus a comment of at most 65535.
    let eocd = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
      if (this.#u32(at) === EOCD_SIGNATURE) {
        eocd = at;
        break;
      }
    }
    if (eocd === -1) throw bad('Not a zip archive');
    const disk = this.#u16(eocd + 4);
    const cdDisk = this.#u16(eocd + 6);
    const diskEntries = this.#u16(eocd + 8);
    const count = this.#u16(eocd + 10);
    const cdSize = this.#u32(eocd + 12);
    const cdOffset = this.#u32(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new FinanceImportError('zip64', 'Zip64 archives are not supported');
    }
    if (disk !== 0 || cdDisk !== 0 || diskEntries !== count) throw bad('Multi-disk archives are not supported');
    if (count > maxEntries) throw bad('Too many entries in the archive');
    if (cdOffset + cdSize > eocd) throw bad('Central directory out of bounds');

    const entries = new Map<string, ZipEntry>();
    let at = cdOffset;
    for (let n = 0; n < count; n += 1) {
      if (this.#u32(at) !== CENTRAL_SIGNATURE) throw bad('Corrupt central directory');
      const flags = this.#u16(at + 8);
      const method = this.#u16(at + 10);
      const crc = this.#u32(at + 16);
      const compressedSize = this.#u32(at + 20);
      const size = this.#u32(at + 24);
      const nameLength = this.#u16(at + 28);
      const extraLength = this.#u16(at + 30);
      const commentLength = this.#u16(at + 32);
      const localOffset = this.#u32(at + 42);
      if (at + 46 + nameLength > eocd) throw bad('Central directory out of bounds');
      const name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLength));
      if (flags & 0x1 || flags & 0x40) throw new FinanceImportError('encrypted', 'The file is protected by a password');
      if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
        throw new FinanceImportError('zip64', 'Zip64 archives are not supported');
      }
      if (isOddPath(name)) throw new FinanceImportError('bad-path', 'The archive has an entry with an invalid path');
      if (entries.has(name)) throw bad('The archive has two entries with the same name');
      entries.set(name, { name, method, flags, crc, compressedSize, size, localOffset });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The decompressed bytes of an entry; counts against the decompression budget. */
  read(name: string): Uint8Array {
    const entry = this.entries.get(name);
    if (entry === undefined) throw bad('Missing entry');
    const at = entry.localOffset;
    if (this.#u32(at) !== LOCAL_SIGNATURE) throw bad('Corrupt local header');
    if (this.#u16(at + 6) & 0x1) throw new FinanceImportError('encrypted', 'The file is protected by a password');
    const start = at + 30 + this.#u16(at + 26) + this.#u16(at + 28);
    const end = start + entry.compressedSize;
    if (end > this.#bytes.length) throw bad('Entry out of bounds');
    if (entry.size > this.#budget) {
      throw new FinanceImportError('unzipped-too-large', 'The file expands beyond the allowed size');
    }
    const raw = this.#bytes.subarray(start, end);
    let data: Uint8Array;
    if (entry.method === 0) {
      data = raw;
    } else if (entry.method === 8) {
      try {
        // Cap at the remaining budget, not at the declared size: the header may lie.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, this.#budget) });
      } catch (error) {
        if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new FinanceImportError('unzipped-too-large', 'The file expands beyond the allowed size');
        }
        throw bad('Corrupt compressed data');
      }
    } else {
      throw bad('Unsupported compression method');
    }
    if (data.length !== entry.size) throw bad('Entry size does not match');
    if (crc32(data) !== entry.crc) throw bad('Entry checksum does not match');
    this.#budget -= data.length;
    return data;
  }
}
