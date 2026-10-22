// WebAuthn written by hand (D-292, stage B): the CBOR reader and the checks of
// a registration and of an assertion, against passkeys generated here with
// node:crypto (test/support/passkey.ts). Every rule has a case that passes and
// one that is refused.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { CborError, CborMap, decodeCbor, decodeCborExact } from '../src/remote/cbor.ts';
import { verifyAssertion, verifyRegistration, WebAuthnError, type Expected, type StoredCredential } from '../src/remote/webauthn.ts';
import { encodeCbor, TestPasskey } from './support/passkey.ts';

const HOST = 'mac-prova.tail0000.ts.net';
const challenge = randomBytes(32);
const EXPECTED: Expected = { challenge, origin: `https://${HOST}`, rpId: HOST };
const ceremony = { challenge: challenge.toString('base64url') };
const USER = randomBytes(16);

function refusedWith(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof WebAuthnError, String(error));
    assert.equal(error.code, code);
    return true;
  };
}

function registered(passkey: TestPasskey): StoredCredential {
  const credential = verifyRegistration(passkey.create(ceremony, HOST, USER), EXPECTED);
  return { ...credential, userHandle: USER };
}

test('CBOR: integers, strings, bytes, arrays, maps and simple values, exactly', () => {
  const value = new Map<number | string, unknown>([
    [1, 2],
    [-1, 'testo'],
    ['b', Buffer.from([1, 2, 3])],
  ]);
  const bytes = encodeCbor(new Map<number | string, never>([...value] as [number | string, never][]));
  const read = decodeCborExact(bytes);
  assert.ok(read instanceof CborMap);
  assert.equal(read.get(1), 2);
  assert.equal(read.get(-1), 'testo');
  assert.deepEqual(Buffer.from(read.get('b') as Uint8Array), Buffer.from([1, 2, 3]));
  assert.deepEqual(decodeCborExact(encodeCbor([1, -500, 70000, 'x', true, false, null])), [1, -500, 70000, 'x', true, false, null]);
  assert.deepEqual(decodeCbor(Buffer.concat([encodeCbor(7), Buffer.from([0xff])])), { value: 7, end: 1 });
});

test('CBOR: refuses what WebAuthn does not use or what does not fit its bytes', () => {
  for (const bytes of [
    Buffer.from([0x5f]), // indefinite byte string
    Buffer.from([0xc0, 0x00]), // a tag
    Buffer.from([0xf9, 0x00, 0x00]), // a half float
    Buffer.from([0x45, 0x01]), // 5 bytes announced, 1 present
    Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02]), // a key repeated
    Buffer.from([0xa1, 0x41, 0x00, 0x01]), // a key that is bytes
    Buffer.from([0x62, 0xff, 0xfe]), // text that is not UTF-8
    Buffer.concat([Buffer.alloc(17, 0x81), Buffer.from([0x00])]), // nested too deep
    Buffer.from([0x01, 0x02]), // trailing bytes
  ]) {
    assert.throws(() => decodeCborExact(bytes), CborError, bytes.toString('hex'));
  }
});

test('registration: ES256 and RS256 with attestation none are accepted, with their key and counter', () => {
  for (const algorithm of [-7, -257] as const) {
    const passkey = new TestPasskey(algorithm);
    const credential = verifyRegistration(passkey.create(ceremony, HOST, USER), EXPECTED);
    assert.equal(credential.algorithm, algorithm);
    assert.deepEqual(credential.credentialId, passkey.id);
    assert.deepEqual(credential.publicKey, passkey.publicKey.export({ type: 'spki', format: 'der' }));
    assert.equal(credential.signCount, 0);
  }
});

test('registration: wrong type, challenge, origin, rpId, flags, format or key are refused', () => {
  const passkey = new TestPasskey();
  const cases: [string, Record<string, unknown>][] = [
    ['type', passkey.create({ ...ceremony, type: 'webauthn.get' }, HOST)],
    ['challenge', passkey.create({ challenge: randomBytes(32).toString('base64url') }, HOST)],
    ['origin', passkey.create({ ...ceremony, origin: 'https://evil.example' }, HOST)],
    ['origin', passkey.create({ ...ceremony, origin: `http://${HOST}` }, HOST)],
    ['cross-origin', passkey.create({ ...ceremony, crossOrigin: true }, HOST)],
    ['rp-id', passkey.create({ ...ceremony, rpId: 'altro.tail0000.ts.net' }, HOST)],
    ['user-presence', passkey.create({ ...ceremony, flags: 0x44 }, HOST)],
    ['user-verification', passkey.create({ ...ceremony, flags: 0x41 }, HOST)],
    // AT not set while the credential is there: the bytes do not fit the flags.
    ['authenticator-data', passkey.create({ ...ceremony, flags: 0x05 }, HOST)],
    ['attestation-format', passkey.create(ceremony, HOST, undefined, 'packed')],
  ];
  for (const [code, body] of cases) assert.throws(() => verifyRegistration(body, EXPECTED), refusedWith(code), code);
  // An id that is not the one in the authenticator data.
  const other = { ...passkey.create(ceremony, HOST), id: randomBytes(32).toString('base64url'), rawId: randomBytes(32).toString('base64url') };
  other.id = other.rawId;
  assert.throws(() => verifyRegistration(other, EXPECTED), refusedWith('credential-id'));
  // id and rawId differ.
  assert.throws(() => verifyRegistration({ ...passkey.create(ceremony, HOST), id: 'x' }, EXPECTED), refusedWith('credential-id'));
  // RSA under 2048 bits.
  assert.throws(() => verifyRegistration(new TestPasskey(-257, 1024).create(ceremony, HOST), EXPECTED), refusedWith('public-key'));
});

