/**
 * WebAuthn written by hand with node:crypto (D-292, stage B): the passkey a
 * paired phone creates, and the assertions it signs with Face ID. Pure
 * functions, tested with keys generated in the tests.
 *
 * Only what Arianna asks for: attestation `none` (no statement to check, so
 * no vendor roots), ES256 (-7) and RS256 (-257), user presence AND user
 * verification on every ceremony, the origin `https://<host of
 * [server.remote]>` and the rpId equal to that host. Every refusal is a
 * WebAuthnError with a short code, never the bytes that came in.
 */
import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';

import { CborError, CborMap, decodeCbor, decodeCborExact, type CborValue } from './cbor.ts';

export const ES256 = -7;
export const RS256 = -257;
export type CoseAlgorithm = typeof ES256 | typeof RS256;

export class WebAuthnError extends Error {
  override name = 'WebAuthnError';
  readonly code: string;
  constructor(code: string) {
    super(`webauthn: ${code}`);
    this.code = code;
  }
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Strict base64url: the alphabet only, no padding, and it reads back the same. */
export function fromBase64url(text: unknown, what: string, max = 16_384): Buffer {
  if (typeof text !== 'string' || text.length === 0 || text.length > max || !/^[A-Za-z0-9_-]+$/.test(text)) throw new WebAuthnError(`${what}-encoding`);
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw new WebAuthnError(`${what}-encoding`);
  return bytes;
}

function sha256(bytes: Uint8Array | string): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What every ceremony checks: the challenge it was given, the page it runs on, the rpId. */
export interface Expected {
  /** The challenge the core issued, raw bytes. */
  challenge: Uint8Array;
  /** `https://<host>`. */
  origin: string;
  /** The host of [server.remote]. */
  rpId: string;
}

/** clientDataJSON: its type, the challenge, the origin; never cross-origin, never framed. */
export function checkClientData(clientDataJSON: Uint8Array, type: 'webauthn.create' | 'webauthn.get', expected: Expected): void {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataJSON));
  } catch {
    throw new WebAuthnError('client-data');
  }
  if (typeof data !== 'object' || data === null) throw new WebAuthnError('client-data');
  const fields = data as Record<string, unknown>;
  if (fields.type !== type) throw new WebAuthnError('type');
  if (typeof fields.challenge !== 'string' || !same(Buffer.from(fields.challenge), Buffer.from(base64url(expected.challenge)))) throw new WebAuthnError('challenge');
  if (fields.origin !== expected.origin) throw new WebAuthnError('origin');
  if (fields.crossOrigin !== undefined && fields.crossOrigin !== false) throw new WebAuthnError('cross-origin');
  if (fields.topOrigin !== undefined) throw new WebAuthnError('cross-origin');
}

export interface AuthenticatorData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  /** With flag AT, at registration. */
  credential?: { aaguid: Buffer; id: Buffer; publicKey: CborMap };
}

/** authenticatorData (WebAuthn §6.1): rpIdHash, flags, counter, then the attested credential and the extensions as the flags say. */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new WebAuthnError('authenticator-data');
  const data = Buffer.from(bytes);
  const flags = data[32] ?? 0;
  const parsed: AuthenticatorData = { rpIdHash: data.subarray(0, 32), flags, signCount: data.readUInt32BE(33) };
  let at = 37;
  try {
    if ((flags & FLAG_AT) !== 0) {
      if (data.length < at + 18) throw new WebAuthnError('authenticator-data');
      const aaguid = data.subarray(at, at + 16);
      const idLength = data.readUInt16BE(at + 16);
      at += 18;
      if (idLength < 16 || idLength > 1023 || data.length < at + idLength) throw new WebAuthnError('credential-id');
      const id = data.subarray(at, at + idLength);
      at += idLength;
      const key = decodeCbor(data, at);
      if (!(key.value instanceof CborMap)) throw new WebAuthnError('public-key');
      parsed.credential = { aaguid, id, publicKey: key.value };
      at = key.end;
    }
    if ((flags & FLAG_ED) !== 0) {
      const extensions = decodeCbor(data, at);
      if (!(extensions.value instanceof CborMap)) throw new WebAuthnError('extensions');
      at = extensions.end;
    }
  } catch (error) {
    if (error instanceof CborError) throw new WebAuthnError('authenticator-data');
    throw error;
  }
  if (at !== data.length) throw new WebAuthnError('authenticator-data');
  return parsed;
}

/** The rpId hash, presence and verification of the user: the same for both ceremonies. */
function checkAuthenticator(data: AuthenticatorData, rpId: string): void {
  if (!same(data.rpIdHash, sha256(rpId))) throw new WebAuthnError('rp-id');
  if ((data.flags & FLAG_UP) === 0) throw new WebAuthnError('user-presence');
  if ((data.flags & FLAG_UV) === 0) throw new WebAuthnError('user-verification');
}

function bytesOf(value: CborValue | undefined, size: number | undefined, code: string): Buffer {
  if (!(value instanceof Uint8Array) || (size !== undefined && value.length !== size)) throw new WebAuthnError(code);
  return Buffer.from(value);
}

