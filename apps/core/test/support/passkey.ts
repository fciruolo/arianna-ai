// A passkey made in the tests (D-292, stage B): real EC P-256 or RSA keys of
// node:crypto, with authenticatorData, clientDataJSON and the attestation
// object built by hand, as an iPhone would send them. Nothing leaves.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | string | Uint8Array | boolean | null | Cbor[] | Map<number | string, Cbor>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const bytes = Buffer.alloc(3);
    bytes[0] = (major << 5) | 25;
    bytes.writeUInt16BE(value, 1);
    return bytes;
  }
  const bytes = Buffer.alloc(5);
  bytes[0] = (major << 5) | 26;
  bytes.writeUInt32BE(value, 1);
  return bytes;
}

/** A small CBOR encoder, the counterpart of the reader under test. */
export function encodeCbor(value: Cbor): Buffer {
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)])]);
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const sha256 = (bytes: Uint8Array | string): Buffer => createHash('sha256').update(bytes).digest();

export interface Ceremony {
  challenge: string;
  origin?: string;
  rpId?: string;
  type?: string;
  flags?: number;
  signCount?: number;
  crossOrigin?: boolean;
}

export class TestPasskey {
  readonly id = randomBytes(32);
  readonly algorithm: -7 | -257;
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  signCount = 0;
  userHandle: Buffer | undefined;

  constructor(algorithm: -7 | -257 = -7, bits = 2048) {
    this.algorithm = algorithm;
    const pair = algorithm === -7 ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: bits });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  coseKey(): Map<number, Cbor> {
    const jwk = this.publicKey.export({ format: 'jwk' });
    if (this.algorithm === -7) {
      return new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? '', 'base64url')],
        [-3, Buffer.from(jwk.y ?? '', 'base64url')],
      ]);
    }
    return new Map<number, Cbor>([
      [1, 3],
      [3, -257],
      [-1, Buffer.from(jwk.n ?? '', 'base64url')],
      [-2, Buffer.from(jwk.e ?? '', 'base64url')],
    ]);
  }

  static clientData(type: string, ceremony: Ceremony, origin: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type: ceremony.type ?? type, challenge: ceremony.challenge, origin: ceremony.origin ?? origin, ...(ceremony.crossOrigin === undefined ? {} : { crossOrigin: ceremony.crossOrigin }) }),
    );
  }

  authenticatorData(rpId: string, flags: number, signCount: number, attested?: { id: Buffer; key: Buffer }): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount);
    const parts = [sha256(rpId), Buffer.from([flags]), counter];
    if (attested !== undefined) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(attested.id.length);
      parts.push(Buffer.alloc(16), length, attested.id, attested.key);
    }
    return Buffer.concat(parts);
  }

  /** What navigator.credentials.create gives back, as JSON for the core. Flags 0x45: UP, UV, AT. */
  create(ceremony: Ceremony, host: string, userHandle?: Buffer, fmt = 'none'): Record<string, unknown> {
    this.userHandle = userHandle;
    const clientDataJSON = TestPasskey.clientData('webauthn.create', ceremony, `https://${host}`);
    const authData = this.authenticatorData(ceremony.rpId ?? host, ceremony.flags ?? 0x45, ceremony.signCount ?? this.signCount, { id: this.id, key: encodeCbor(this.coseKey()) });
    const attestationObject = encodeCbor(new Map<string, Cbor>([['fmt', fmt], ['attStmt', new Map()], ['authData', authData]]));
    return { id: b64(this.id), rawId: b64(this.id), type: 'public-key', response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject) } };
  }

  /** A signature over raw bytes, as the authenticator makes it. */
  signRaw(bytes: Buffer): Buffer {
    return this.algorithm === -7 ? sign('sha256', bytes, { key: this.privateKey, dsaEncoding: 'der' }) : sign('sha256', bytes, this.privateKey);
  }

  /** What navigator.credentials.get gives back. Flags 0x05: UP, UV. The counter moves on unless given. */
  get(ceremony: Ceremony, host: string, options: { badSignature?: boolean; userHandle?: Buffer | null } = {}): Record<string, unknown> {
    if (ceremony.signCount === undefined && this.signCount > 0) this.signCount += 1;
    const clientDataJSON = TestPasskey.clientData('webauthn.get', ceremony, `https://${host}`);
    const authenticatorData = this.authenticatorData(ceremony.rpId ?? host, ceremony.flags ?? 0x05, ceremony.signCount ?? this.signCount);
    const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    let signature = this.algorithm === -7 ? sign('sha256', signed, { key: this.privateKey, dsaEncoding: 'der' }) : sign('sha256', signed, this.privateKey);
    if (options.badSignature === true) signature = Buffer.from(signature.map((byte, index) => (index === signature.length - 1 ? byte ^ 1 : byte)));
    const handle = options.userHandle === undefined ? this.userHandle : options.userHandle;
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: 'public-key',
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature), userHandle: handle === undefined || handle === null ? null : b64(handle) },
    };
  }
}