test('assertion: a good signature passes for ES256 and RS256, with the counter moving on', () => {
  for (const algorithm of [-7, -257] as const) {
    const passkey = new TestPasskey(algorithm);
    const stored = registered(passkey);
    assert.deepEqual(verifyAssertion(passkey.get(ceremony, HOST), EXPECTED, stored), { signCount: 0 });
    assert.deepEqual(verifyAssertion(passkey.get({ ...ceremony, signCount: 5 }, HOST), EXPECTED, stored), { signCount: 5 });
  }
});

test('assertion: wrong signature, rpId, origin, challenge, flags, user, credential or a counter going back are refused', () => {
  const passkey = new TestPasskey();
  const stored = registered(passkey);
  const cases: [string, Record<string, unknown>, StoredCredential?][] = [
    ['signature', passkey.get(ceremony, HOST, { badSignature: true })],
    ['rp-id', passkey.get({ ...ceremony, rpId: 'altro.tail0000.ts.net' }, HOST)],
    ['origin', passkey.get({ ...ceremony, origin: 'https://altro.tail0000.ts.net' }, HOST)],
    ['challenge', passkey.get({ challenge: randomBytes(32).toString('base64url') }, HOST)],
    ['type', passkey.get({ ...ceremony, type: 'webauthn.create' }, HOST)],
    ['user-presence', passkey.get({ ...ceremony, flags: 0x04 }, HOST)],
    ['user-verification', passkey.get({ ...ceremony, flags: 0x01 }, HOST)],
    ['user-handle', passkey.get(ceremony, HOST, { userHandle: randomBytes(16) })],
    // The counter: equal or lower than the one stored, once it is not zero.
    ['counter', passkey.get({ ...ceremony, signCount: 7 }, HOST), { ...stored, signCount: 7 }],
    ['counter', passkey.get({ ...ceremony, signCount: 3 }, HOST), { ...stored, signCount: 7 }],
    ['counter', passkey.get({ ...ceremony, signCount: 0 }, HOST), { ...stored, signCount: 7 }],
    // Another passkey's id, or the key of another passkey.
    ['credential-id', new TestPasskey().get(ceremony, HOST)],
    ['signature', passkey.get(ceremony, HOST), { ...stored, publicKey: new TestPasskey().publicKey.export({ type: 'spki', format: 'der' }) }],
  ];
  for (const [code, body, against] of cases) assert.throws(() => verifyAssertion(body, EXPECTED, against ?? stored), refusedWith(code), code);
  // A key of the other algorithm never verifies.
  assert.throws(() => verifyAssertion(passkey.get(ceremony, HOST), EXPECTED, { ...stored, algorithm: -257 }), refusedWith('signature'));
});

test('registration: another algorithm, another curve, a framed page or extensions after the key', () => {
  const passkey = new TestPasskey();
  // EdDSA (-8), and ES256 named on another curve (P-384 is crv 2): not what Arianna asks.
  const swapKey = (key: Map<number, unknown>) => {
    const body = passkey.create(ceremony, HOST);
    const response = body.response as { attestationObject: string };
    const attestation = decodeCborExact(Buffer.from(response.attestationObject, 'base64url')) as CborMap;
    const authData = Buffer.from(attestation.get('authData') as Uint8Array);
    const head = authData.subarray(0, 37 + 18 + passkey.id.length);
    const swapped = Buffer.concat([head, encodeCbor(key as never)]);
    response.attestationObject = encodeCbor(new Map<string, never>([['fmt', 'none' as never], ['attStmt', new Map() as never], ['authData', swapped as never]])).toString('base64url');
    return body;
  };
  const eddsa = new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, randomBytes(32)]]);
  assert.throws(() => verifyRegistration(swapKey(eddsa), EXPECTED), refusedWith('algorithm'));
  const cose = passkey.coseKey();
  cose.set(-1, 2);
  assert.throws(() => verifyRegistration(swapKey(cose), EXPECTED), refusedWith('public-key'));
  // topOrigin: the ceremony ran in a frame of another page.
  const framed = passkey.create(ceremony, HOST) as { response: { clientDataJSON: string } };
  const data = JSON.parse(Buffer.from(framed.response.clientDataJSON, 'base64url').toString('utf8')) as Record<string, unknown>;
  framed.response.clientDataJSON = Buffer.from(JSON.stringify({ ...data, topOrigin: 'https://evil.example' })).toString('base64url');
  assert.throws(() => verifyRegistration(framed, EXPECTED), refusedWith('cross-origin'));
});

test('assertion: extensions (flag ED) are read past, and their bytes must fit', () => {
  const passkey = new TestPasskey();
  const stored = registered(passkey);
  const sign = (extensions: Buffer) => {
    const clientDataJSON = TestPasskey.clientData('webauthn.get', ceremony, `https://${HOST}`);
    const authenticatorData = Buffer.concat([passkey.authenticatorData(HOST, 0x85, 0), extensions]);
    const body = passkey.get(ceremony, HOST) as { response: Record<string, string> };
    body.response.clientDataJSON = clientDataJSON.toString('base64url');
    body.response.authenticatorData = authenticatorData.toString('base64url');
    body.response.signature = passkey.signRaw(Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()])).toString('base64url');
    return body;
  };
  assert.deepEqual(verifyAssertion(sign(encodeCbor(new Map([['credProtect', 2]]))), EXPECTED, stored), { signCount: 0 });
  assert.throws(() => verifyAssertion(sign(Buffer.from([0xa1])), EXPECTED, stored), refusedWith('authenticator-data'));
});
