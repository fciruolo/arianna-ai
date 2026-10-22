import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { encryptPush } from '../src/voice/push-crypto.ts';

const b64 = (value: string): Buffer => Buffer.from(value, 'base64url');

// RFC 8291, Appendix A.
const VECTOR = {
  plaintext: 'When I grow up, I want to be a watermelon',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** What the browser does: the receiving side of RFC 8291, one record. */
function decrypt(body: Buffer, receiverPrivate: Buffer, receiverPublic: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(receiverPrivate);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', receiver.computeSecret(senderPublic), auth, keyInfo, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const sealed = body.subarray(21 + idLength);
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  assert.equal(padded[padded.length - 1], 2);
  return padded.subarray(0, padded.length - 1);
}

test('encryptPush gives the body of the RFC 8291 test vector', () => {
  const body = encryptPush(Buffer.from(VECTOR.plaintext), VECTOR.receiverPublic, VECTOR.auth, {
    senderPrivateKey: b64(VECTOR.senderPrivate),
    salt: b64(VECTOR.salt),
  });
  assert.equal(body.toString('base64url'), VECTOR.body);
});

test('encryptPush: the subscribed browser reads it, with a fresh key and salt each time', () => {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const auth = randomBytes(16);
  const plaintext = Buffer.from(JSON.stringify({ kind: 'approval' }));
  const first = encryptPush(plaintext, receiver.getPublicKey('base64url'), auth.toString('base64url'));
  const second = encryptPush(plaintext, receiver.getPublicKey('base64url'), auth.toString('base64url'));
  assert.notDeepEqual(first, second);
  assert.equal(first.readUInt32BE(16), 4096);
  assert.deepEqual(decrypt(first, receiver.getPrivateKey(), receiver.getPublicKey(), auth), plaintext);
  assert.deepEqual(decrypt(second, receiver.getPrivateKey(), receiver.getPublicKey(), auth), plaintext);
});

test('encryptPush: another auth secret cannot read it', () => {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const body = encryptPush(Buffer.from('{"kind":"reply"}'), receiver.getPublicKey('base64url'), randomBytes(16).toString('base64url'));
  assert.throws(() => decrypt(body, receiver.getPrivateKey(), receiver.getPublicKey(), randomBytes(16)));
});

test('encryptPush refuses bad keys and a payload over one record', () => {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  assert.throws(() => encryptPush(Buffer.from('x'), receiver.getPublicKey('base64url', 'compressed'), auth), /p256dh/);
  assert.throws(() => encryptPush(Buffer.from('x'), receiver.getPublicKey('base64url'), randomBytes(8).toString('base64url')), /auth/);
  assert.throws(() => encryptPush(Buffer.alloc(4080), receiver.getPublicKey('base64url'), auth), /too large/);
  assert.doesNotThrow(() => encryptPush(Buffer.alloc(4079), receiver.getPublicKey('base64url'), auth));
});
