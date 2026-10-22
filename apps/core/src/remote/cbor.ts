/**
 * A minimal CBOR reader (RFC 8949) for WebAuthn (D-292): the attestation
 * object and the COSE public key of a passkey. Only what they use: unsigned
 * and negative integers, byte and text strings, arrays, maps, false, true
 * and null. Definite lengths only, at most 16 levels deep, every length
 * checked against the bytes left; anything else is refused, never guessed.
 */

export class CborError extends Error {
  override name = 'CborError';
}

export type CborValue = number | bigint | Uint8Array | string | boolean | null | CborValue[] | CborMap;

/** A CBOR map: keys as they came (COSE keys are integers), in order. */
export class CborMap {
  readonly entries: [CborValue, CborValue][] = [];

  get(key: number | string): CborValue | undefined {
    for (const [candidate, value] of this.entries) if (candidate === key) return value;
    return undefined;
  }
}

const MAX_DEPTH = 16;
const MAX_ITEMS = 1024;

/** Reads one item from `bytes` at `offset`; `end` is the offset after it. */
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
  return read(bytes, offset, 0);
}

/** One item that fills `bytes` exactly. */
export function decodeCborExact(bytes: Uint8Array): CborValue {
  const { value, end } = decodeCbor(bytes);
  if (end !== bytes.length) throw new CborError('trailing bytes after the CBOR item');
  return value;
}

function need(bytes: Uint8Array, offset: number, length: number): void {
  if (length < 0 || offset + length > bytes.length) throw new CborError('CBOR item longer than its bytes');
}

/** The argument of the head: the value of the additional information, or the bytes after it. */
function argument(bytes: Uint8Array, offset: number, info: number): { value: number | bigint; end: number } {
  if (info < 24) return { value: info, end: offset };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (info) {
    case 24:
      need(bytes, offset, 1);
      return { value: view.getUint8(offset), end: offset + 1 };
    case 25:
      need(bytes, offset, 2);
      return { value: view.getUint16(offset), end: offset + 2 };
    case 26:
      need(bytes, offset, 4);
      return { value: view.getUint32(offset), end: offset + 4 };
    case 27: {
      need(bytes, offset, 8);
      const big = view.getBigUint64(offset);
      return { value: big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big, end: offset + 8 };
    }
    default:
      // 28-30 are reserved, 31 is an indefinite length: neither is used by WebAuthn.
      throw new CborError('unsupported CBOR length');
  }
}

function length(value: number | bigint): number {
  if (typeof value === 'bigint') throw new CborError('CBOR length too large');
  return value;
}

function read(bytes: Uint8Array, offset: number, depth: number): { value: CborValue; end: number } {
  if (depth > MAX_DEPTH) throw new CborError('CBOR nested too deeply');
  need(bytes, offset, 1);
  const head = bytes[offset] ?? 0;
  const major = head >> 5;
  const info = head & 0x1f;
  const arg = argument(bytes, offset + 1, info);
  switch (major) {
    case 0:
      return { value: arg.value, end: arg.end };
    case 1:
      return { value: typeof arg.value === 'bigint' ? -1n - arg.value : -1 - arg.value, end: arg.end };
    case 2: {
      const size = length(arg.value);
      need(bytes, arg.end, size);
      return { value: bytes.slice(arg.end, arg.end + size), end: arg.end + size };
    }
    case 3: {
      const size = length(arg.value);
      need(bytes, arg.end, size);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(arg.end, arg.end + size));
      } catch {
        throw new CborError('CBOR text is not UTF-8');
      }
      return { value: text, end: arg.end + size };
    }
    case 4: {
      const count = length(arg.value);
      if (count > MAX_ITEMS) throw new CborError('CBOR array too long');
      const items: CborValue[] = [];
      let at = arg.end;
      for (let index = 0; index < count; index += 1) {
        const item = read(bytes, at, depth + 1);
        items.push(item.value);
        at = item.end;
      }
      return { value: items, end: at };
    }
    case 5: {
      const count = length(arg.value);
      if (count > MAX_ITEMS) throw new CborError('CBOR map too long');
      const map = new CborMap();
      let at = arg.end;
      for (let index = 0; index < count; index += 1) {
        const key = read(bytes, at, depth + 1);
        if (typeof key.value !== 'number' && typeof key.value !== 'string') throw new CborError('CBOR map key is not an integer or a text');
        if (map.get(key.value) !== undefined) throw new CborError('CBOR map key repeated');
        const item = read(bytes, key.end, depth + 1);
        map.entries.push([key.value, item.value]);
        at = item.end;
      }
      return { value: map, end: at };
    }
    case 7:
      if (info === 20) return { value: false, end: arg.end };
      if (info === 21) return { value: true, end: arg.end };
      if (info === 22) return { value: null, end: arg.end };
      throw new CborError('unsupported CBOR simple value or float');
    default:
      // 6: tags, not used by WebAuthn.
      throw new CborError('unsupported CBOR tag');
  }
}