/** A COSE_Key (RFC 9053) of ES256 on P-256, or of RS256 with at least 2048 bits, as a KeyObject. */
export function coseKey(key: CborMap): { algorithm: CoseAlgorithm; key: KeyObject } {
  const kty = key.get(1);
  const alg = key.get(3);
  try {
    if (kty === 2 && alg === ES256) {
      if (key.get(-1) !== 1) throw new WebAuthnError('public-key');
      const x = bytesOf(key.get(-2), 32, 'public-key');
      const y = bytesOf(key.get(-3), 32, 'public-key');
      return { algorithm: ES256, key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: base64url(x), y: base64url(y) }, format: 'jwk' }) };
    }
    if (kty === 3 && alg === RS256) {
      const n = bytesOf(key.get(-1), undefined, 'public-key');
      const e = bytesOf(key.get(-2), undefined, 'public-key');
      const publicKey = createPublicKey({ key: { kty: 'RSA', n: base64url(n), e: base64url(e) }, format: 'jwk' });
      if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new WebAuthnError('public-key');
      return { algorithm: RS256, key: publicKey };
    }
  } catch (error) {
    if (error instanceof WebAuthnError) throw error;
    // A point off the curve, an empty modulus: node:crypto refuses it.
    throw new WebAuthnError('public-key');
  }
  throw new WebAuthnError('algorithm');
}

/** What the page sends after navigator.credentials.create, in base64url. */
export interface RegistrationResponse {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string };
}

export interface NewCredential {
  credentialId: Buffer;
  /** SubjectPublicKeyInfo, DER. */
  publicKey: Buffer;
  algorithm: CoseAlgorithm;
  signCount: number;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WebAuthnError(code);
  return value as Record<string, unknown>;
}

/** The fields of a PublicKeyCredential as JSON: id equal to rawId, type public-key. */
function credentialOf(body: unknown): { id: Buffer; response: Record<string, unknown> } {
  const credential = record(body, 'credential');
  if (credential.type !== 'public-key') throw new WebAuthnError('credential');
  const id = fromBase64url(credential.rawId, 'credential-id', 1400);
  if (credential.id !== credential.rawId) throw new WebAuthnError('credential-id');
  return { id, response: record(credential.response, 'credential') };
}

/**
 * A registration (navigator.credentials.create): attestation `none` only,
 * the challenge, origin and rpId expected, presence and verification of the
 * user, a credential id equal to the one in the authenticator data, and a
 * public key of ES256 or RS256.
 */
export function verifyRegistration(body: unknown, expected: Expected): NewCredential {
  const { id, response } = credentialOf(body);
  const clientDataJSON = fromBase64url(response.clientDataJSON, 'client-data');
  checkClientData(clientDataJSON, 'webauthn.create', expected);
  let attestation: CborValue;
  try {
    attestation = decodeCborExact(fromBase64url(response.attestationObject, 'attestation', 65_536));
  } catch (error) {
    if (error instanceof CborError) throw new WebAuthnError('attestation');
    throw error;
  }
  if (!(attestation instanceof CborMap)) throw new WebAuthnError('attestation');
  if (attestation.get('fmt') !== 'none') throw new WebAuthnError('attestation-format');
  const statement = attestation.get('attStmt');
  if (!(statement instanceof CborMap) || statement.entries.length !== 0) throw new WebAuthnError('attestation-format');
  const data = parseAuthenticatorData(bytesOf(attestation.get('authData'), undefined, 'authenticator-data'));
  checkAuthenticator(data, expected.rpId);
  if (data.credential === undefined) throw new WebAuthnError('attested-credential');
  if (!same(data.credential.id, id)) throw new WebAuthnError('credential-id');
  const { algorithm, key } = coseKey(data.credential.publicKey);
  return { credentialId: Buffer.from(id), publicKey: key.export({ type: 'spki', format: 'der' }), algorithm, signCount: data.signCount };
}

/** What the page sends after navigator.credentials.get, in base64url. */
export interface AssertionResponse {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

/** The credential id of an assertion, to find its stored key before checking it. */
export function assertionCredentialId(body: unknown): Buffer {
  return credentialOf(body).id;
}

export interface StoredCredential {
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  algorithm: CoseAlgorithm;
  signCount: number;
  /** The user.id given at registration: the userHandle of an assertion must be it. */
  userHandle: Uint8Array;
}

/**
 * An assertion (navigator.credentials.get) by a stored credential: the
 * challenge, origin and rpId expected, presence and verification of the
 * user, the signature over authenticatorData ‖ sha256(clientDataJSON), and a
 * counter that goes forward (both zero is allowed: passkeys synced by iCloud
 * keep it at zero). The new counter, to store.
 */
export function verifyAssertion(body: unknown, expected: Expected, stored: StoredCredential): { signCount: number } {
  const { id, response } = credentialOf(body);
  if (!same(id, stored.credentialId)) throw new WebAuthnError('credential-id');
  const clientDataJSON = fromBase64url(response.clientDataJSON, 'client-data');
  checkClientData(clientDataJSON, 'webauthn.get', expected);
  const authenticatorData = fromBase64url(response.authenticatorData, 'authenticator-data');
  const data = parseAuthenticatorData(authenticatorData);
  checkAuthenticator(data, expected.rpId);
  if (data.credential !== undefined) throw new WebAuthnError('authenticator-data');
  if (response.userHandle !== undefined && response.userHandle !== null) {
    if (!same(fromBase64url(response.userHandle, 'user-handle', 128), stored.userHandle)) throw new WebAuthnError('user-handle');
  }
  const signature = fromBase64url(response.signature, 'signature', 1024);
  const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(stored.publicKey), format: 'der', type: 'spki' });
  } catch {
    throw new WebAuthnError('public-key');
  }
  let valid: boolean;
  try {
    valid =
      stored.algorithm === ES256
        ? key.asymmetricKeyType === 'ec' && verifySignature('sha256', signed, { key, dsaEncoding: 'der' }, signature)
        : key.asymmetricKeyType === 'rsa' && verifySignature('sha256', signed, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new WebAuthnError('signature');
  if ((data.signCount !== 0 || stored.signCount !== 0) && data.signCount <= stored.signCount) throw new WebAuthnError('counter');
  return { signCount: data.signCount };
}
